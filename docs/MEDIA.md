# 媒体能力：平台目录图像模型 + MiniMax H3 生视频

> 模型 id 与单价**全部来自平台目录**（当前图像为 `gpt-image-2.6-*` 家族）；平台换版时插件无需改代码。
> 代码里不再保留下架模型的硬编码兜底，目录为空时工具会提示先同步。

## 0. 版本无关（为什么 2.6 → 2.7 不用发版）

平台换媒体模型版本时，**插件不需要更新**，链路是：

1. 同步（启动 2s 后 / 每 10 分钟 / 手动）从 `/api/v1/models` 取 `type=image|video` 的条目；
2. 工具的模型解析在**调用时**读实时目录：省略 `model` → 用目录默认款（非 4K 基础款）；
   显式传的旧 id 已下架 → 自动回退到目录默认，并在返回 `note` 里说明；
3. 工具返回值带 `available_models`（当前目录里的 id 列表），模型据此换用新 id；
4. 工具描述不写死具体版本 id，避免"描述里还是 2.5"的过期问题。

**只有这些变化才需要改插件**：协议变了（image 从 `sync` 改成异步任务等）、目录字段语义变了、
新增媒体类型（音频等）。

> 验证：本地用 `gpt-image-2.7-*` 假目录跑 `extractMediaModels + pickDefaultMediaModel`，
> 默认模型自动取 `gpt-image-2.7-flare`；`tools/test-media.mjs` 20 项、`test-plugin-smoke.mjs` 12 项全绿。


> 状态：已实现，单测 32 项全绿（`node test/test-media.test.mjs` + `node test/test-plugin-smoke.test.mjs`）。
> 平台侧实测证据见 `.agent/memory/facts.md` 的 `F-MEDIA-*` 条目。
> 本文只写"怎么用 / 为什么这么实现 / 边界在哪"，不重复平台文档。

## 1. 两个 Agent 工具

| 工具 | 模型 | 计费 | 产物 |
|---|---|---|---|
| `orange_pro_image` | 平台目录当前图像模型（如 `gpt-image-2.6-flare` / `-sunburst` / 各自 `-4k`） | 按张，随目录（实测 ¥0.15 / ¥0.38 / ¥0.45） | `orange-images/image-<时间戳>.png` |
| `orange_pro_video` | `MiniMax-H3 768P` / `MiniMax-H3 2K` | 按次（¥1.2 / ¥1.9，与时长无关） | `orange-videos/video-<时间戳>.mp4` |

两者都注册在 DSH 全局 `tools` 服务上，**不写进模型选择器**（媒体模型不能当对话模型用）。
生成完把返回的 `file_path` 交给 `present`，用户就能直接打开/预览。

### 参数（模型可见的 JSON Schema）

`orange_pro_image`：
- `prompt`（必填，≤4000 字）
- `model`（可选，目录里的 image 模型 id）
- `size`（可选，`宽x高` 或预设键 `16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / hd / 2k`）
- `confirm`（无交互确认卡时必填 true）

`orange_pro_video`：
- `prompt`（必填）
- `model`（可选，`MiniMax-H3 768P` / `MiniMax-H3 2K`）
- `duration_seconds`（1-15；官方协议通道夹到 4-15）
- `aspect_ratio`（目录 `aspectRatios`，默认 `16:9`）
- `reference_images`（0-9 张，会话工作区相对路径；1 张=图生视频，2 张可走首尾帧）
- `task`（`text_to_video` / `multi_reference_to_video` / `first_last_frame_to_video`，可省略自动推断）
- `confirm`

## 2. 计费安全（这是硬要求，不是可选项）

1. **不确认不扣费**：有 `ctx.userQuestions` 时弹确认卡（写明单价）；没有该服务时，模型必须显式传
   `confirm: true`，否则返回 `needs_confirmation` 让模型去问用户。
2. **生成前查余额**：`/api/v1/me` 拿 CNY，余额 < 单价直接拒（`QUOTA`），不发请求。
3. **图片不做超时重试**：平台 v1.3 明确"客户端断开≠取消，仍按张计费且结果不可取回"。
   因此同步生图只等一次，等待上限设在平台网关 600s 之上（工具 `timeoutMs` 30 分钟）。
4. **视频按次计费**：失败/超时平台自动全额退款；插件不做"超时→重提"，超时只报错并给出 `task_id`。

## 3. 视频协议：官方 V2 优先，原生 H3 回退

平台同时存在两套视频协议（实测 2026-10-22，`pro.nat6.net`）：

| 协议 | 端点 | 形状 |
|---|---|---|
| MiniMax 官方 V2（平台侧官方协议兼容层） | `POST /v2/video_generation`、`GET /v2/query/video_generation/{id}`、`POST /v1/files/upload` | `{model:"MiniMax-H3", content:[{type:"text",text}], resolution:"768P"\|"2K", duration:4-15, ratio}` → `{task_id}`；查询 `{task:{status,content:{url},error}}`，状态 `queued/running/succeeded/failed/cancelled`；素材 `mm_file://{file_id}` |
| new-api 原生 | `POST /v1/h3/videos/generations`（必须 `Idempotency-Key`）、`GET /v1/h3/videos/generations/{id}`、`GET .../{id}/content` | `{model, task, prompt, duration_seconds, width, height, materials:[material_id], seed}` → `{id, status:"submitted"}` |

插件行为：
- 启动/首次生成时用空体 `POST /v2/video_generation` 探测一次（结果缓存 10 分钟）；
- 探测到官方语义 → 走官方 V2（`content[]`、`ratio`、`mm_file://`、`content.url` 下载）；
- 返回 404/405 或 HTML → 回退原生 `/h3/*`（自动带幂等键与随机 seed，`video_url` 相对路径补 origin 后带同一把密钥下载）；
- 两条链路的失败都归一到同一套 `MediaError.code`，工具结果里会标 `protocol: official-v2 | native-h3`。

**当前实测**：`pro.nat6.net` 的 `/v2/*` **已上线**（空体会返回 `unsupported model; supported: MiniMax-H3 (2013)`），
因此默认走官方协议；`/v1/h3/*` 仍然可用（已用真实 key 提交并下载过 6.98MB MP4 验证）。

## 4. 密钥：不需要新建，`vip` 组已覆盖

- 平台按**分组**发密钥（`GET /api/v1/account/api-key` 返回 `keys:{组:sk-…}`），不是按模型建 key。
- 目录里 4 个 image 模型与 2 个 H3 视频模型的 `group` 都是 **`vip`**；插件登录时已经缓存了全部组
  （本机实测 12 组：`vip / deepseek / glm / kimi / qwen / minimax / kimi-k3 / qwen high / codex / gemini官转 / claude-enterprise / apiKey`）。
- 因此**现有插件不需要、也不会在平台里新建图像 / H3 的 key**：直接复用 `vip` 组密钥。
  实测：用 `vip` key 调 `/v1/models` 能看到 4 个 image + 2 个 H3；`/v1/images/generations`
  返回的是内容/参数类 400（说明模型已授权），不是 403 no access。
- 注意：`minimax` 组调 H3 会 `503 model_not_found`（该组没有 H3 渠道）。插件按目录 `group` 取钥，
  只有目录把模型挪到别的组才需要重新登录重签全部密钥。

## 5. 每次调用发生什么

```
orange_pro_image
  ├─ 目录解析模型（未知 id → 报错并列出可用模型）
  ├─ 确认卡 / confirm
  ├─ 余额预检
  ├─ POST {apiBase}/images/generations  {model, prompt, n:1, response_format:"b64_json", size?}
  └─ 解码 b64 → 写 <cwd>/orange-images/*.png → 返回路径

orange_pro_video
  ├─ 目录解析模型 + 任务类型/时长/画幅按目录 capabilities 夹取
  ├─ 参考图读盘（拒绝 .. 穿越与越界，≤20MB，魔数嗅探 JPEG/PNG/WebP）
  ├─ 确认卡 / confirm
  ├─ 余额预检
  ├─ 探测协议（缓存 10min）
  ├─ 官方：上传素材 → POST /v2/video_generation → 轮询 /v2/query/... → 下载 content.url
  ├─ 原生：POST /h3/materials → POST /h3/videos/generations(Idempotency-Key) → 轮询 → /content
  └─ 写 <cwd>/orange-videos/*.mp4 → 返回路径
```

轮询节奏 5s，总上限 28 分钟（平台排队可达数十分钟，文档明确"勿以短超时判死"）。

## 6. 诊断

| 方式 | 用途 |
|---|---|
| `GET /orange-pro/api/media` | 目录里的 image/video 模型、每组密钥是否覆盖、当前视频协议（official-v2/native-h3）；不扣费 |
| `POST /orange-pro/api/selftest {"mode":"media","kind":"video"}` | 单模型链路自检（密钥/分组/协议/余额），**不发起生成** |
| `node test/test-media.test.mjs` | 20 项：目录筛选/请求体/官方协议/回退/参数护栏/错误语义 |
| `node test/test-plugin-smoke.test.mjs` | 12 项：工具定义契约/未确认不扣费/确认卡/工作区约束 |

## 7. 已知边界

- 图片只做**文生图**（`/images/generations`）；图生图 `POST /v1/images/edits`（multipart）尚未接工具。
- 视频参考素材只支持图片（JPEG/PNG/WebP）；参考视频/音频未开放输入。
- 官方协议通道 duration 4-15（官方契约），原生通道 1-15；工具会按所选协议夹取并如实回显。
- 官方 `/v2` 只登记"经兼容层创建"的任务；用原生 `/h3/*` 创建的任务在 `/v2` 查询不到（反之亦然）。
- 生成产物默认落在会话工作区，不自动上传/转码；`present` 由模型按结果提示调用。
