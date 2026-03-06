import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AliyunRealtimeAsrClient } from './asr/aliyun-realtime-asr-client.js';
import {
  BrowserRealtimeAsrClient,
  type AsrProvider,
  type RealtimeAsrClient
} from './asr/realtime-asr-client.js';
import { DisabledOpenClawAdapter } from './channel/openclaw-adapter.js';
import { OpenClawHttpAdapter } from './channel/openclaw-http-adapter.js';
import { VoiceChannelPlugin } from './channel/voice-channel-plugin.js';
import type { TtsMode } from './tts/aliyun-tts-client.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(moduleDir, '..');
const webRoot = path.resolve(serverRoot, '..', 'client');
loadEnvFile(path.join(serverRoot, '.env'));

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const token = process.env.VOICE_GATEWAY_TOKEN ?? 'dev-token';
const idleTimeoutMs = Number(process.env.VOICE_IDLE_TIMEOUT_MS ?? 60_000);
const asrProvider = parseAsrProvider(process.env.ASR_PROVIDER) ?? 'aliyun';
const speechApiKey = envWithFallback('SPEECH_API_KEY', 'ALIYUN_API_KEY');
const asrModel = envWithFallback('ASR_MODEL', 'ALIYUN_ASR_MODEL') ?? 'paraformer-realtime-v2';
const asrUrl =
  envWithFallback('ASR_URL', 'ALIYUN_ASR_URL') ??
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const asrLanguage = process.env.ASR_LANGUAGE ?? 'zh';
const asrSampleRate = Number(process.env.ASR_SAMPLE_RATE ?? 16000);
const ttsUrl =
  envWithFallback('TTS_URL', 'ALIYUN_TTS_URL') ??
  'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const ttsModel = envWithFallback('TTS_MODEL', 'ALIYUN_TTS_MODEL') ?? 'qwen-tts-realtime';
const ttsVoice = envWithFallback('TTS_VOICE', 'ALIYUN_TTS_VOICE') ?? 'Bunny';
const ttsFormat = (envWithFallback('TTS_FORMAT', 'ALIYUN_TTS_FORMAT') as 'pcm' | undefined) ?? 'pcm';
const ttsSampleRate = Number(envWithFallback('TTS_SAMPLE_RATE', 'ALIYUN_TTS_SAMPLE_RATE') ?? 24000);
const ttsMode = parseTtsMode(envWithFallback('TTS_MODE', 'ALIYUN_TTS_MODE'));
const openclawGatewayBaseUrl =
  process.env.OPENCLAW_GATEWAY_BASE_URL?.trim() ?? process.env.OPENCLAW_BASE_URL?.trim() ?? '';
const openclawGatewayToken =
  process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? process.env.OPENCLAW_API_KEY?.trim() ?? '';
const openclawAgentId = process.env.OPENCLAW_AGENT_ID?.trim() || 'main';
const openclawRequestModel = process.env.OPENCLAW_REQUEST_MODEL?.trim() || 'openclaw';
const openclawChatPath = process.env.OPENCLAW_CHAT_PATH?.trim() || '/v1/chat/completions';
const openclawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS ?? 45_000);
const openclawSystemPrompt = process.env.OPENCLAW_SYSTEM_PROMPT?.trim() || undefined;

if (!speechApiKey) {
  throw new Error('SPEECH_API_KEY is required');
}

const asrClient = createAsrClient({
  provider: asrProvider,
  model: asrModel,
  apiKey: speechApiKey,
  url: asrUrl,
  language: asrLanguage,
  sampleRate: asrSampleRate
});
const openclawAdapter = openclawGatewayBaseUrl
  ? new OpenClawHttpAdapter({
      baseUrl: openclawGatewayBaseUrl,
      apiKey: openclawGatewayToken || undefined,
      agentId: openclawAgentId,
      model: openclawRequestModel,
      chatPath: openclawChatPath,
      timeoutMs: Number.isFinite(openclawTimeoutMs) ? openclawTimeoutMs : 45_000,
      systemPrompt: openclawSystemPrompt
    })
  : new DisabledOpenClawAdapter();

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
  asrProvider,
  asr: asrClient,
  openclaw: openclawAdapter,
  aliyun: {
    apiKey: speechApiKey,
    url: ttsUrl,
    model: ttsModel,
    voice: ttsVoice,
    format: ttsFormat,
    sampleRate: ttsSampleRate,
    mode: ttsMode
  }
});

server.listen(port, host, () => {
  const lanIp = firstLanIpv4();
  console.log(`[voice-channel] server started: http://localhost:${port}`);
  if (lanIp) {
    console.log(`[voice-channel] lan url: http://${lanIp}:${port}`);
    console.log(`[voice-channel] lan websocket: ws://${lanIp}:${port}/channel/voice/ws?token=${token}`);
  }
  console.log(`[voice-channel] websocket: ws://localhost:${port}/channel/voice/ws?token=${token}`);
  console.log(
    `[voice-channel] mode: HOST=${host} ASR_PROVIDER=${asrProvider} ASR_MODEL=${asrModel} ASR_URL=${asrUrl} TTS_MODE=${ttsMode} TTS_URL=${ttsUrl}`
  );
  console.log(
    `[voice-channel] openclaw: enabled=${openclawAdapter.enabled} gatewayBaseUrl=${openclawGatewayBaseUrl || '-'} agentId=${openclawAgentId} chatPath=${openclawChatPath}`
  );
  if (asrProvider === 'browser') {
    console.log(
      '[voice-channel] WARN: browser ASR provider requires client to send input.asr.local text'
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

function parseAsrProvider(value: string | undefined): AsrProvider | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'browser' || normalized === 'local') {
    return 'browser';
  }
  if (normalized === 'aliyun' || normalized === 'cloud') {
    return 'aliyun';
  }
  return null;
}

function createAsrClient(options: {
  provider: AsrProvider;
  model: string;
  apiKey?: string;
  url: string;
  language: string;
  sampleRate: number;
}): RealtimeAsrClient {
  if (options.provider === 'browser') {
    return new BrowserRealtimeAsrClient({ model: options.model });
  }
  if (!options.apiKey) {
    throw new Error('ASR_PROVIDER=aliyun requires SPEECH_API_KEY');
  }
  return new AliyunRealtimeAsrClient({
    apiKey: options.apiKey,
    url: options.url,
    model: options.model,
    language: options.language,
    sampleRate: options.sampleRate
  });
}

function firstLanIpv4(): string | null {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!iface) {
      continue;
    }
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}
