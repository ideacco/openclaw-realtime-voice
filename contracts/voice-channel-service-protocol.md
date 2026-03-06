# Voice Channel Service Contract (Plugin <-> Audio Service)

版本：v0.1

本协议定义 OpenClaw Channel 插件层与音频服务层之间的接口。

## 1. Endpoint

- Base URL: `AUDIO_SERVICE_BASE_URL`（例如 `http://127.0.0.1:8080`）
- WebSocket: `${AUDIO_SERVICE_BASE_URL}/channel/voice/ws?token=<VOICE_GATEWAY_TOKEN>`

## 2. 会话生命周期

1. 插件与音频服务建立 WebSocket 连接
2. 插件发送 `channel.start`
3. 音频服务返回 `channel.started`
4. 插件转发文本/音频输入（`input.assistant.text` / `input.text` / `input.audio.*`）
5. 音频服务持续返回：
   - `asr.text`
   - `assistant.text.delta`
   - `audio.output.delta`
   - `audio.output.completed`
6. 插件发送 `channel.end`，服务返回 `channel.ended`

## 3. 客户端 -> 服务端事件

### channel.start

```json
{
  "type": "channel.start",
  "voice": "Bunny",
  "sampleRate": 24000,
  "inputSampleRate": 16000,
  "clientRole": "web"
}
```

`clientRole` 可选值：`web` / `plugin`。`plugin` 会话默认不启用 idle timeout，用于 OpenClaw 频道常驻连接。

### input.text

```json
{
  "type": "input.text",
  "text": "你好，帮我总结今天的会议"
}
```

`input.text` 语义（模式相关）：

- `llmMode=plugin`（默认）：服务端只记录用户文本事件，真正的 OpenClaw 调用由频道插件通过 `asr.text` 触发。
- `llmMode=gateway`（可选调试）：服务端直接调用 OpenClaw Gateway 获取流式回复，再做 TTS。

### input.assistant.text

```json
{
  "type": "input.assistant.text",
  "text": "这是 OpenClaw 已生成的回复文本",
  "sessionId": "目标会话ID（可选）"
}
```

`input.assistant.text` 语义：文本已由 OpenClaw 生成，服务端只做流式 TTS，不再反向调用 OpenClaw。

### input.audio.chunk

```json
{
  "type": "input.audio.chunk",
  "data": "<base64>",
  "encoding": "pcm_s16le",
  "sampleRate": 16000
}
```

### input.audio.commit

```json
{
  "type": "input.audio.commit",
  "reason": "manual"
}
```

### input.asr.local（可选，用于 browser/local ASR）

```json
{
  "type": "input.asr.local",
  "text": "浏览器本地识别文本",
  "isFinal": true
}
```

### channel.end

```json
{
  "type": "channel.end"
}
```

## 4. 服务端 -> 客户端事件

### channel.started

```json
{
  "type": "channel.started",
  "sessionId": "uuid",
  "voice": "Bunny",
  "sampleRate": 24000,
  "asrProvider": "browser",
  "ttsProvider": "browser",
  "llmEnabled": true,
  "llmMode": "plugin"
}
```

### asr.text

```json
{
  "type": "asr.text",
  "sessionId": "uuid",
  "text": "用户说的话",
  "isFinal": true
}
```

### assistant.text.delta

```json
{
  "type": "assistant.text.delta",
  "sessionId": "uuid",
  "text": "增量token"
}
```

### audio.output.delta

```json
{
  "type": "audio.output.delta",
  "sessionId": "uuid",
  "data": "<base64_pcm>",
  "sampleRate": 24000,
  "format": "pcm"
}
```

### audio.output.completed

```json
{
  "type": "audio.output.completed",
  "sessionId": "uuid"
}
```

### channel.error

```json
{
  "type": "channel.error",
  "sessionId": "uuid",
  "code": "UPSTREAM_ERROR",
  "message": "...",
  "retryable": true
}
```

## 5. 错误码

- `BAD_REQUEST`
- `AUTH_FAILED`
- `UPSTREAM_ERROR`
- `TIMEOUT`
- `INTERNAL_ERROR`

## 6. 推荐重试策略

- `retryable=true`：指数退避重试（500ms, 1000ms, 2000ms，最多 3 次）
- `retryable=false`：直接结束当前会话
