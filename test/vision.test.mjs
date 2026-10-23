#!/usr/bin/env node
/**
 * 图片输入（视觉）单测：零网络、零扣费。
 *
 * 覆盖：
 * 1. 视觉能力判定：证据表 / 目录字段 / 配置覆盖；
 * 2. 适配器在 listModels / resolveModel 里正确声明 `inputModalities`（DSH 上传附件时的唯一依据）；
 * 3. ImageBlock → OpenAI `image_url`（data URI）的序列化，含去重、占位、非视觉模型退化；
 * 4. 端到端：adapter.stream 发出的请求体里真的带上了图片，且能解析回文本；
 * 5. 上游明确拒绝图片时给中文可读错误。
 *
 * 运行：node tools/test-vision.mjs
 */
import assert from 'node:assert/strict'

import {
  supportsImageInput,
  modalitiesFor,
  collectImageRefs,
  requestImageTarget,
} from '../src/vision.js'
import {
  OrangeProAdapter,
  buildChatBody,
  userContent,
  looksLikeVisionRejection,
} from '../src/adapter.js'

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

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const ATTACHMENT = { attachmentId: 'att-1', mediaType: 'image/png', width: 1, height: 1, bytes: 68 }
const IMAGE_BLOCK = { type: 'image', attachment: ATTACHMENT }

console.log('\n[1] 视觉能力判定')
await test('证据表：deepseek-v4 / gpt-5 / gemini-3 收图，glm/kimi/qwen/claude/minimax 不收', () => {
  for (const id of ['deepseek-v4.1-flash', 'DeepSeek-V4.1-flash-2.5', 'deepseek-flash', 'gpt-5.5', 'gpt-5.6-luna', 'gemini-3.7-flash']) {
    assert.equal(supportsImageInput(id, undefined), true, id)
  }
  for (const id of ['glm-5.3', 'kimi-k2.6', 'qwen3.7-max', 'claude-sonnet-5', 'minimax-m2.7', 'unknown-model', 'deepseek-v4-pro-oc']) {
    assert.equal(supportsImageInput(id, undefined), false, id)
  }
})
await test('目录字段优先于证据表', () => {
  assert.equal(supportsImageInput('kimi-k3', { capabilities: { inputModalities: ['text', 'image'] } }), true)
  assert.equal(supportsImageInput('deepseek-v4.1-flash', { capabilities: { inputModalities: ['text'] } }), false)
  assert.equal(supportsImageInput('custom-1', { capabilities: { vision: true } }), true)
})
await test('配置 include/exclude 优先级最高', () => {
  assert.equal(supportsImageInput('glm-5.3', undefined, { include: ['glm-5.3'] }), true)
  assert.equal(supportsImageInput('deepseek-v4.1-flash', undefined, { exclude: ['deepseek-v4.1-flash'] }), false)
})
await test('modalitiesFor 返回受支持的模态数组', () => {
  assert.deepEqual(modalitiesFor('deepseek-v4.1-flash'), ['text', 'image'])
  assert.deepEqual(modalitiesFor('glm-5.3'), ['text'])
})

console.log('\n[2] 图片引用与请求目标')
await test('collectImageRefs 只收用户消息里的图片，去重并跳过 offloaded', () => {
  const refs = collectImageRefs([
    { role: 'system', content: [{ type: 'text', text: 's' }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }, IMAGE_BLOCK, IMAGE_BLOCK] },
    { role: 'user', content: [{ type: 'image', attachment: { ...ATTACHMENT, attachmentId: 'att-2' }, offloaded: true }] },
  ])
  assert.equal(refs.length, 1)
  assert.equal(refs[0].attachmentId, 'att-1')
})
await test('requestImageTarget 长边按像素预算等比缩放', () => {
  const target = requestImageTarget({ width: 4096, height: 2048 })
  assert.equal(target.width, 2896)
  assert.equal(target.height, 1448)
  assert.equal(target.maxBytes, 1_048_576)
  const small = requestImageTarget({ width: 800, height: 600 })
  assert.deepEqual({ width: small.width, height: small.height }, { width: 800, height: 600 })
})

console.log('\n[3] 消息序列化')
await test('纯文本仍返回字符串（保持旧行为）', () => {
  const content = userContent([{ type: 'text', text: '你好' }], new Map())
  assert.equal(content, '你好')
})
await test('图片 → image_url data URI，文本与图片按序排列', () => {
  const images = new Map([['att-1', { dataUrl: DATA_URL }]])
  const content = userContent([{ type: 'text', text: '这是什么颜色？' }, IMAGE_BLOCK], images)
  assert.ok(Array.isArray(content))
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url')
  assert.equal(content[1].image_url.url, DATA_URL)
})
await test('图片读取失败 → 中文占位，不抛错', () => {
  const images = new Map([['att-1', { error: '附件服务未加载' }]])
  const content = userContent([{ type: 'text', text: '看图' }, IMAGE_BLOCK], images)
  assert.equal(typeof content, 'string')
  assert.match(content, /图片无法读取：附件服务未加载/)
})
await test('没有解析结果（非视觉模型）→ 占位文本', () => {
  const content = userContent([{ type: 'text', text: '看图' }, IMAGE_BLOCK], new Map())
  assert.equal(typeof content, 'string')
  assert.match(content, /图片未随本次请求发送/)
})
await test('buildChatBody 把图片送进 messages（视觉模型）', () => {
  const body = buildChatBody({
    provider: 'orange-pro',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, IMAGE_BLOCK] }],
  }, { reasoning: undefined }, { images: new Map([['att-1', { dataUrl: DATA_URL }]]) })
  const user = body.messages.find(message => message.role === 'user')
  assert.ok(Array.isArray(user.content))
  assert.equal(user.content[1].image_url.url, DATA_URL)
})

console.log('\n[4] 适配器声明与端到端')
function fakeService({ vision = true } = {}) {
  const entry = { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', group: 'deepseek', inputModalities: vision ? ['text', 'image'] : ['text'] }
  const captured = { bodies: [] }
  const platform = {
    async chat({ body }) {
      captured.bodies.push(body)
      const sse = [
        'data: {"choices":[{"delta":{"content":"看见了"}}]}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  }
  return {
    captured,
    service: {
      catalog: () => [entry],
      findModel: id => (id === entry.id ? entry : undefined),
      visionOverrides: () => ({}),
      compatPrompt: () => '',
      inferenceTarget: async () => ({ apiKey: 'sk-test', apiBase: 'https://example.test/v1', group: 'deepseek' }),
      platform: () => platform,
      imageDataUrl: async () => DATA_URL,
      ctx: { logger: { warn: () => {} } },
    },
  }
}

await test('listModels / resolveModel 对视觉模型声明 text+image', async () => {
  const { service } = fakeService()
  const adapter = new OrangeProAdapter(service)
  const models = await adapter.listModels('orange-pro')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  const info = await adapter.resolveModel('orange-pro', 'deepseek-v4.1-flash')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

await test('非视觉模型声明 text，且图片被替换为占位', async () => {
  const { service, captured } = fakeService({ vision: false })
  const adapter = new OrangeProAdapter(service)
  const models = await adapter.listModels('orange-pro')
  assert.deepEqual(models[0].inputModalities, ['text'])
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'orange-pro',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, IMAGE_BLOCK] }],
  })) chunks.push(chunk)
  const user = captured.bodies[0].messages.find(message => message.role === 'user')
  assert.equal(typeof user.content, 'string')
  assert.match(user.content, /图片未随本次请求发送/)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta'))
})

await test('视觉模型：请求体带 image_url，且流式文本正常', async () => {
  const { service, captured } = fakeService()
  const adapter = new OrangeProAdapter(service)
  let text = ''
  for await (const chunk of adapter.stream({
    provider: 'orange-pro',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么颜色？' }, IMAGE_BLOCK] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  assert.equal(text, '看见了')
  const body = captured.bodies[0]
  const user = body.messages.find(message => message.role === 'user')
  assert.ok(Array.isArray(user.content))
  assert.equal(user.content[1].image_url.url, DATA_URL)
})

console.log('\n[5] 上游拒绝图片时的错误翻译')
await test('智谱 400 code 1210 被识别为"模型不接受图片"', () => {
  assert.equal(looksLikeVisionRejection("***.***.type 参数非法，取值范围 ['text']"), true)
  assert.equal(looksLikeVisionRejection('This model does not support image input'), true)
  assert.equal(looksLikeVisionRejection('rate limit exceeded'), false)
})

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error)
  process.exit(1)
}
