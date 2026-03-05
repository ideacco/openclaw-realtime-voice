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

位于 `server/src/`。

主流程：

`音频输入 -> VAD -> ASR -> OpenClaw Adapter -> Token 流 -> 分句 -> 实时 TTS -> 音频分片`

关键模块：

- `server/src/channel/voice-channel-plugin.ts`：会话编排与 WS 事件路由
- `server/src/vad/simple-vad.ts`：基于静音/能量阈值切分
- `server/src/asr/realtime-asr-client.ts`：ASR 接口 + mock 实现
- `server/src/tts/aliyun-tts-client.ts`：阿里云实时 TTS 客户端
- `server/src/pipeline/voice-agent.ts`：token 到 TTS 的流式控制器

### 2. Client 层

位于 `client/`。

职责：

- 提供浏览器调试 UI 与实时播放页面
- 采集麦克风音频分片并通过 WebSocket 发送到服务端

### 3. OpenClaw 插件层

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

### 4. 跨层协议

事件结构和生命周期请参考：

- `contracts/voice-channel-service-protocol.md`

## 目录结构

- `server/`：实时语音 WebSocket 服务（Node.js）
- `client/`：浏览器调试前端
- `openclaw-plugin/`：OpenClaw 插件骨架
- `contracts/`：接口契约文档
- `docker-compose.yml`：可选的一键容器启动

## 安装说明

### 前置要求

- Node.js 20+
- npm 10+

### 安装步骤

```bash
cd server
npm install
cp .env.example .env
```

## 给 AI 代理的安装提示词

如果你就是 OpenClaw（AI 个人助理），那么请你直接按照以下操作：

```text
请从当前 GitHub 仓库完成 OpenClaw Realtime Voice 项目的本地安装与验证。

环境要求：
- Node.js >= 20
- npm >= 10
- Linux/macOS shell

在仓库根目录按顺序执行：
1) cd server
2) npm install
3) cp .env.example .env（若不存在则创建）
4) npm run check
5) npm test
6) npm run build
7) npm run dev

如果 npm install 因网络受限失败，使用代理后重试一次：
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897

除非安装被阻塞，不要修改业务逻辑代码。
结束时输出：
- 各命令执行结果摘要
- 服务是否成功启动
- 本地访问 URL 与 WebSocket URL
- 未解决错误与对应失败命令
```

## 配置说明

在 `server/.env` 中使用通用变量：

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
cd server
npm run dev
```

然后打开：

- `http://localhost:8080`

### WebSocket 地址

- `ws://localhost:8080/channel/voice/ws?token=<VOICE_GATEWAY_TOKEN>`

## 测试

```bash
cd server
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

1. 在 `server/` 目录启动音频服务。
2. 将 `openclaw-plugin/` 复制到 OpenClaw 的 extensions 目录。
3. 在插件目录先执行依赖安装：`npm install`。
4. 在 `~/.openclaw/openclaw.json` 中配置插件必填项：

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

5. 安装插件或修改配置后，重启 OpenClaw。
6. 执行 `openclaw status`，确认配置校验通过。
7. 如果提示 `must have required property 'audioServiceBaseUrl'` 或 `audioServiceToken`，说明 `plugins.entries.voice-channel.config` 下缺少必填字段。
8. 如果提示 `Cannot find module 'ws'`，请在插件目录执行 `npm install` 后重启 OpenClaw。

## Docker Compose（可选）

```bash
cp server/.env.example server/.env
docker compose up --build
```

## 当前限制

- 真实 ASR 客户端尚未接入（当前会 fallback 到 mock）。
- `openclaw-plugin/` 为骨架实现，需按你的 OpenClaw 版本调整。
- 实时语音文本调试面板依赖浏览器 `SpeechRecognition` 支持。

## 后续计划

- 接入真实 ASR（阿里云实时 ASR）
- 增加 OpenAI 厂商实现
- 支持全双工打断（barge-in）
- 增加生产级观测与重试策略
