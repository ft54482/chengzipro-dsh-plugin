# Changelog

## 0.4.3 — 2026-10-25

### Fixed
- **上下文压缩报错** `this.adapters.get(...)?.adapter.imageRequestPricing is not a function`：
  本插件是鸭子类型适配器（不继承 DSH 内部 `LlmAdapter`），漏实现了基类带默认值的可选成员
  `imageRequestPricing` / `imageRequestTarget`。DSH 在 token 计量（压缩计价）时无保护地调用它们，
  导致「上下文压缩」直接 TypeError。现已补齐两个成员（与基类默认语义一致），并加回归单测。

## 0.4.2 — 2026-10-23

### Changed
- 项目更名为「橙子PRO中转站-DSH插件」；仓库 slug 为 `chengzipro-dsh-plugin`
  （GitHub 仓库名只允许 ASCII，中文名仅用于展示/README/插件管理标题）。
- 介绍补充中转站信息：官网 https://pro.nat6.net；国产模型满精度/满上下文/满缓存；
  DeepSeek V4.1 最新版、2.5 折、缓存率 95%+、官 Key 非号池。
- 插件管理显示名与描述（locale）、package 描述同步更新。

## 0.4.1 — 2026-10-23

### Fixed
- **图片输入（视觉）**：此前把所有模型声明为纯文本，DSH 在附件上传阶段就报
  「模型不支持图片」。现在按模型声明 `inputModalities: ['text','image']`，并把
  `ImageBlock` 转成 OpenAI 兼容的 `image_url` data URI；上游拒绝图片时给出中文可读错误。
- 修复 `deepseek-v4-pro-oc` 被误判为视觉模型（中转会替换成占位文本）。

### Added
- `src/vision.js`：能力判定（目录字段 > `vision.include/exclude` > 实测证据表）、图片引用收集、请求图像尺寸预算。
- `GET /orange-pro/api/status` 增加 `vision.models`。
- `test/vision.test.mjs`（15 项）。
- `docs/VISION.md`。

## 0.4.0 — 2026-10-22

### Added
- Agent 工具 `orange_pro_image`（image2.5 家族，按张计费，确认卡 + 余额预检）。
- Agent 工具 `orange_pro_video`（MiniMax H3）：MiniMax 官方 V2 协议优先
  （`/v2/video_generation`、`content[]`、`mm_file://`、`content.url`），
  探测不到时回退 new-api 原生 `/v1/h3/*`（Idempotency-Key + materials）。
- 媒体模型单独存 `state.json.mediaModels`，不混进模型选择器。
- `GET /orange-pro/api/media` 诊断端点。
- `test/media.test.mjs`（20 项）、`test/plugin-smoke.test.mjs`（12 项）。
- `docs/MEDIA.md`。

## 0.3.x

- 平台协议迁移到橙子PRO 自定义 BFF（JWT + 分组密钥 + SSE）。
- 上下文规格表、倍率/折扣展示、答复规范兼容层、答复语言解析。
- 凭据键两段式护栏与单测；reasoning_content 回传兼容。

## 0.1.0

- 首个可用版本：账号登录、模型目录、OpenAI 兼容 provider route、设置页。
