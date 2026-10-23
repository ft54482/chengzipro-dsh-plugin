#!/usr/bin/env node
/**
 * 媒体能力单测（零依赖、零网络、零扣费）。
 *
 * 覆盖红线：
 * 1. 目录筛选：只有 type=image/video 且 protocol 正确的条目才进媒体目录；
 * 2. 图片请求体：`response_format=b64_json`、size 直通、b64 落盘；
 * 3. 视频官方协议：探测 → 提交 → 查询 → retrieve → 下载；
 * 4. 视频回退：官方端点 404 时走 /v1/h3/*，必须带 Idempotency-Key；
 * 5. 参数护栏：时长夹取、画幅白名单、首尾帧必须 2 图、参考图父级穿越拒绝；
 * 6. 失败语义：503 model_not_found / 余额不足 / 平台错误码 → 稳定 code。
 *
 * 运行：node tools/test-media.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  extractMediaModels,
  normalizeImageSize,
  videoBounds,
  VIDEO_CANVAS,
} from '../src/media-catalog.js'
import {
  generateImage,
  officialSubmit,
  officialQuery,
  officialUploadFile,
  probeOfficialProtocol,
  nativeSubmit,
  sniffImageMime,
  normalizeOfficialStatus,
  normalizeNativeStatus,
  newIdempotencyKey,
} from '../src/media-client.js'
import { OrangeMediaService } from '../src/media-service.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

/** 1x1 PNG。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 构造一个 fetch 替身：按 (method, path) 返回预设响应，并记录请求。 */
function mockFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname + (new URL(url).search || '')
    calls.push({ method, path, url, init })
    for (const route of routes) {
      if (route.method !== method) continue
      if (route.match instanceof RegExp ? !route.match.test(path) : route.match !== path) continue
      const body = typeof route.body === 'function' ? await route.body({ method, path, init }) : route.body
      const payload = body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body)
      return new Response(payload, {
        status: route.status ?? 200,
        headers: { 'content-type': route.contentType ?? (Buffer.isBuffer(body) ? 'video/mp4' : 'application/json'), ...route.headers },
      })
    }
    throw new Error(`unexpected request: ${method} ${path}`)
  }
  return { impl, calls }
}

function fakeService(overrides = {}) {
  return {
    catalog: () => [],
    mediaCatalog: () => [],
    keysBundle: async () => ({ keys: { vip: 'sk-test-vip', minimax: 'sk-test-minimax' }, defaultGroup: 'vip', baseUrl: 'https://example.test/v1' }),
    inferenceTarget: async () => ({ apiKey: 'sk-test-vip', apiBase: 'https://example.test/v1', group: 'vip' }),
    refreshBalance: async () => ({ balanceCny: 100 }),
    ...overrides,
  }
}

const CATALOG = [
  { id: 'gpt-image-2.5-flare', displayName: 'Flare', type: 'image', group: 'vip', quotaType: 1, inputPriceCny: 0.15, capabilities: { protocol: 'sync' } },
  { id: 'gpt-image-2.5-flare-4k', displayName: 'Flare 4K', type: 'image', group: 'vip', quotaType: 1, inputPriceCny: 0.38, capabilities: { protocol: 'sync' } },
  {
    id: 'MiniMax-H3 768P',
    displayName: 'MiniMax H3 768P',
    type: 'video',
    group: 'vip',
    quotaType: 1,
    inputPriceCny: 1.2,
    capabilities: {
      protocol: 'async-task',
      taskTypes: ['text_to_video', 'multi_reference_to_video', 'first_last_frame_to_video'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      durationSeconds: { min: 1, max: 15, step: 1 },
      maxRefImages: 9,
    },
  },
  { id: 'text-model', displayName: 'Text', type: 'text', group: 'vip', capabilities: { protocol: 'openai-chat' } },
  // 协议不对：图片模型却不是 sync → 不进媒体目录（防止把未知协议当已知协议用）
  { id: 'weird-image', type: 'image', group: 'vip', capabilities: { protocol: 'openai-chat' } },
]

console.log('\n[1] 目录筛选')
await test('只收 image/video 且协议匹配的模型', () => {
  const media = extractMediaModels(CATALOG)
  assert.deepEqual(media.map(model => model.id), ['gpt-image-2.5-flare', 'gpt-image-2.5-flare-4k', 'MiniMax-H3 768P'])
  assert.equal(media.filter(model => model.type === 'image').length, 2)
  const video = media.find(model => model.type === 'video')
  assert.equal(video.priceCny, 1.2)
  assert.deepEqual(video.capabilities.durationSeconds, { min: 1, max: 15, step: 1 })
})

await test('图片尺寸：预设键与直通都归一化，非法值丢弃', () => {
  assert.equal(normalizeImageSize('16:9'), '1344x768')
  assert.equal(normalizeImageSize('1024x1024'), '1024x1024')
  assert.equal(normalizeImageSize('9999x9999'), undefined)
  assert.equal(normalizeImageSize('abc'), undefined)
  assert.equal(normalizeImageSize(undefined), undefined)
})

await test('视频边界：目录优先，缺失时兜底 1-15s', () => {
  const bounds = videoBounds(extractMediaModels(CATALOG).find(model => model.type === 'video'))
  assert.equal(bounds.minDuration, 1)
  assert.equal(bounds.maxDuration, 15)
  assert.deepEqual(bounds.aspectRatios, ['16:9', '9:16', '1:1'])
  const fallback = videoBounds(undefined)
  assert.equal(fallback.maxDuration, 15)
  assert.ok(fallback.aspectRatios.includes('21:9'))
  assert.ok(VIDEO_CANVAS['16:9'])
})

console.log('\n[2] 图片链路')
await test('生图请求体带 response_format=b64_json，并能解码落盘', async () => {
  const { impl, calls } = mockFetch([{
    method: 'POST',
    match: '/v1/images/generations',
    body: { data: [{ b64_json: PNG_1X1.toString('base64') }] },
  }])
  const result = await generateImage({
    apiBase: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-2.5-flare',
    prompt: 'a red apple',
    size: '1344x768',
  }, { request: impl })
  assert.equal(calls.length, 1)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.model, 'gpt-image-2.5-flare')
  assert.equal(sent.n, 1)
  assert.equal(sent.response_format, 'b64_json')
  assert.equal(sent.size, '1344x768')
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(Buffer.from(result.images[0].base64, 'base64').toString('hex'), PNG_1X1.toString('hex'))
})

await test('生图 401 → AUTH；平台错误文案被保留', async () => {
  const { impl } = mockFetch([{
    method: 'POST',
    match: '/v1/images/generations',
    status: 401,
    body: { error: { code: 'invalid_token', message: 'Invalid token' } },
  }])
  await assert.rejects(
    () => generateImage({ apiBase: 'https://example.test/v1', apiKey: 'sk-bad', model: 'm', prompt: 'p' }, { request: impl }),
    error => error.code === 'AUTH' && /Invalid token/.test(error.message),
  )
})

console.log('\n[3] 视频官方协议')
await test('状态与错误码归一', () => {
  assert.equal(normalizeOfficialStatus('Queueing'), 'queued')
  assert.equal(normalizeOfficialStatus('Preparing'), 'queued')
  assert.equal(normalizeOfficialStatus('Processing'), 'processing')
  assert.equal(normalizeOfficialStatus('Success'), 'completed')
  assert.equal(normalizeOfficialStatus('Fail'), 'failed')
  assert.equal(normalizeNativeStatus('submitted'), 'queued')
  assert.equal(normalizeNativeStatus('processing'), 'processing')
  assert.equal(normalizeNativeStatus('completed'), 'completed')
})

await test('官方提交/查询/素材上传（官方 V2 契约形状）', async () => {
  const { impl, calls } = mockFetch([
    { method: 'POST', match: '/v2/video_generation', body: { task_id: 'task_abc123' } },
    {
      method: 'GET',
      match: /^\/v2\/query\/video_generation\/task_abc123$/,
      body: {
        task: {
          id: 'task_abc123',
          status: 'succeeded',
          content: { url: 'https://cdn.test/out.mp4' },
          duration: 6,
          resolution: '768P',
        },
      },
    },
    { method: 'POST', match: '/v1/files/upload', body: { file: { file_id: 123456789 }, base_resp: { status_code: 0 } } },
  ])
  const submit = await officialSubmit({
    apiBase: 'https://example.test/v1',
    apiKey: 'sk-test',
    body: { model: 'MiniMax-H3', content: [{ type: 'text', text: 'x' }], resolution: '768P', duration: 6 },
  }, { request: impl })
  assert.equal(submit.taskId, 'task_abc123')
  const query = await officialQuery({ apiBase: 'https://example.test/v1', apiKey: 'sk-test', taskId: 'task_abc123' }, { request: impl })
  assert.equal(query.status, 'completed')
  assert.equal(query.downloadUrl, 'https://cdn.test/out.mp4')
  assert.equal(query.duration, 6)
  // 官方端点挂在站点根，不是 /v1 之下。
  assert.ok(calls.some(call => call.path === '/v2/video_generation'))
  const fileId = await officialUploadFile({
    apiBase: 'https://example.test/v1',
    apiKey: 'sk-test',
    bytes: PNG_1X1,
    mime: 'image/png',
    filename: 'ref.png',
  }, { request: impl })
  assert.equal(fileId, '123456789')
})

await test('官方 OaiError 体 → PLATFORM + 中文码表；错误码 1008', async () => {
  const { impl, calls } = mockFetch([{
    method: 'POST',
    match: '/v2/video_generation',
    status: 402,
    body: { type: 'error', error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)', http_code: '402' }, request_id: 'a'.repeat(32) },
  }])
  await assert.rejects(
    () => officialSubmit({ apiBase: 'https://example.test/v1', apiKey: 'sk-test', body: {} }, { request: impl }),
    error => (error.code === 'QUOTA' || error.code === 'PLATFORM') && /1008|余额/.test(error.message),
  )
  assert.equal(calls.length, 1)
})

await test('官方端点 404 → probe 判定 native', async () => {
  const { impl } = mockFetch([{ method: 'POST', match: '/v2/video_generation', status: 404, body: { error: { message: 'Invalid URL' } } }])
  const protocol = await probeOfficialProtocol({ apiBase: 'https://example.test/v1', apiKey: 'sk-test' }, { request: impl })
  assert.equal(protocol, 'native')
})

console.log('\n[4] 视频回退 + 编排')
await test('原生提交必须带 Idempotency-Key 与幂等键体', async () => {
  const { impl, calls } = mockFetch([{ method: 'POST', match: '/v1/h3/videos/generations', body: { id: 'task_native_1', status: 'submitted' } }])
  const key = newIdempotencyKey()
  const { taskId } = await nativeSubmit({
    apiBase: 'https://example.test/v1',
    apiKey: 'sk-test',
    idempotencyKey: key,
    body: { model: 'MiniMax-H3 768P', task: 'text_to_video', prompt: 'x', duration_seconds: 5, width: 1344, height: 768, seed: 1 },
  }, { request: impl })
  assert.equal(taskId, 'task_native_1')
  assert.equal(calls[0].init.headers['Idempotency-Key'], key)
  assert.match(key, /^cz-video-\d+-[a-z0-9]+$/)
})

await test('官方未上线时自动回退 native，并把 mp4 落到工作区', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  const mp4 = Buffer.from('00000018667479706d703432', 'hex')
  const { impl, calls } = mockFetch([
    { method: 'POST', match: '/v2/video_generation', status: 404, contentType: 'text/html', body: '<html>spa</html>' },
    { method: 'POST', match: '/v1/h3/videos/generations', body: { id: 'task_native_2', status: 'submitted', progress: '10%' } },
    { method: 'GET', match: /^\/v1\/h3\/videos\/generations\/task_native_2$/, body: { id: 'task_native_2', status: 'completed', video_url: '/v1/files/out.mp4' } },
    { method: 'GET', match: '/v1/files/out.mp4', body: mp4, contentType: 'video/mp4' },
  ])
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), { request: impl })
  const result = await media.generateVideo({ prompt: 'a cat walking', cwd })
  assert.equal(result.protocol, 'native-h3')
  assert.equal(result.taskId, 'task_native_2')
  assert.equal(result.taskType, 'text_to_video')
  assert.equal(result.durationSeconds, 5)
  const saved = await readFile(join(cwd, result.file.path))
  assert.equal(saved.toString('hex'), mp4.toString('hex'))
  const submitCall = calls.find(call => call.path === '/v1/h3/videos/generations')
  const sent = JSON.parse(submitCall.init.body)
  assert.equal(sent.model, 'MiniMax-H3 768P')
  assert.equal(sent.width, 1344)
  assert.equal(sent.height, 768)
  assert.ok(Number.isInteger(sent.seed))
})

await test('官方已上线时走 /v2 并下载 content.url', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  const mp4 = Buffer.from('00000018667479706d703432', 'hex')
  const { impl, calls } = mockFetch([
    { method: 'POST', match: '/v2/video_generation', body: { task_id: 'task_official_1' } },
    { method: 'GET', match: /^\/v2\/query\/video_generation\/task_official_1$/, body: { task: { id: 'task_official_1', status: 'succeeded', content: { url: 'https://cdn.test/out.mp4' }, duration: 5 } } },
    { method: 'GET', match: '/out.mp4', body: mp4, contentType: 'video/mp4' },
  ])
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), { request: impl })
  const result = await media.generateVideo({ prompt: 'a dog', cwd })
  assert.equal(result.protocol, 'official-v2')
  assert.equal(result.taskId, 'task_official_1')
  const submitCall = calls.find(call => call.path === '/v2/video_generation' && /"content"/.test(String(call.init.body)))
  const sent = JSON.parse(submitCall.init.body)
  assert.equal(sent.model, 'MiniMax-H3')
  assert.equal(sent.resolution, '768P')
  assert.equal(sent.duration, 5)
  assert.equal(sent.content[0].type, 'text')
  assert.equal(sent.content[0].text, 'a dog')
  assert.equal(sent.ratio, '16:9')
})

await test('官方首尾帧：素材上传后以 mm_file:// + role 引用', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  await mkdir(join(cwd, 'refs'), { recursive: true })
  await writeFile(join(cwd, 'refs', 'a.png'), PNG_1X1)
  await writeFile(join(cwd, 'refs', 'b.png'), PNG_1X1)
  const mp4 = Buffer.from('00000018667479706d703432', 'hex')
  let uploadSeq = 0
  const { impl, calls } = mockFetch([
    { method: 'POST', match: '/v2/video_generation', body: { task_id: 'task_flf' } },
    {
      method: 'POST',
      match: '/v1/files/upload',
      body: () => ({ file: { file_id: 900000 + (++uploadSeq) }, base_resp: { status_code: 0 } }),
    },
    { method: 'GET', match: /^\/v2\/query\/video_generation\/task_flf$/, body: { task: { status: 'succeeded', content: { url: 'https://cdn.test/flf.mp4' } } } },
    { method: 'GET', match: '/flf.mp4', body: mp4, contentType: 'video/mp4' },
  ])
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), { request: impl })
  const references = await Promise.all([
    media.readReferenceImage(cwd, 'refs/a.png'),
    media.readReferenceImage(cwd, 'refs/b.png'),
  ])
  const result = await media.generateVideo({
    prompt: 'grow from A to B',
    taskType: 'first_last_frame_to_video',
    referenceImages: references,
    cwd,
  })
  assert.equal(result.taskType, 'first_last_frame_to_video')
  const submitCall = calls.find(call => call.path === '/v2/video_generation' && /"content"/.test(String(call.init.body)))
  const sent = JSON.parse(submitCall.init.body)
  const images = sent.content.filter(item => item.type === 'image_url')
  assert.equal(images.length, 2)
  assert.match(images[0].image_url.url, /^mm_file:\/\/90000[12]$/)
  assert.equal(images[0].role, 'first_frame')
  assert.equal(images[1].role, 'last_frame')
})

console.log('\n[5] 参数护栏')
await test('时长夹取到目录范围；画幅白名单外的值回落 16:9', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  const { impl, calls } = mockFetch([
    { method: 'POST', match: '/v2/video_generation', status: 404, contentType: 'text/html', body: '<html></html>' },
    { method: 'POST', match: '/v1/h3/videos/generations', body: { id: 'task_limit_1' } },
    { method: 'GET', match: /^\/v1\/h3\/videos\/generations\/task_limit_1$/, body: { status: 'completed', video_url: '/v1/files/x.mp4' } },
    { method: 'GET', match: '/v1/files/x.mp4', body: Buffer.from('00', 'hex'), contentType: 'video/mp4' },
  ])
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), { request: impl })
  const result = await media.generateVideo({ prompt: 'x', durationSeconds: 999, aspectRatio: '7:3', cwd })
  assert.equal(result.durationSeconds, 15)
  assert.equal(result.aspectRatio, '16:9')
  const sent = JSON.parse(calls.find(call => call.path === '/v1/h3/videos/generations').init.body)
  assert.equal(sent.duration_seconds, 15)
  assert.equal(sent.width, 1344)
})

await test('首尾帧必须恰好 2 张参考图', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), { request: async () => { throw new Error('should not reach network') } })
  await assert.rejects(
    () => media.generateVideo({ prompt: 'x', taskType: 'first_last_frame_to_video', referenceImages: [], cwd }),
    error => error.code === 'INVALID_REQUEST' && /恰好 2 张/.test(error.message),
  )
})

await test('text_to_video 传参考图被拒', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), { request: async () => { throw new Error('should not reach network') } })
  const reference = { path: 'a.png', bytes: PNG_1X1, mime: 'image/png' }
  await assert.rejects(
    () => media.generateVideo({ prompt: 'x', taskType: 'text_to_video', referenceImages: [reference], cwd }),
    error => error.code === 'INVALID_REQUEST' && /不接受参考图/.test(error.message),
  )
})

await test('参考图路径父级穿越/越界被拒', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orange-media-'))
  await mkdir(join(cwd, 'imgs'), { recursive: true })
  await writeFile(join(cwd, 'imgs', 'a.png'), PNG_1X1)
  const media = new OrangeMediaService(fakeService(), {})
  await assert.rejects(() => media.readReferenceImage(cwd, '../escape.png'), error => error.code === 'INVALID_REQUEST')
  await assert.rejects(() => media.readReferenceImage(cwd, '/etc/passwd'), error => error.code === 'INVALID_REQUEST')
  const ok = await media.readReferenceImage(cwd, 'imgs/a.png')
  assert.equal(ok.mime, 'image/png')
})

await test('余额不足在生成前拦截', async () => {
  const media = new OrangeMediaService(fakeService({ refreshBalance: async () => ({ balanceCny: 0.5 }) }), {})
  await assert.rejects(() => media.assertBalance(1.2), error => error.code === 'QUOTA' && /余额/.test(error.message))
})

await test('未知模型给出可用清单', () => {
  const media = new OrangeMediaService(fakeService({ mediaCatalog: () => extractMediaModels(CATALOG) }), {})
  assert.throws(() => media.resolveImageModel('nope'), /未知的图片模型/)
  assert.throws(() => media.resolveVideoModel('nope'), /未知的视频模型/)
  assert.equal(media.resolveImageModel(undefined).id, 'gpt-image-2.5-flare')
  const video = media.resolveVideoModel(undefined)
  assert.ok(video.id === 'MiniMax-H3 768P')
})

await test('图片魔数嗅探', () => {
  assert.equal(sniffImageMime(PNG_1X1), 'image/png')
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('RIFF0000WEBP', 'latin1')), 'image/webp')
})

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error)
  process.exit(1)
}
