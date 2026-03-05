# OpenClaw Voice Channel Plugin (Scaffold)

这个目录是 OpenClaw Channel 插件层（上层）。

- 插件职责：接入 OpenClaw runtime 生命周期，注册 `voice` channel。
- 音频处理职责：委托给外部音频服务（当前仓库根目录实现）。

## 目录

- `openclaw.plugin.json`: 插件元数据与配置声明
- `index.ts`: 插件入口，调用 `api.registerChannel`
- `src/voice-channel-plugin.ts`: Channel Plugin 实现
- `src/audio-service-client.ts`: 与音频服务的 WS 客户端

## 对接协议

请参考：`../contracts/voice-channel-service-protocol.md`

## 集成步骤（建议）

1. 将该目录复制到 OpenClaw 的 `extensions/voice-channel`
2. 在 OpenClaw 配置中启用 `channels.voice`
3. 配置 `audioServiceBaseUrl` 与 `audioServiceToken`
4. 启动 OpenClaw 与本仓库根目录音频服务
