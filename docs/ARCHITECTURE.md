# 架构说明

本插件把橙子PRO（New API 系）的「账号 + 计费 + 模型」体系接进 DeepSeek Harness（DSH），
所有对外能力都通过 DSH 公开扩展点提供，不修改 DSH 本体。

## 1. 双轨鉴权

| 用途 | Base | 鉴权 |
|---|---|---|
| 账号 / 目录 / 余额 / 用量（BFF） | `https://pro.nat6.net/video-api` + `/api/v1/*` | 登录会话 JWT |
| 模型推理（文本 / 图片） | `https://pro.nat6.net/v1` | 分组密钥 `sk-…` |
| 视频任务 | `https://pro.nat6.net/v2/*`（官方）或 `/v1/h3/*`（原生） | 分组密钥 |

两套鉴权完全独立：推理密钥失效（401/403）不影响用会话 JWT 重拉密钥。

## 2. 数据流

```
设置页 ──fetch /orange-pro/api/*──▶ api.js ──▶ service.js ──▶ platform.js ──▶ pro.nat6.net
                                                   │
DSH 模型选择器 ──llm.listModels──▶ adapter（读 state.json 缓存）

一次对话：
Agent Loop ──llm.stream──▶ adapter.stream
   ├─ service.inferenceTarget(model)   ← 目录 group → keys[group]（凭据记录）
   ├─ [有图片] service.imageDataUrl()   ← ctx.attachments.readImageRequest()
   ├─ POST {apiBase}/chat/completions（Bearer sk-…）→ SSE
   └─ StreamChunk（text/reasoning/tool-call/usage/finish）

一次生图/生视频：
Agent Tool ──▶ media-service
   ├─ 余额预检（/api/v1/me）
   ├─ 图片：POST /v1/images/generations（b64_json）
   ├─ 视频：官方 /v2/video_generation → 轮询 → content.url
   │        或回退 /v1/h3/videos/generations（Idempotency-Key）→ 轮询 → /content
   └─ 落盘到会话工作区 orange-images/ · orange-videos/
```

**目录是公开的**：插件启动即拉目录，所以未登录时模型选择器里也能看到分组；
真正调用时才需要账号（未登录 → `MISSING_CREDENTIAL`，会话过期 → `AUTH`）。

## 3. 模块

| 文件 | 职责 |
|---|---|
| `index.js` | Host 入口：注册 LLM route、媒体工具（等 `tools` 服务）、设置页 API（等 `webServer`）、自动同步 |
| `client.js` | Client 半：`settings.section` 页面（登录/配置/模型/余额） |
| `src/platform.js` | 平台 HTTP 客户端；错误统一成 `PlatformError`；SSE 解析 |
| `src/service.js` | 登录、refresh 轮换、分组密钥、目录同步、余额、取钥自愈、图片附件解析、状态聚合 |
| `src/adapter.js` | `LlmAdapter` 实现：listModels/resolveModel/stream；消息转换；图片序列化；401/403/503 自愈 |
| `src/state.js` | `$DSH_HOME/orange-pro/state.json`：配置、账号快照、文本目录、媒体目录、视觉覆盖（无凭据） |
| `src/model-spec.js` | 目录没有 contextWindow 时的规格推断（verified / estimate 标注） |
| `src/model-compat.js` | 模型答复规范兼容层（按语言/模型追加 system） |
| `src/vision.js` | 图片输入能力判定、图片引用收集、请求图像目标尺寸 |
| `src/media-catalog.js` | 从目录筛 image/video 模型、尺寸/画幅/时长边界 |
| `src/media-client.js` | 图片 sync + MiniMax 官方 V2 + 原生 H3 的纯 HTTP 客户端 |
| `src/media-service.js` | 媒体编排：确认、余额、上传、提交、轮询、落盘 |
| `src/media-tools.js` | 两个 Agent 工具定义（不 import `@deepseek-ai/dsh-tools`，手工构造 ToolDefinition） |
| `src/api.js` | 同源 JSON API、diagnose、selftest、media/vision 状态 |
| `src/llm-errors.js` | 平台错误 → DSH 失败码（双写 code/failure） |
| `src/credential-key.js` | 凭据键护栏（`<scope>/<id>` 两段） |
| `src/debug.js` | `$DSH_HOME/orange-pro/plugin.log`（只写状态/错误消息） |

## 4. 安全模型

- 手机号/密码只用于登录请求，不落盘。
- JWT、refreshToken、全部 `sk-` 密钥只存 `ctx.credentials` 的 grant 记录：
  `orange-pro/session` 与 `orange-pro/keys`。
- `state.json` 只有账号快照、余额、模型缓存（无凭据）。
- 设置页 API 只接受 loopback 同源请求（Origin + Sec-Fetch-Site），body ≤ 64 KiB，
  响应 `no-store` 且不含 token/key。
- 媒体工具读写限定在会话工作区；参考图路径拒绝 `..` 穿越；下载有字节上限。

## 5. 关键契约与坑

- **凭据记录键是硬约束**：`<scope>/<id>` 两段、每段 `[a-z][a-z0-9-]*`。多一段会让凭据插件
  启动时解析失败，整个应用无法启动。
- **第三方 bundle 解析不到 `@deepseek-ai/dsh-*`**：所以适配器不继承内部类，按运行时校验
  （`providerInfo/listModels/resolveModel/stream`；ToolDefinition 只需 `output.render` + schema 子集）。
- **`inputModalities` 决定 DSH 是否允许上传图片**：不含 `image` 时上传阶段直接 422，请求不会发出。
- **linked 包不热更新**：改 Host 代码必须移除 + 重新安装（或重启 DSH）。
- **思考型模型给小 `max_tokens` 会返回空 content**：小于 1024 时不传该字段。
- **DeepSeek 思考模式要回传 `reasoning_content`**：历史 assistant 的 reasoning 块拼回该条消息，
  否则多轮/工具调用报 `INVALID_REQUEST`。
- **生图 sync 协议下客户端断开仍计费且结果不可取回**：所以不做超时重试。
- **视频平台语义**：失败自动退款；不要自设短超时判死；官方/原生两套协议状态值不同，已归一。

## 6. 扩展点

- 新增模型能力：`src/vision.js` 证据表、`src/model-spec.js` 上下文规格、`src/media-catalog.js` 媒体模型。
- 新增媒体形态：在 `media-client.js` 加纯函数 → `media-service.js` 编排 → `media-tools.js` 暴露工具。
- 诊断：`src/api.js` 的 `diagnose()` / `selftest()` 可直接在设置页调用。
