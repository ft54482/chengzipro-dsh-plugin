#!/usr/bin/env node
/**
 * 插件装配冒烟测试：不依赖 DSH 运行时，验证 `registerMediaTools` 产出的
 * ToolDefinition 满足 ToolRuntime.register() 的硬校验，并且两条付费路径
 * 在"未确认"时绝不触发生成。
 *
 * 校验点（对应 dsh-tools 0.2.1 的 register()）：
 * - output 必须是对象，且 output.render 是函数；
 * - output.schema 只能用受支持的 JSON Schema 子集关键词；
 * - timeoutMs 若给出必须是正有限数；
 * - name 不能是保留的 run_code。
 *
 * 运行：node tools/test-plugin-smoke.mjs
 */
import assert from 'node:assert/strict'

const { registerMediaTools } = await import('../src/media-tools.js')

const SUPPORTED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', '$comment', 'default', 'examples',
])

function assertSchemaSubset(schema, path = 'schema') {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path} must be an object`)
  for (const key of Object.keys(schema)) {
    assert.ok(SUPPORTED_KEYS.has(key), `${path}.${key} is not in the supported JSON Schema subset`)
  }
  if (schema.properties) {
    for (const [name, child] of Object.entries(schema.properties)) assertSchemaSubset(child, `${path}.properties.${name}`)
  }
  if (schema.items) assertSchemaSubset(schema.items, `${path}.items`)
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((child, index) => assertSchemaSubset(child, `${path}.oneOf[${index}]`))
}

function fakeCtx({ withQuestions = false, answer = 'cancel' } = {}) {
  const tools = []
  const ctx = {
    tools: { register: definition => { tools.push(definition); return () => {} } },
    get: name => {
      if (name === 'userQuestions' && withQuestions) {
        return {
          ask: async () => ({
            answers: [{ id: 'confirm', selected: [answer === 'confirm' ? '确认生成' : '取消，不生成'] }],
          }),
        }
      }
      return undefined
    },
  }
  return { ctx, tools }
}

function fakeDeps(overrides = {}) {
  const calls = { image: 0, video: 0, balance: 0 }
  const imageResult = {
    model: 'gpt-image-2.5-flare',
    modelName: 'Flare',
    files: [{ path: 'orange-images/image-1.png', bytes: 10 }],
    size: '1024x1024',
    priceLabel: '¥0.15/张',
    elapsedMs: 1234,
    revisedPrompt: null,
  }
  const videoResult = {
    model: 'MiniMax-H3 768P',
    modelName: 'MiniMax H3 768P',
    protocol: 'official-v2',
    taskId: 'task_x',
    taskType: 'text_to_video',
    aspectRatio: '16:9',
    canvas: '1344x768',
    durationSeconds: 5,
    file: { path: 'orange-videos/video-1.mp4', bytes: 99 },
    priceLabel: '¥1.20/次',
    elapsedMs: 5000,
  }
  const media = {
    imageModels: () => [
      { id: 'gpt-image-2.5-flare', name: 'Flare', priceCny: 0.15 },
      { id: 'gpt-image-2.5-flare-4k', name: 'Flare 4K', priceCny: 0.38 },
    ],
    videoModels: () => [
      { id: 'MiniMax-H3 768P', name: 'MiniMax H3 768P', priceCny: 1.2, capabilities: { aspectRatios: ['16:9', '9:16', '1:1'], durationSeconds: { min: 1, max: 15, step: 1 }, maxRefImages: 9 } },
    ],
    fallbackImageModels: () => [{ id: 'gpt-image-2.5-flare', name: 'Flare', priceCny: 0.15 }],
    fallbackVideoModels: () => [{ id: 'MiniMax-H3 768P', name: 'H3', priceCny: 1.2 }],
    resolveImageModel: requested => ({ id: requested ?? 'gpt-image-2.5-flare', name: 'Flare', priceCny: 0.15 }),
    resolveVideoModel: requested => ({ id: requested ?? 'MiniMax-H3 768P', name: 'H3', priceCny: 1.2 }),
    assertBalance: async () => { calls.balance += 1 },
    generateImage: async () => { calls.image += 1; return imageResult },
    generateVideo: async () => { calls.video += 1; return videoResult },
    readReferenceImage: async () => ({ path: 'a.png', bytes: Buffer.from(''), mime: 'image/png' }),
    ...overrides,
  }
  return { media, service: {}, calls }
}

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

console.log('\n[1] 工具定义符合 register() 契约')
const { ctx, tools } = fakeCtx()
const { media, calls } = fakeDeps()
registerMediaTools(ctx, { media, service: {} })
await test('注册两个工具：orange_pro_image / orange_pro_video', () => {
  assert.deepEqual(tools.map(tool => tool.name), ['orange_pro_image', 'orange_pro_video'])
})
await test('每个工具都有 description / parameters / output.render / execute / timeoutMs', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 50, `${tool.name} description too short`)
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['prompt'])
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)
    assert.notEqual(tool.name, 'run_code')
    assertSchemaSubset(tool.output.schema, `${tool.name}.output.schema`)
  }
})
await test('render 返回 ContentBlock[]（text）', () => {
  for (const tool of tools) {
    const blocks = tool.output.render({}, { status: 'generated', files: ['a.png'], file_path: 'a.mp4' })
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

console.log('\n[2] 无交互确认时绝不自动扣费')
const { ctx: c2, tools: t2 } = fakeCtx()
const deps2 = fakeDeps()
registerMediaTools(c2, deps2)
const exec = { agent: { session: { header: { cwd: 'C:/tmp/ws' } } }, signal: new AbortController().signal }
await test('生图：未传 confirm → needs_confirmation，不调用生成/余额', async () => {
  const result = await t2[0].execute({ prompt: 'a red apple' }, exec)
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(deps2.calls.image, 0)
  assert.equal(deps2.calls.balance, 0)
})
await test('生视频：未传 confirm → needs_confirmation，不调用生成/余额', async () => {
  const result = await t2[1].execute({ prompt: 'a cat walking' }, exec)
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(deps2.calls.video, 0)
  assert.equal(deps2.calls.balance, 0)
})
await test('生图：confirm=true → 先查余额再生成，返回文件路径', async () => {
  const result = await t2[0].execute({ prompt: 'a red apple', confirm: true }, exec)
  assert.equal(result.status, 'generated')
  assert.deepEqual(result.files, ['orange-images/image-1.png'])
  assert.equal(deps2.calls.balance, 1)
  assert.equal(deps2.calls.image, 1)
})
await test('生视频：confirm=true → 先查余额再生成，返回 file_path', async () => {
  const result = await t2[1].execute({ prompt: 'a cat walking', confirm: true }, exec)
  assert.equal(result.status, 'generated')
  assert.equal(result.file_path, 'orange-videos/video-1.mp4')
  assert.equal(result.protocol, 'official-v2')
  assert.equal(deps2.calls.balance, 2)
  assert.equal(deps2.calls.video, 1)
})

console.log('\n[3] 有交互确认卡时以用户选择为准')
const { ctx: c3, tools: t3 } = fakeCtx({ withQuestions: true, answer: 'cancel' })
const deps3 = fakeDeps()
registerMediaTools(c3, deps3)
await test('用户点"取消" → cancelled，零调用', async () => {
  const result = await t3[0].execute({ prompt: 'x', confirm: true }, exec)
  assert.equal(result.status, 'cancelled')
  assert.equal(deps3.calls.image, 0)
  assert.equal(deps3.calls.balance, 0)
})
const { ctx: c4, tools: t4 } = fakeCtx({ withQuestions: true, answer: 'confirm' })
const deps4 = fakeDeps()
registerMediaTools(c4, deps4)
await test('用户点"确认生成" → 生成成功', async () => {
  const result = await t4[1].execute({ prompt: 'x' }, exec)
  assert.equal(result.status, 'generated')
  assert.equal(deps4.calls.video, 1)
})

console.log('\n[4] 参数护栏')
await test('空 prompt 被拒', async () => {
  await assert.rejects(() => t2[0].execute({ prompt: '   ', confirm: true }, exec), /prompt is required/)
})
await test('参考图数量超上限被拒', async () => {
  await assert.rejects(
    () => t2[1].execute({ prompt: 'x', reference_images: Array.from({ length: 10 }, (_, index) => `r${index}.png`), confirm: true }, exec),
    /At most 9 reference images/,
  )
})
await test('没有会话工作区时给出明确错误（不落到插件进程 cwd）', async () => {
  await assert.rejects(
    () => t2[0].execute({ prompt: 'x', confirm: true }, { signal: new AbortController().signal }),
    /session workspace/,
  )
})

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error)
  process.exit(1)
}
