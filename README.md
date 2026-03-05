# OpenClaw Voice Channel

[中文版本 (Chinese)](./README.cn.md)

A two-layer realtime voice interaction project for OpenClaw:

- **Audio Service Layer**: realtime audio ingestion, VAD, ASR abstraction, LLM token-to-speech pipeline, browser playback.
- **OpenClaw Channel Plugin Layer**: OpenClaw channel plugin scaffold that bridges OpenClaw runtime and the audio service.

This repository is designed to help you build a ChatGPT Voice-like flow on top of OpenClaw.

## Features

- Realtime websocket voice session endpoint (`/channel/voice/ws`)
- Audio chunk ingestion from browser client
- VAD segmentation pipeline (`input.audio.chunk` -> segment)
- ASR abstraction with pluggable implementation (currently mock implementation)
- Streaming assistant token handling
- Sentence segmentation for low-latency TTS
- Aliyun realtime TTS integration (new realtime protocol)
- Streaming audio chunk playback in web UI
- OpenClaw channel plugin scaffold (`openclaw-plugin/`)
- Contract document between plugin layer and audio service (`contracts/`)

## Architecture

### 1. Audio Service Layer

Located in `src/`.

Main flow:

`Audio Input -> VAD -> ASR -> OpenClaw Adapter -> Token Stream -> Sentence Segmenter -> Realtime TTS -> Audio Chunks`

Key modules:

- `src/channel/voice-channel-plugin.ts`: session orchestration and websocket event router
- `src/vad/simple-vad.ts`: segmentation by silence/energy
- `src/asr/realtime-asr-client.ts`: ASR interface + mock implementation
- `src/tts/aliyun-tts-client.ts`: Aliyun realtime TTS websocket client
- `src/pipeline/voice-agent.ts`: token-to-tts streaming controller
- `src/web/voice-ui/`: browser debug client and realtime playback UI

### 2. OpenClaw Plugin Layer

Located in `openclaw-plugin/`.

Main responsibility:

- Register a `voice` channel plugin in OpenClaw
- Connect to the audio service websocket
- Forward outbound text from OpenClaw to audio service

Key files:

- `openclaw-plugin/openclaw.plugin.json`
- `openclaw-plugin/index.ts`
- `openclaw-plugin/src/voice-channel-plugin.ts`
- `openclaw-plugin/src/audio-service-client.ts`

### 3. Cross-layer Contract

See `contracts/voice-channel-service-protocol.md` for event schema and lifecycle.

## Repository Layout

- `src/`: audio service implementation
- `openclaw-plugin/`: OpenClaw plugin scaffold
- `contracts/`: interface contract docs
- `tests/`: unit tests
- `dist/`: compiled output

## Installation

### Prerequisites

- Node.js 20+
- npm 10+

### Setup

```bash
cd openclaw-realtime_voice
npm install
cp .env.example .env
```

## Agent Install Prompt

Use this prompt when you give the repository URL to an AI coding agent:

```text
You are setting up the OpenClaw Realtime Voice project from this GitHub repository.

Environment requirements:
- Node.js >= 20
- npm >= 10
- Linux/macOS shell

Work in project root and run:
1) npm install
2) cp .env.example .env (create if missing)
3) npm run check
4) npm test
5) npm run build
6) npm run dev

If npm install fails due to network limits, retry once with proxy:
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897

Do not change business logic unless setup is blocked.
At the end, print:
- command results summary
- whether server started successfully
- local URL and websocket URL
- unresolved errors and exact failing command
```

## Configuration

Use `.env` with provider-neutral keys:

- `SPEECH_API_KEY`: API key for speech provider
- `ASR_MODEL`: ASR model name
- `TTS_URL`: realtime TTS websocket endpoint
- `TTS_MODEL`: realtime TTS model name
- `TTS_VOICE`: voice profile
- `TTS_FORMAT`: currently `pcm`
- `TTS_SAMPLE_RATE`: output sample rate, e.g. `24000`
- `TTS_MODE`: `server_commit` or `commit`
- `MOCK_TTS`: `true`/`false`
- `MOCK_ASR`: `true`/`false`

Backward compatibility:

- Legacy `ALIYUN_*` keys are still accepted as fallback.

## Run

### Start Audio Service

```bash
npm run dev
```

Then open:

- `http://localhost:8080`

### WebSocket Endpoint

- `ws://localhost:8080/channel/voice/ws?token=<VOICE_GATEWAY_TOKEN>`

## Testing

```bash
npm run check
npm test
npm run build
```

Manual test checklist:

1. Connect channel from web UI.
2. Send text and verify `assistant.text.delta` and `audio.output.delta` events.
3. Start recording, stop/commit, verify `vad.segment` and `asr.text`.
4. Verify the final event `audio.output.completed`.

## OpenClaw Integration Steps

1. Keep this repository running as the audio service.
2. Copy `openclaw-plugin/` into OpenClaw extensions directory.
3. Register/enable the `voice` channel in OpenClaw config.
4. Set plugin config to point to `AUDIO_SERVICE_BASE_URL` and token.
5. Start OpenClaw gateway and validate channel lifecycle.

## Current Limitations

- Real ASR provider implementation is not wired yet (mock fallback is used).
- `openclaw-plugin/` is a scaffold and may require adaptation to your OpenClaw runtime version.
- Browser realtime transcript panel depends on `SpeechRecognition` browser support.

## Roadmap

- Implement real ASR client (Aliyun realtime ASR)
- Add OpenAI provider implementations
- Add full-duplex interruption (barge-in)
- Add production-grade observability and retry policies
