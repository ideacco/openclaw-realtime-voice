# OpenClaw Voice Channel

[English Version](./README.md)

这是一个面向 OpenClaw 的双层实时语音交互项目：

- **音频服务层**：实时音频接入、VAD、ASR 抽象、LLM 文本到语音流水线、浏览器播放。
- **OpenClaw 频道插件层**：OpenClaw Channel 插件骨架，负责连接 OpenClaw Runtime 与音频服务。

该仓库用于构建类似 ChatGPT Voice 的 OpenClaw 语音链路。

## 功能

- 实时语音会话 WebSocket 入口（`/channel/voice/ws`）
- 浏览器音频分片上传
- VAD 切分（`input.audio.chunk` -> 语音段）
- ASR 抽象层（当前为 mock 实现）
- Assistant 流式 token 处理
- 句子切分后低延迟 TTS
- 阿里云实时 TTS（新 Realtime 协议）
- Web 端流式音频播放
- OpenClaw 频道插件骨架（`openclaw-plugin/`）
- 插件层与音频服务层协议文档（`contracts/`）

## 架构

### 1. 音频服务层

位于 `src/`。

主流程：

`音频输入 -> VAD -> ASR -> OpenClaw Adapter -> Token 流 -> 分句 -> 实时 TTS -> 音频分片`

关键模块：

- `src/channel/voice-channel-plugin.ts`：会话编排与 WS 事件路由
- `src/vad/simple-vad.ts`：基于静音/能量阈值切分
- `src/asr/realtime-asr-client.ts`：ASR 接口 + mock 实现
- `src/tts/aliyun-tts-client.ts`：阿里云实时 TTS 客户端
- `src/pipeline/voice-agent.ts`：token 到 TTS 的流式控制器
- `src/web/voice-ui/`：浏览器调试与实时播放页面

### 2. OpenClaw 插件层

位于 `openclaw-plugin/`。

职责：

- 在 OpenClaw 中注册 `voice` channel
- 连接音频服务 WebSocket
- 将 OpenClaw 输出文本转发给音频服务

关键文件：

- `openclaw-plugin/openclaw.plugin.json`
- `openclaw-plugin/index.ts`
- `openclaw-plugin/src/voice-channel-plugin.ts`
- `openclaw-plugin/src/audio-service-client.ts`

### 3. 跨层协议

事件结构和生命周期请参考：

- `contracts/voice-channel-service-protocol.md`

## 目录结构

- `src/`：音频服务实现
- `openclaw-plugin/`：OpenClaw 插件骨架
- `contracts/`：接口契约文档
- `tests/`：单元测试
- `dist/`：编译产物

## 安装说明

### 前置要求

- Node.js 20+
- npm 10+

### 安装步骤

```bash
cd openclaw-voice
npm install
cp .env.example .env
```

## 配置说明

在 `.env` 中使用通用变量：

- `SPEECH_API_KEY`：语音服务密钥
- `ASR_MODEL`：ASR 模型名
- `TTS_URL`：实时 TTS WebSocket 地址
- `TTS_MODEL`：实时 TTS 模型名
- `TTS_VOICE`：音色
- `TTS_FORMAT`：当前支持 `pcm`
- `TTS_SAMPLE_RATE`：输出采样率（如 `24000`）
- `TTS_MODE`：`server_commit` 或 `commit`
- `MOCK_TTS`：`true`/`false`
- `MOCK_ASR`：`true`/`false`

兼容说明：

- 旧的 `ALIYUN_*` 变量仍可作为回退读取。

## 运行

### 启动音频服务

```bash
npm run dev
```

然后打开：

- `http://localhost:8080`

### WebSocket 地址

- `ws://localhost:8080/channel/voice/ws?token=<VOICE_GATEWAY_TOKEN>`

## 测试

```bash
npm run check
npm test
npm run build
```

手动测试建议：

1. 在 Web UI 建立连接。
2. 发送文本，确认出现 `assistant.text.delta` 和 `audio.output.delta`。
3. 录音并提交，确认出现 `vad.segment` 和 `asr.text`。
4. 最终确认 `audio.output.completed` 事件。

## 接入 OpenClaw 的步骤

1. 本仓库作为音频服务保持运行。
2. 将 `openclaw-plugin/` 复制到 OpenClaw 的 extensions 目录。
3. 在 OpenClaw 配置里启用 `voice` channel。
4. 配置插件指向 `AUDIO_SERVICE_BASE_URL` 和 token。
5. 启动 OpenClaw gateway，验证 channel 生命周期。

## 当前限制

- 真实 ASR 客户端尚未接入（当前会 fallback 到 mock）。
- `openclaw-plugin/` 为骨架实现，需按你的 OpenClaw 版本调整。
- 实时语音文本调试面板依赖浏览器 `SpeechRecognition` 支持。

## 后续计划

- 接入真实 ASR（阿里云实时 ASR）
- 增加 OpenAI 厂商实现
- 支持全双工打断（barge-in）
- 增加生产级观测与重试策略
