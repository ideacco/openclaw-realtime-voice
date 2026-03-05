# OpenClaw Voice Channel

项目标识（package name）：`openclaw-voice-channel-plugin`

当前实现已从“独立 Voice Gateway 插件”调整为“OpenClaw Channel Plugin（频道插件）”结构。

核心链路：

- 客户端音频流 -> Voice Channel WebSocket
- VAD 切分
- ASR 转文本
- 触发 OpenClaw 标准 message 事件（通过 Adapter）
- 拦截 OpenClaw 流式文本回复
- 分句送入流式 TTS
- 音频分片回推客户端

## 目录重点

- `src/channel/voice-channel-plugin.ts`: Channel 插件主流程
- `src/vad/simple-vad.ts`: VAD 切分
- `src/asr/realtime-asr-client.ts`: ASR 接口与 mock 实现
- `src/channel/openclaw-adapter.ts`: OpenClaw 适配接口
- `src/channel/mock-openclaw-adapter.ts`: mock OpenClaw 流式回复
- `src/tts/aliyun-tts-client.ts`: Aliyun Realtime TTS 客户端

## Quick Start

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

3. 运行

```bash
npm run dev
```

4. 打开浏览器

访问 `http://localhost:8080`

## WebSocket

- Endpoint: `ws://localhost:8080/channel/voice/ws?token=dev-token`
- 默认 token: `VOICE_GATEWAY_TOKEN`

## 当前默认实现说明

- `MOCK_TTS=true` 时无需阿里云 Key 即可演示音频回放
- ASR 默认是 `MockRealtimeAsrClient`，会将音频分片转换为演示文本
- OpenClaw 默认是 `MockOpenClawAdapter`，用于模拟流式 token 回复
- 真实阿里云 TTS 使用 Realtime WS 协议（`input_text_buffer.append` / `response.audio.delta`）
- `ALIYUN_TTS_MODE` 推荐值：`server_commit`（可选 `commit`）

要接入真实 OpenClaw Runtime：实现 `OpenClawAdapter` 并替换 `src/server.ts` 中的 mock adapter。
