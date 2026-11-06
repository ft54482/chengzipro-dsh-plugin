# 图片输入（视觉）支持（v0.4.1）

> 问题：在 DSH 里给「橙子PRO / DeepSeek V4.1 flash」上传图片，提示「模型不支持图片」。
> 结论：**不是中转站/模型的锅，是插件把模型声明成了纯文本**。已修复。

## 1. 根因（有代码级证据）

DSH 在上传附件时校验模型能力：

```js
// dsh-api-session-controller/lib/index.js:940
if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
  throw new RemoteError("session/attachment-invalid",
    `Model "${current.model}" does not support image input.`,
    { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" })
```

而插件在 `adapter.listModels()` / `resolveModel()` 里对**所有**模型硬编码了：

```js
inputModalities: ['text']
```

于是 DSH 在"上传"这一步就拒绝了，请求根本没到中转站。

实测中转站其实**支持图片输入**（2026-10-23，真实 vip 组密钥）：

| 模型 | 实测结果 |
|---|---|
| `deepseek-v4.1-flash` | 输入 64×64 纯橙图 → 回答「橙色」，prompt_tokens 223（图确实被吃进去了） |
| `DeepSeek-V4.1-flash-2.5` | 回答「橙色」 |
| `deepseek-flash` | 推理里描述了图片内容 |
| `gpt-5.5 / 5.6-sol / 5.6-luna` | 回答「白色 / 黄色 / 粉色」 |
| `gemini-3.7-flash` | 回答「Salmon / Coral / 粉」 |
| `deepseek-v4-pro-oc` | ❌ 中转把图替换成 `[Unsupported…]` 占位，模型看不到 |
| `glm-5.3` | ❌ 上游 400 code 1210：`type 参数非法，取值范围 ['text']` |

## 2. 修复内容

1. **能力声明**（这是"报错"的直接修复）
   `listModels()` / `resolveModel()` 改为按模型返回 `['text','image']` 或 `['text']`。
   判定顺序：目录字段 → 状态文件显式覆盖 → 内置实测证据表。

2. **请求序列化**（让图真的到模型手里）
   把 DSH 的 `ImageBlock` 解析成 OpenAI 兼容的 `image_url` data URI：

   ```
   { type: 'image', attachment: {...} }
     → { type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }
   ```

   - 通过 `ctx.get('attachments').readImageRequest(ref, target, signal)` 读取；
   - 请求版本按 **4096² 像素 / 1MB** 预算做长边等比缩放（与 DSH 内建 pi-ai 同档）；
   - 同一张图按 `attachmentId` 去重，多轮历史里的图也会被带上；
   - 读图失败/非视觉模型 → 退化成中文占位文本，**不炸整轮**。

3. **错误翻译**（防止再看到上游黑话）
   若模型被声明可收图但上游明确拒绝（如智谱 1210），转成：
   「当前模型「X」不接受图片输入。请换用支持视觉的模型（deepseek-v4.1-flash /
   DeepSeek-V4.1-flash-2.5 / gpt-5.x / gemini-3.x），或在设置里把该模型加入 vision.exclude。」

4. **状态可视化**
   `GET /orange-pro/api/status` 新增 `vision.models`：当前目录里允许上传图片的模型 id。

## 3. 配置覆盖

平台目录**没有**下发 modalities，所以有两级兜底。需要为某个模型强制开/关：

```json
POST /orange-pro/api/config
{ "vision": { "include": ["some-new-model"], "exclude": ["deepseek-v4-pro-oc"] } }
```

`include` 优先级最高（强制允许），`exclude` 次之（强制禁止）。改完无需重新登录，
下一次会话/同步即生效（模型目录本身没变，会话选择器会随 `llm/adapters-updated` 刷新）。

## 4. 验证

```bash
node test/test-vision.test.mjs    # 15 项：能力判定 / 序列化 / 端到端 SSE / 错误翻译
node test/test-adapter.test.mjs   # 既有 30+ 项回归
```

真实链路的独立验证脚本（不在单测里，避免扣费）核心断言：
用真实 `deepseek-v4.1-flash` + 纯橙 64×64 PNG 走 `OrangeProAdapter.stream`，
模型返回「橙色」→ 说明 DSH 侧声明、图片序列化、平台视觉链路三段全通。

## 5. 边界

- 仅"模型自身支持视觉"时才有意义；纯文本模型仍会拦在上传前（这是 DSH 的正确行为）。
- 平台对图片大小无明确文档，请求版本按 1MB 预算压缩；若上游报体积/尺寸错误，
  先换更小的图或调 `REQUEST_IMAGE_MAX_PIXELS/BYTES`。
- `deepseek-v4-pro-oc` 目前**明确不支持**（中转替换占位），已加入默认排除表。
- 图片按 token 计费（各模型不同），与本插件无关；平台返回的 usage 里可见 prompt_tokens 上涨。
