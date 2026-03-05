import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MockRealtimeAsrClient } from './asr/realtime-asr-client.js';
import { MockOpenClawAdapter } from './channel/mock-openclaw-adapter.js';
import { VoiceChannelPlugin } from './channel/voice-channel-plugin.js';
import type { TtsMode } from './tts/aliyun-tts-client.js';

const webRoot = path.resolve(process.cwd(), '..', 'client');
loadEnvFile(path.join(process.cwd(), '.env'));

const port = Number(process.env.PORT ?? 8080);
const token = process.env.VOICE_GATEWAY_TOKEN ?? 'dev-token';
const idleTimeoutMs = Number(process.env.VOICE_IDLE_TIMEOUT_MS ?? 60_000);
const useMockTts = asBool(process.env.MOCK_TTS, true);
const useMockAsr = asBool(process.env.MOCK_ASR, true);
const speechApiKey = envWithFallback('SPEECH_API_KEY', 'ALIYUN_API_KEY');
const asrModel = envWithFallback('ASR_MODEL', 'ALIYUN_ASR_MODEL') ?? 'paraformer-realtime-v2';
const ttsUrl =
  envWithFallback('TTS_URL', 'ALIYUN_TTS_URL') ??
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const ttsModel = envWithFallback('TTS_MODEL', 'ALIYUN_TTS_MODEL') ?? 'qwen-tts-realtime';
const ttsVoice = envWithFallback('TTS_VOICE', 'ALIYUN_TTS_VOICE') ?? 'Bunny';
const ttsFormat = (envWithFallback('TTS_FORMAT', 'ALIYUN_TTS_FORMAT') as 'pcm' | undefined) ?? 'pcm';
const ttsSampleRate = Number(envWithFallback('TTS_SAMPLE_RATE', 'ALIYUN_TTS_SAMPLE_RATE') ?? 24000);
const ttsMode = parseTtsMode(envWithFallback('TTS_MODE', 'ALIYUN_TTS_MODE'));

if (!useMockTts && !speechApiKey) {
  throw new Error('MOCK_TTS=false but SPEECH_API_KEY is missing');
}

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    const normalizedPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(webRoot, normalizedPath);

    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const channelPlugin = new VoiceChannelPlugin({
  server,
  token,
  idleTimeoutMs,
  asr: new MockRealtimeAsrClient({
    model: asrModel
  }),
  openclaw: new MockOpenClawAdapter(),
  aliyun: {
    apiKey: speechApiKey,
    url: ttsUrl,
    model: ttsModel,
    voice: ttsVoice,
    format: ttsFormat,
    sampleRate: ttsSampleRate,
    mode: ttsMode
  },
  useMockTts
});

server.listen(port, () => {
  console.log(`[voice-channel] server started: http://localhost:${port}`);
  console.log(`[voice-channel] websocket: ws://localhost:${port}/channel/voice/ws?token=${token}`);
  console.log(
    `[voice-channel] mode: MOCK_TTS=${useMockTts} MOCK_ASR=${useMockAsr} ASR_MODEL=${asrModel} TTS_MODE=${ttsMode} TTS_URL=${ttsUrl}`
  );
  if (!useMockAsr) {
    console.log(
      `[voice-channel] WARN: real ASR client is not implemented yet, fallback to mock ASR (model=${asrModel})`
    );
  }
});

process.on('SIGINT', () => {
  channelPlugin.close();
  server.close(() => {
    process.exit(0);
  });
});

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  return 'application/octet-stream';
}

function loadEnvFile(filePath: string): void {
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

function parseTtsMode(value: string | undefined): TtsMode {
  if (!value) {
    return 'server_commit';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'servercommit' || normalized === 'server_commit') {
    return 'server_commit';
  }
  if (normalized === 'commit') {
    return 'commit';
  }
  return 'server_commit';
}

function envWithFallback(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}
