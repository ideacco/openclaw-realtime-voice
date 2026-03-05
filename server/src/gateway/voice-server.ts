import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import {
  encodeServerEvent,
  parseClientEvent,
  type ClientEvent,
  type ErrorCode,
  type ServerEvent
} from '../shared/protocol.js';
import { SentenceSegmenter } from '../pipeline/sentence-segmenter.js';
import { VoiceAgent } from '../pipeline/voice-agent.js';
import { AliyunTtsClient, type TtsMode, type TtsSessionConfig } from '../tts/aliyun-tts-client.js';
import { MockTtsClient } from '../tts/mock-tts-client.js';

interface VoiceServerOptions {
  server: Server;
  token: string;
  idleTimeoutMs: number;
  aliyun: {
    apiKey?: string;
    url: string;
    model: string;
    voice: string;
    format: 'pcm';
    sampleRate: number;
    mode: TtsMode;
  };
  useMockTts: boolean;
}

interface SessionState {
  sessionId: string;
  ws: WebSocket;
  voiceConfig: TtsSessionConfig;
  agent: VoiceAgent;
  idleTimer: NodeJS.Timeout;
}

export class VoiceServer {
  private readonly wss: WebSocketServer;

  private readonly sessions = new Map<WebSocket, SessionState>();

  constructor(private readonly options: VoiceServerOptions) {
    this.wss = new WebSocketServer({ noServer: true });

    this.options.server.on('upgrade', (request, socket, head) => {
      if (request.url?.startsWith('/ws') !== true) {
        socket.destroy();
        return;
      }

      if (!this.verifyToken(request.url)) {
        socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws);
      });
    });

    this.wss.on('connection', (ws) => {
      this.handleConnection(ws);
    });
  }

  close(): void {
    for (const state of this.sessions.values()) {
      this.cleanupSession(state);
    }
    this.wss.close();
  }

  private verifyToken(urlPath: string): boolean {
    const url = new URL(urlPath, 'http://localhost');
    const token = url.searchParams.get('token');
    return token === this.options.token;
  }

  private handleConnection(ws: WebSocket): void {
    ws.on('message', (raw) => {
      void this.handleRawMessage(ws, raw.toString());
    });

    ws.on('close', () => {
      const state = this.sessions.get(ws);
      if (state) {
        this.cleanupSession(state);
      }
    });
  }

  private async handleRawMessage(ws: WebSocket, raw: string): Promise<void> {
    let event: ClientEvent;
    try {
      event = parseClientEvent(raw);
    } catch (error) {
      this.sendError(ws, 'BAD_REQUEST', error instanceof Error ? error.message : 'Bad request', false);
      return;
    }

    switch (event.type) {
      case 'session.start':
        await this.onSessionStart(ws, event.voice, event.sampleRate);
        break;
      case 'agent.input.text':
        await this.onAgentInputText(ws, event.text);
        break;
      case 'session.end':
        this.onSessionEnd(ws);
        break;
      default:
        this.sendError(ws, 'BAD_REQUEST', 'Unsupported event', false);
    }
  }

  private async onSessionStart(ws: WebSocket, voice?: string, sampleRate?: number): Promise<void> {
    const existing = this.sessions.get(ws);
    if (existing) {
      this.cleanupSession(existing);
    }

    const sessionId = randomUUID();
    const ttsConfig: TtsSessionConfig = {
      model: this.options.aliyun.model,
      voice: voice ?? this.options.aliyun.voice,
      format: this.options.aliyun.format,
      sampleRate: sampleRate ?? this.options.aliyun.sampleRate,
      mode: this.options.aliyun.mode
    };

    const ttsClient = this.createTtsClient();
    const agent = new VoiceAgent(ttsClient, new SentenceSegmenter(), {
      onTextDelta: (text) => {
        this.send(ws, { type: 'agent.text.delta', sessionId, text });
        this.touch(ws);
      },
      onAudioDelta: (data) => {
        this.send(ws, {
          type: 'audio.output.delta',
          sessionId,
          data,
          sampleRate: ttsConfig.sampleRate,
          format: 'pcm'
        });
        this.touch(ws);
      },
      onAudioCompleted: () => {
        this.send(ws, { type: 'audio.output.completed', sessionId });
        this.touch(ws);
      },
      onError: (error) => {
        this.sendError(ws, 'UPSTREAM_ERROR', error.message, true, sessionId);
      }
    });

    const idleTimer = this.makeIdleTimer(ws);
    const state: SessionState = {
      sessionId,
      ws,
      voiceConfig: ttsConfig,
      agent,
      idleTimer
    };

    this.sessions.set(ws, state);

    try {
      await agent.startTurn(ttsConfig);
      this.send(ws, {
        type: 'session.started',
        sessionId,
        voice: ttsConfig.voice,
        sampleRate: ttsConfig.sampleRate
      });
    } catch (error) {
      this.sendError(ws, 'UPSTREAM_ERROR', toError(error).message, true, sessionId);
    }
  }

  private async onAgentInputText(ws: WebSocket, text: string): Promise<void> {
    const state = this.sessions.get(ws);
    if (!state) {
      this.sendError(ws, 'BAD_REQUEST', 'Session not started', false);
      return;
    }

    this.touch(ws);

    try {
      for await (const token of mockOpenClawStream(text)) {
        state.agent.onToken(token);
      }
      await state.agent.endTurn();
    } catch (error) {
      this.sendError(ws, 'INTERNAL_ERROR', toError(error).message, true, state.sessionId);
    }
  }

  private onSessionEnd(ws: WebSocket): void {
    const state = this.sessions.get(ws);
    if (!state) {
      return;
    }
    this.send(ws, { type: 'session.ended', sessionId: state.sessionId });
    this.cleanupSession(state);
  }

  private makeIdleTimer(ws: WebSocket): NodeJS.Timeout {
    return setTimeout(() => {
      const state = this.sessions.get(ws);
      if (!state) {
        return;
      }
      this.sendError(ws, 'TIMEOUT', 'Session idle timeout', false, state.sessionId);
      this.cleanupSession(state);
      ws.close();
    }, this.options.idleTimeoutMs);
  }

  private touch(ws: WebSocket): void {
    const state = this.sessions.get(ws);
    if (!state) {
      return;
    }
    clearTimeout(state.idleTimer);
    state.idleTimer = this.makeIdleTimer(ws);
  }

  private createTtsClient(): AliyunTtsClient | MockTtsClient {
    if (this.options.useMockTts || !this.options.aliyun.apiKey) {
      return new MockTtsClient();
    }

    return new AliyunTtsClient({
      apiKey: this.options.aliyun.apiKey,
      url: this.options.aliyun.url,
      reconnectOnce: true
    });
  }

  private cleanupSession(state: SessionState): void {
    clearTimeout(state.idleTimer);
    state.agent.close();
    this.sessions.delete(state.ws);
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    ws.send(encodeServerEvent(event));
  }

  private sendError(
    ws: WebSocket,
    code: ErrorCode,
    message: string,
    retryable: boolean,
    sessionId?: string
  ): void {
    this.send(ws, {
      type: 'session.error',
      sessionId,
      code,
      message,
      retryable
    });
  }
}

async function* mockOpenClawStream(text: string): AsyncGenerator<string> {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }

  const chars = [...normalized];
  for (const token of chars) {
    yield token;
    await delay(35);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
