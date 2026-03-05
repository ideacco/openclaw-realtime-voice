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
4. 插件转发用户输入（`input.text` 或 `input.audio.*`）
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
  "inputSampleRate": 16000
}
```

### input.text

```json
{
  "type": "input.text",
  "text": "你好，帮我总结今天的会议"
}
```

### input.audio.chunk

```json
{
  "type": "input.audio.chunk",
  "data": "<base64>",
  "encoding": "webm_opus",
  "sampleRate": 48000
}
```

### input.audio.commit

```json
{
  "type": "input.audio.commit",
  "reason": "manual"
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
  "sampleRate": 24000
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
