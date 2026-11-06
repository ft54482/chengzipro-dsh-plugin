# 橙子PRO中转站-DSH插件
[![test](https://github.com/ft54482/chengzipro-dsh-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/ft54482/chengzipro-dsh-plugin/actions/workflows/test.yml)

## 橙子PRO 中转站

官网：**https://pro.nat6.net**

- **模型多、国产齐全**：DeepSeek / Qwen / GLM / Kimi / MiniMax / Claude / GPT / Gemini 等文本模型，以及图像模型（当前 2.6 家族）、MiniMax H3 生视频。
- **满精度、满上下文、满缓存**：正品折扣渠道，不是缩水/裁剪版本。
- **DeepSeek V4.1 已更新到最新版**：超低折扣（当前全平台 **2.5 折**），缓存命中率可达 **95%+**。
- **官 Key 非号池**：官方密钥直连，不是共享号池，质量与稳定性有保障。

本仓库是把橙子PRO 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的开源插件：
登录一次即可在 DSH 里使用中转站的全部模型、余额、图片与视频能力。

> 适用平台：橙子PRO（New API 体系，默认 `https://pro.nat6.net`）。
> 其它 New API 站点可通过设置页改 Base URL 复用（部分平台专有接口会自动降级）。

**设计原则**：不改 DSH 客户端、不 fork、不逆向 —— 只装一个可安装、可禁用、可升级的插件。

## 功能

| 能力 | 说明 |
|---|---|
| 🔐 账号登录 | 手机验证码 / 账号密码双通道；登录态、会话轮换、登出全部本地可控 |
| 🧩 模型目录 | 目录驱动，不硬编码；文本模型自动进入 DSH 模型选择器 |
| 🔑 分组密钥 | 按目录 `group` 自动选密钥；401/403 自动重签重试；503 自动刷目录重试 |
| 💬 OpenAI 兼容 | `/chat/completions` SSE、tools / function calling、thinking 模型 reasoning 回传 |
| 🖼 图片输入 | 视觉模型可直接在 DSH 里贴图对话（能力表 + 可配置覆盖） |
| 🎨 生图 | Agent 工具 `orange_pro_image`：模型 id 与单价全部读平台目录（当前 2.6 家族），按张计费 + 确认卡 |
| 🎬 生视频 | Agent 工具 `orange_pro_video`：MiniMax H3，官方 V2 协议优先、原生 `/v1/h3/*` 回退 |
| 💰 余额/诊断 | 设置页显示平台实时余额；`/orange-pro/api/*` 同源诊断端点 |

## 环境要求

- DeepSeek Harness **0.2.1-rc.2** 或更新（`LlmAdapter` / `tools` 契约）
- Node.js **≥ 22**（插件本身零运行时依赖）

## 安装

### 方式 A：插件管理里从 GitHub 安装（推荐）

1. 打开 DSH → 设置 → **插件**（Plugins）
2. 选择 **从 GitHub 安装**，填入：

   ```
   github:ft54482/chengzipro-dsh-plugin
   ```

   或完整仓库地址 `https://github.com/ft54482/chengzipro-dsh-plugin`
3. 安装完成后进入 **设置 → 橙子PRO**，用手机验证码或账号密码登录一次。

> 插件声明了 `dsh.bundle.patch`，安装即自动插入 Loader 行；无需手改 profile 文件。

### 方式 B：本地 clone 后安装

```bash
git clone https://github.com/ft54482/chengzipro-dsh-plugin.git
```

然后在 DSH 的插件管理里选择 **从本地路径安装**，指向 clone 下来的目录（或让 Agent 调
`plugin_manager` 的 `install_bundle`，`spec` 填绝对路径）。

### 升级 / 卸载

- 升级：插件管理里点 **更新**（或重新安装一次）。
- 卸载：插件管理里 **移除**；登录态与密钥会随 `ctx.credentials` 的插件记录一起清理。
- 开发调试：本仓库是 linked 包时，改完 Host 代码必须 **移除 + 重新安装**（或重启 DSH）才会载入新模块。

## 配置

安装后打开 **设置 → 橙子PRO**：

| 配置 | 默认 | 说明 |
|---|---|---|
| BFF Base URL | `https://pro.nat6.net/video-api` | 账号/目录/余额接口 |
| 显示名 | `橙子PRO` | 模型选择器里的分组名 |
| 自动同步 | 开 | 启动 2s 后 + 每 10 分钟拉一次目录 |
| 上下文系数 | `1` | 默认按平台真实上限展示（1M 就显示 1M） |
| 答复规范 | 开 | 对指定模型追加 system 规范，跟随界面语言 |
| 视觉覆盖 | 空 | `vision.include / vision.exclude` 强制开/关某个模型的图片输入 |

等价的 JSON 配置端点（仅 loopback 同源）：

```bash
curl -X POST http://127.0.0.1:<port>/orange-pro/api/config \
  -H 'content-type: application/json' \
  -d '{"bffBaseURL":"https://pro.nat6.net/video-api","autoSync":true}'
```

## 使用

### 文本对话

模型选择器里会出现「橙子PRO」分组，选中任意模型即可对话；余额在设置页实时显示（以平台返回值唯一为准）。

### 图片输入（视觉）

给支持视觉的模型（如 `deepseek-v4.1-flash`、`DeepSeek-V4.1-flash-2.5`、`gpt-5.x`、`gemini-3.x`）
直接贴图，插件会把附件转成 OpenAI 兼容的 `image_url` data URI 发给平台。

- 不支持视觉的模型（`glm-*`、`kimi`、`qwen`、`claude`、`minimax`、`deepseek-v4-pro-oc`）仍按纯文本处理。
- 需要强制开关：`POST /orange-pro/api/config {"vision":{"include":["模型id"]}}`。
- 细节与实测证据见 [`docs/VISION.md`](docs/VISION.md)。

### 生图 / 生视频（Agent 工具）

直接在对话里说「帮我生成一张…」「生成一段…视频」，模型会调用：

| 工具 | 模型 | 计费 | 产物 |
|---|---|---|---|
| `orange_pro_image` | 平台目录当前图像模型（如 `gpt-image-2.6-flare/sunburst` 及 4K） | 按张，¥0.15–0.45（随目录） | `orange-images/*.png` |
| `orange_pro_video` | `MiniMax-H3 768P / 2K` | ¥1.2 / 1.9 每次 | `orange-videos/*.mp4` |

- **不确认不扣费**：有交互确认卡时弹卡；没有时要求模型显式 `confirm: true`；生成前还会查余额预拦截。
- 生图不做超时重试（sync 协议下断开也会计费）；视频失败/超时由平台自动退款。
- 细节见 [`docs/MEDIA.md`](docs/MEDIA.md)。

## 架构

```
index.js              Host 入口：注册 LLM route / 媒体工具 / 设置页 API / 自动同步
client.js             Client 半：设置页（React，settings.section）
src/platform.js       BFF(JWT) + 推理(分组密钥) + SSE 解析 + 错误归一
src/service.js        登录、会话轮换、分组密钥、目录、余额、取钥、图片附件解析
src/adapter.js        LlmAdapter：目录/元数据/流式/图片序列化/自愈重试
src/state.js          state.json（账号快照/模型缓存/余额，无凭据）
src/model-spec.js     上下文/输出上限推断
src/model-compat.js   模型答复规范兼容层
src/vision.js         图片输入能力判定与请求图像目标
src/media-*.js        生图/生视频（官方 V2 + 原生 H3 回退、计费护栏）
src/api.js            设置页同源 JSON API + diagnose + selftest + media/vision 状态
```

更细的模块说明与数据流见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 安全模型

- API key / JWT 只进 DSH 凭据服务（`ctx.credentials`），**不写入**配置文件、日志、state.json。
- 设置页 API 只接受 loopback 同源请求，响应不含 token/密钥，body ≤ 64 KiB。
- 媒体工具写文件只在会话工作区内（参考图路径拒绝 `..` 穿越）。
- 仓库内不含任何真实账号、密钥或手机号。

## 诊断

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/orange-pro/api/status` | 登录态、余额、模型数、媒体模型、`vision.models` |
| GET | `/orange-pro/api/media` | 图片/视频模型、分组密钥覆盖、当前视频协议 |
| GET | `/orange-pro/api/diagnose` | DSH 运行时实际看到的路由与模型 |
| POST | `/orange-pro/api/selftest` | `{"mode":"text"\|"history"\|"media"}` 链路自检（media 不扣费） |
| POST | `/orange-pro/api/sync` | 强制刷新目录 |
| POST | `/orange-pro/api/logout` | 清会话、密钥、账号快照 |

## 测试

零依赖、零网络、零扣费：

```bash
npm test
# 等价于：
node test/vision.test.mjs        # 15 项：图片输入能力与序列化
node test/adapter.test.mjs       # 30+ 项：消息转换/推理回传/凭据键/折扣
node test/media.test.mjs         # 20 项：生图/生视频协议、回退、计费护栏
node test/plugin-smoke.test.mjs  # 12 项：工具定义契约、确认卡、工作区约束
```

## 已知限制

- 只对接 `openai-chat` 协议文本模型；Anthropic `/v1/messages` 直连未接入（平台支持时可由 OpenAI 兼容层覆盖）。
- 图片输入依赖模型自身视觉能力；平台目录尚未下发 modalities，插件维护了一张**实测证据表**。
- 生图仅文生图；图生图 `/v1/images/edits` 与参考视频/音频输入未接入。
- MiniMax 官方 V2 通道 `duration` 4–15；原生 H3 通道 1–15。
- 平台分组名是不透明字符串（可能含空格），插件原样使用。

## 贡献

欢迎 Issue / PR。提交前请确保 `npm test` 全绿，并且不要在测试或文档里写入真实密钥、账号或手机号。

## License

[MIT](LICENSE)
