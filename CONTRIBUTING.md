# Contributing

感谢参与！这是一个零运行时依赖的 Cordis 插件，改动门槛很低。

## 开发

```bash
git clone https://github.com/ft54482/dsh-plugin-orange-pro.git
cd dsh-plugin-orange-pro
node --version   # >= 22
npm test
```

在 DSH 里调试时把本地目录作为 bundle 安装（插件管理 → 从本地路径，或 `plugin_manager` 的
`install_bundle`）。注意：**linked 包不热更新**，改完 Host 代码要移除 + 重新安装或重启 DSH。

## 提交前检查

1. `npm test` 全绿（4 个测试文件，零网络、零扣费）。
2. 不在代码/测试/文档里写真实 API key、账号、手机号或内部链接。
3. 新增对外契约（文件格式、键语法、API 字段）时同步更新 `docs/` 并补单测。
4. 破坏性写入（凭据、用户目录、外部系统）必须有单一构造入口 + 写前校验。

## 代码风格

- ESM、无依赖、纯函数优先；平台错误统一走 `PlatformError` / `MediaError`。
- UI 文案走 `locale/`；日志只写状态与错误消息，不写响应体里的密钥。
