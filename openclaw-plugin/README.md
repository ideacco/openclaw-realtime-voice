# OpenClaw Voice Channel Plugin (Scaffold)

这个目录是 OpenClaw Channel 插件层（上层）。

- 插件职责：接入 OpenClaw runtime 生命周期，注册 `voice` channel。
- 音频处理职责：委托给外部音频服务（当前仓库 `server/` 实现）。

## 目录

- `openclaw.plugin.json`: 插件元数据与配置声明
- `index.ts`: 插件入口，调用 `api.registerChannel`
- `src/voice-channel-plugin.ts`: Channel Plugin 实现
- `src/audio-service-client.ts`: 与音频服务的 WS 客户端

## 对接协议

请参考：`../contracts/voice-channel-service-protocol.md`

## 集成步骤（建议）

1. 将该目录复制到 OpenClaw 的 `extensions/voice-channel`
2. 在插件目录执行依赖安装：`npm install`
3. 在 OpenClaw 配置中启用 `channels.voice`
4. 在 `~/.openclaw/openclaw.json` 里配置插件：

```json
{
  "plugins": {
    "entries": {
      "voice-channel": {
        "enabled": true,
        "config": {
          "audioServiceBaseUrl": "http://127.0.0.1:8080",
          "audioServiceToken": "dev-token",
          "audioServiceWsUrl": "ws://127.0.0.1:8080/channel/voice/ws"
        }
      }
    }
  }
}
```

5. 必填字段：`audioServiceBaseUrl`、`audioServiceToken`
6. 可选字段：`audioServiceWsUrl`（异机部署建议显式填写，支持 `ws://` 或 `wss://`）
7. 安装或改配置后重启 OpenClaw，然后执行 `openclaw status` 校验
8. 启动 OpenClaw 与本仓库 `server/` 音频服务

## 常见问题

- `No WebSocket implementation found`
  - 原因：运行时没有全局 `WebSocket`（通常是 Node 版本过低）
  - 处理：升级到 Node 22+；若必须使用旧版 Node，再手动安装 `ws` 作为兼容回退
- `refresh failed: accountIds is not iterable`
  - 原因：使用了旧插件代码（`listAccountIds` 返回 Promise）
  - 处理：同步最新插件代码后重启 OpenClaw
- `TypeError: Cannot read properties of undefined (reading 'nativeCommands')`
  - 原因：`registerChannel` 注册参数形态不匹配
  - 处理：同步最新插件代码后重启 OpenClaw（已做新旧版本兼容）

## 如何确认握手成功

插件现在会输出明确的握手阶段日志（OpenClaw 网关日志中可见）：

- `[voice-channel][default] CONNECTING ws://...`
- `[voice-channel][default] CONNECTED websocket`
- `[voice-channel][default] STARTED sessionId=... asrProvider=...`

判定标准：

- 出现 `STARTED sessionId=...` 才代表“OpenClaw 频道已与音频服务完成握手”。
- 如果失败，会输出 `FAILED ...`，并在 OpenClaw 中看到 channel 启动失败。
