# OpenClaw Realtime Voice

[中文文档](./README.cn.md)

OpenClaw Realtime Voice is a two-part voice stack for OpenClaw:

1. `server/`: a realtime audio service that handles browser audio, ASR, TTS, and the voice websocket session.
2. `openclaw-plugin/`: an OpenClaw channel plugin that connects OpenClaw to that audio service.

This repository is for one job: make OpenClaw usable as a realtime voice assistant with a browser client.

## What This Repository Actually Contains

This project is not a single plugin file. It is a complete runtime path:

`Browser -> Audio Service -> ASR -> OpenClaw Plugin -> OpenClaw -> Plugin -> Audio Service -> TTS -> Browser`

That matters for installation. You must set up both sides:

- the **audio service** in this repo
- the **OpenClaw plugin** in this repo

If you only install the plugin, nothing will speak.
If you only run the audio service, OpenClaw will never receive or return channel messages.

## Screenshots

![Voice UI Screenshot 1](./ScreenShot_1.png)

![Voice UI Screenshot 2](./ScreenShot_2.png)

## Product Scope

Current scope:

- Browser mic input
- VAD segmentation
- Realtime ASR (`aliyun` or browser transcript mode)
- OpenClaw voice channel integration
- Streaming OpenClaw text reply
- Realtime TTS (`aliyun` or browser TTS fallback)
- Browser debug UI for wake word, PTT, and playback

Current non-goals:

- Production-grade cluster deployment
- Native mobile apps
- WebRTC media transport
- Barge-in / interruption as a fully polished product feature

## Repository Layout

```text
openclaw-realtime-voice/
├── server/             # Node.js audio service
├── client/             # Browser debug UI served by the audio service
├── openclaw-plugin/    # OpenClaw channel plugin
├── contracts/          # Protocol and lifecycle docs
└── docker-compose.yml  # Optional container startup
```

## Architecture

### Components

1. `server/`
   - exposes `http://<host>:8080`
   - exposes `ws://<host>:8080/channel/voice/ws?token=...`
   - serves the browser debug UI
   - receives browser audio or text
   - runs VAD / ASR / TTS
   - forwards user text to OpenClaw in plugin mode or gateway mode

2. `openclaw-plugin/`
   - registers the `voice` channel in OpenClaw
   - opens a websocket to the audio service
   - forwards OpenClaw replies back to the audio service

3. `client/`
   - browser debug UI
   - wake word mode
   - hold-space PTT
   - streaming audio playback
   - developer panel for testing text/audio/debug events

### Runtime Modes

This repository supports two OpenClaw integration modes.

1. `plugin` mode
   - default mode
   - recommended mode
   - OpenClaw loads `openclaw-plugin/`
   - audio service waits for the plugin to connect
   - browser input becomes OpenClaw channel traffic through the plugin

2. `gateway` mode
   - optional fallback for standalone debugging
   - enabled when `OPENCLAW_GATEWAY_BASE_URL` is set in `server/.env`
   - audio service calls OpenClaw HTTP directly
   - does not require the OpenClaw plugin websocket peer

For normal product usage, use `plugin` mode.

## Data Flow

### Normal Voice Flow

1. Browser connects to the audio service websocket.
2. Browser sends audio chunks.
3. Audio service performs VAD and ASR.
4. Audio service forwards the recognized user text to OpenClaw through the plugin.
5. OpenClaw produces streaming text.
6. Plugin forwards that text back to the audio service.
7. Audio service segments text and sends it to realtime TTS.
8. Browser receives streaming audio chunks and plays them.

### Debug Text Flow

The developer panel can also send plain text directly.

That path is:

`Debug Text -> Audio Service -> OpenClaw -> TTS -> Browser`

This path does **not** use ASR.

## Choose Your Deployment Topology

There are two practical deployment topologies.

### Option A: OpenClaw and Audio Service on the Same Machine

Recommended for local development.

Use this when:

- OpenClaw and the audio service run on the same Mac/Linux machine
- you want the least configuration friction
- you do not need cross-device access first

Use these plugin URLs:

- `audioServiceBaseUrl = http://127.0.0.1:8080`
- `audioServiceWsUrl = ws://127.0.0.1:8080/channel/voice/ws`

### Option B: OpenClaw and Audio Service on Different Machines in the Same LAN

Use this when:

- OpenClaw runs on machine A
- this repository's audio service runs on machine B
- browser clients may also open the UI from machine B

Use these plugin URLs:

- `audioServiceBaseUrl = http://<audio-service-lan-ip>:8080`
- `audioServiceWsUrl = ws://<audio-service-lan-ip>:8080/channel/voice/ws`

Important:

- `HOST` in `server/.env` must be `0.0.0.0`
- machine A must be able to `curl http://<audio-service-lan-ip>:8080/`
- if your Wi-Fi changes the LAN IP, you must update the OpenClaw plugin config

## Quick Start

### Prerequisites

- Node.js 20+
- npm 10+
- OpenClaw already installed and runnable
- a valid speech API key if you use `ASR_PROVIDER=aliyun` or `TTS_PROVIDER=aliyun`

### 1. Install the Audio Service

```bash
cd server
npm install
cp .env.example .env
```

Edit `server/.env`.

Minimum required values:

```env
HOST=0.0.0.0
PORT=8080
VOICE_GATEWAY_TOKEN=dev-token
SPEECH_API_KEY=your-key
ASR_PROVIDER=aliyun
TTS_PROVIDER=aliyun
WAKE_WORDS=你好老六
```

### 2. Start the Audio Service

Node mode:

```bash
cd server
npm run dev
```

You should see logs like:

```text
[voice-channel] server started: http://localhost:8080
[voice-channel] lan url: http://<lan-ip>:8080
[voice-channel] websocket: ws://localhost:8080/channel/voice/ws?token=dev-token
```

Then open:

- `http://localhost:8080`
- or the LAN URL printed by the server

### 3. Install the OpenClaw Plugin

Copy `openclaw-plugin/` into the plugin directory used by your OpenClaw installation.

Typical example:

```bash
cp -R openclaw-plugin ~/clawd/plugins/voice-channel
cd ~/clawd/plugins/voice-channel
npm install
```

Do not skip `npm install` inside the plugin directory.
The plugin currently declares its own dependency set.

### 4. Configure OpenClaw

Add or update the plugin entry in your OpenClaw config.

Same-machine example:

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

LAN example:

```json
{
  "plugins": {
    "entries": {
      "voice-channel": {
        "enabled": true,
        "config": {
          "audioServiceBaseUrl": "http://192.168.31.188:8080",
          "audioServiceToken": "dev-token",
          "audioServiceWsUrl": "ws://192.168.31.188:8080/channel/voice/ws"
        }
      }
    }
  }
}
```

Required plugin config fields:

- `audioServiceBaseUrl`
- `audioServiceToken`

Recommended field:

- `audioServiceWsUrl`

If OpenClaw and the audio service are on different machines, set `audioServiceWsUrl` explicitly.

### 5. Restart OpenClaw

After plugin installation or config change, restart OpenClaw.

Then verify OpenClaw logs.

Expected handshake sequence:

```text
[voice-channel][default] CONNECTING ws://...
[voice-channel][default] CONNECTED websocket
[voice-channel][default] STARTED sessionId=...
```

If you do not see `STARTED sessionId=...`, the plugin is not ready.

## Docker Deployment

If you want to run only the audio service in Docker:

```bash
docker compose up --build
```

This uses:

- [docker-compose.yml](./docker-compose.yml)
- [server/Dockerfile](./server/Dockerfile)

Notes:

- Docker uses `server/.env`
- OpenClaw plugin config must still point to the **host machine IP**, not a Docker container IP
- if Docker cannot pull `node:20-alpine`, fix Docker Desktop network/proxy first

## Direct Node Deployment vs Docker

### Use Node directly when

- you are actively developing
- you want faster iteration
- you need to inspect logs and rebuild quickly

### Use Docker when

- you want a repeatable local runtime package
- you want the service isolated from your host Node environment
- you plan to keep the audio service running on a dedicated machine

For development, Node mode is still the simpler path.

## Important Configuration

`server/.env` supports these main variables.

### Core Server

- `HOST`: bind address. Use `0.0.0.0` for LAN access.
- `PORT`: default `8080`
- `VOICE_GATEWAY_TOKEN`: websocket access token; must match plugin config
- `VOICE_IDLE_TIMEOUT_MS`: idle timeout; set `0` to disable auto-disconnect
- `WAKE_WORDS`: comma-separated wake words sent to the web client

### ASR

- `SPEECH_API_KEY`
- `ASR_PROVIDER=browser|aliyun`
- `ASR_URL`
- `ASR_MODEL`
- `ASR_LANGUAGE`
- `ASR_SAMPLE_RATE`

### TTS

- `TTS_PROVIDER=browser|aliyun`
- `TTS_URL`
- `TTS_MODEL`
- `TTS_VOICE`
- `TTS_FORMAT`
- `TTS_SAMPLE_RATE`
- `TTS_MODE=server_commit|commit`

### Optional Gateway Debug Mode

Leave these empty unless you explicitly want direct HTTP integration instead of plugin mode:

- `OPENCLAW_GATEWAY_BASE_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_AGENT_ID`
- `OPENCLAW_REQUEST_MODEL`
- `OPENCLAW_CHAT_PATH`
- `OPENCLAW_TIMEOUT_MS`

If `OPENCLAW_GATEWAY_BASE_URL` is empty, the server runs in `plugin` mode.

## Browser Debug UI

The browser UI is for integration testing, not just visual demo.

Capabilities:

- wake-word mode
- hold-space push-to-talk
- streaming audio playback
- stop current TTS playback
- developer panel
- left-side conversation timeline
- Markdown rendering for OpenClaw replies

Current behavior:

- wake words are read from `server/.env`
- very short filler ASR text such as `嗯。` is filtered before sending to OpenClaw
- TTS display text and TTS spoken text are handled separately; display keeps formatting, speech is cleaned before synthesis

## How To Verify The System End To End

### Basic Checklist

1. Start the audio service.
2. Open the browser UI.
3. Confirm the page can create a websocket session.
4. Confirm OpenClaw plugin logs show `STARTED sessionId=...`.
5. Speak or send debug text.
6. Confirm:
   - `asr.text`
   - `message.created`
   - `assistant.text.delta`
   - `audio.output.delta`
   - `audio.output.completed`

### If You Only Get Text But No Audio

Check in this order:

1. Is `TTS_PROVIDER=aliyun` or `browser` what you expect?
2. Is the browser blocked from audio playback?
3. Did you click stop playback in the previous turn?
4. Did the audio service receive `audio.output.delta`?
5. Is OpenClaw plugin actually connected, or are you only seeing browser-side events?

## Troubleshooting

### `OpenClaw voice-channel plugin is not connected to audio service`

Meaning:

- browser is connected to the audio service
- but the OpenClaw plugin websocket peer is not connected yet

Check:

1. OpenClaw plugin logs
2. plugin config `audioServiceBaseUrl` and `audioServiceWsUrl`
3. `VOICE_GATEWAY_TOKEN` matches plugin config
4. audio service LAN IP is still current

### `Timed out waiting channel.started (10000ms)`

Meaning:

- plugin connected websocket
- but did not complete the startup handshake

Use the latest plugin code from this repository.
Older plugin copies had startup ack race issues.

### `connect ECONNREFUSED <ip>:8080`

Meaning:

- OpenClaw can reach the host/IP
- but nothing is accepting connections on that port

Check:

```bash
lsof -iTCP:8080 -sTCP:LISTEN -n -P
curl -v http://127.0.0.1:8080/
curl -v http://<your-lan-ip>:8080/
```

### `connection timeout after 8000ms`

Meaning:

- plugin tried to connect to the audio service
- but the target IP or route is wrong, or the host is not reachable

Most common cause: your Wi-Fi reassigned the audio service machine a new LAN IP.

### OpenClaw config validation error: `must have required property 'audioServiceBaseUrl'`

Your OpenClaw plugin config is incomplete.
Add:

- `audioServiceBaseUrl`
- `audioServiceToken`

### `No WebSocket implementation found`

Your OpenClaw runtime Node version is too old.
Use Node 22+ for OpenClaw, or install the plugin dependencies inside the plugin directory.

## Installation Guidance For AI Agents

If you give this repository to an AI agent, it should follow this order:

1. install `server/`
2. configure `server/.env`
3. start the audio service
4. install `openclaw-plugin/` into OpenClaw
5. configure plugin URLs and token
6. restart OpenClaw
7. verify plugin log handshake
8. open browser UI and test audio/text flow

The most common mistake is installing only one side.
This project requires both the audio service and the OpenClaw plugin.

## Additional Docs

- [Chinese README](./README.cn.md)
- [Plugin-specific notes](./openclaw-plugin/README.md)
- [Protocol contract](./contracts/voice-channel-service-protocol.md)
