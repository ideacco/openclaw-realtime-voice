import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import {
  encodeServerEvent,
  parseClientEvent,
  type AudioEncoding,
  type ClientEvent,
  type ErrorCode,
  type ServerEvent
} from '../shared/protocol.js';
import { SentenceSegmenter } from '../pipeline/sentence-segmenter.js';
import { VoiceAgent } from '../pipeline/voice-agent.js';
import { AliyunTtsClient, type TtsMode, type TtsSessionConfig } from '../tts/aliyun-tts-client.js';
import { SimpleVadEngine, type AudioChunk } from '../vad/simple-vad.js';
import type { AsrProvider, RealtimeAsrClient } from '../asr/realtime-asr-client.js';
import type { OpenClawAdapter } from './openclaw-adapter.js';

interface VoiceChannelPluginOptions {
  server: Server;
  token: string;
  idleTimeoutMs: number;
  asrProvider: AsrProvider;
  asr: RealtimeAsrClient;
  openclaw: OpenClawAdapter;
  openclawMode: 'plugin' | 'gateway';
  aliyun: {
    apiKey: string;
    url: string;
    model: string;
    voice: string;
    format: 'pcm';
    sampleRate: number;
    mode: TtsMode;
  };
}

interface SessionState {
  sessionId: string;
  ws: WebSocket;
  clientRole: 'web' | 'plugin';
  voiceConfig: TtsSessionConfig;
  inputSampleRate: number;
  agent: VoiceAgent;
  vad: SimpleVadEngine;
  idleTimer: NodeJS.Timeout | null;
  queue: Promise<void>;
  pendingLocalAsrText: string;
  lastLocalAsrFinalText: string;
}

export class VoiceChannelPlugin {
  private readonly wss: WebSocketServer;

  private readonly sessions = new Map<WebSocket, SessionState>();

  constructor(private readonly options: VoiceChannelPluginOptions) {
    this.wss = new WebSocketServer({ noServer: true });

    this.options.server.on('upgrade', (request, socket, head) => {
      if (!this.isVoicePath(request.url)) {
        socket.destroy();
        return;
      }

      if (!this.verifyToken(request.url ?? '/')) {
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

    this.options.asr.close();
    this.wss.close();
  }

  private isVoicePath(urlPath?: string): boolean {
    if (!urlPath) {
      return false;
    }
    return urlPath.startsWith('/channel/voice/ws') || urlPath.startsWith('/ws');
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
      this.sendError(ws, 'BAD_REQUEST', toError(error).message, false);
      return;
    }

    switch (event.type) {
      case 'channel.start':
      case 'session.start':
        await this.onChannelStart(
          ws,
          event.voice,
          event.sampleRate,
          event.type === 'channel.start' ? event.inputSampleRate : undefined,
          event.type === 'channel.start' ? event.clientRole : undefined
        );
        break;
      case 'input.audio.chunk':
        this.onAudioChunk(ws, event.data, event.encoding ?? 'webm_opus', event.sampleRate);
        break;
      case 'input.audio.commit':
        this.onAudioCommit(ws, event.reason ?? 'manual');
        break;
      case 'input.asr.local':
        this.onLocalAsrText(ws, event.text, event.isFinal ?? true);
        break;
      case 'input.text':
        this.onTextInput(ws, event.text, 'user');
        break;
      case 'input.assistant.text':
        this.onAssistantTextInput(ws, event.text, event.sessionId);
        break;
      case 'agent.input.text':
        this.onAssistantTextInput(ws, event.text);
        break;
      case 'channel.end':
      case 'session.end':
        this.onChannelEnd(ws);
        break;
      default:
        this.sendError(ws, 'BAD_REQUEST', 'Unsupported event', false);
    }
  }

  private async onChannelStart(
    ws: WebSocket,
    voice?: string,
    sampleRate?: number,
    inputSampleRate?: number,
    clientRole?: 'web' | 'plugin'
  ): Promise<void> {
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
        this.send(ws, { type: 'assistant.text.delta', sessionId, text });
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

    const state: SessionState = {
      sessionId,
      ws,
      clientRole: clientRole ?? 'web',
      voiceConfig: ttsConfig,
      inputSampleRate: inputSampleRate ?? 16000,
      agent,
      vad: new SimpleVadEngine(),
      idleTimer: null,
      queue: Promise.resolve(),
      pendingLocalAsrText: '',
      lastLocalAsrFinalText: ''
    };

    state.idleTimer = state.clientRole === 'plugin' ? null : this.makeIdleTimer(ws);

    this.sessions.set(ws, state);

    this.send(ws, {
      type: 'channel.started',
      sessionId,
      voice: ttsConfig.voice,
      sampleRate: ttsConfig.sampleRate,
      asrProvider: this.options.asrProvider,
      llmEnabled: true,
      llmMode: this.options.openclawMode
    });
  }

  private onAudioChunk(
    ws: WebSocket,
    base64: string,
    encoding: AudioEncoding,
    sampleRate?: number
  ): void {
    const state = this.sessions.get(ws);
    if (!state) {
      this.sendError(ws, 'BAD_REQUEST', 'Session not started', false);
      return;
    }

    if (this.options.asrProvider === 'browser') {
      this.touch(ws);
      return;
    }

    let data: Buffer;
    try {
      data = Buffer.from(base64, 'base64');
    } catch {
      this.sendError(ws, 'BAD_REQUEST', 'Invalid base64 audio chunk', false, state.sessionId);
      return;
    }

    if (data.length === 0) {
      return;
    }

    const chunk: AudioChunk = {
      data,
      encoding,
      sampleRate: sampleRate ?? state.inputSampleRate,
      receivedAt: Date.now()
    };

    const segment = state.vad.push(chunk);
    this.touch(ws);

    if (segment && segment.length > 0) {
      this.send(ws, {
        type: 'vad.segment',
        sessionId: state.sessionId,
        chunkCount: segment.length,
        reason: 'vad'
      });
      this.enqueue(state, async () => {
        await this.processSpeechSegment(state, segment, 'vad');
      });
    }
  }

  private onAudioCommit(ws: WebSocket, reason: 'manual' | 'vad'): void {
    const state = this.sessions.get(ws);
    if (!state) {
      this.sendError(ws, 'BAD_REQUEST', 'Session not started', false);
      return;
    }

    if (this.options.asrProvider === 'browser') {
      this.touch(ws);
      return;
    }

    const segment = state.vad.flush();
    if (segment.length === 0) {
      return;
    }

    this.send(ws, {
      type: 'vad.segment',
      sessionId: state.sessionId,
      chunkCount: segment.length,
      reason
    });

    this.enqueue(state, async () => {
      await this.processSpeechSegment(state, segment, reason);
    });
  }

  private onTextInput(ws: WebSocket, text: string, source: 'user' | 'assistant'): void {
    const state = this.sessions.get(ws);
    if (!state) {
      this.sendError(ws, 'BAD_REQUEST', 'Session not started', false);
      return;
    }

    this.enqueue(state, async () => {
      const normalized = text.trim();
      if (!normalized) {
        return;
      }
      if (source === 'assistant') {
        await this.processAssistantText(state, normalized);
        return;
      }
      await this.processUserText(state, normalized, 'text');
    });
  }

  private onAssistantTextInput(ws: WebSocket, text: string, targetSessionId?: string): void {
    const senderState = this.sessions.get(ws);
    if (!senderState) {
      this.sendError(ws, 'BAD_REQUEST', 'Session not started', false);
      return;
    }

    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    const targetState = targetSessionId ? this.findSessionById(targetSessionId) : senderState;
    if (!targetState) {
      this.sendError(
        ws,
        'BAD_REQUEST',
        `Target session not found: ${targetSessionId}`,
        false,
        senderState.sessionId
      );
      return;
    }

    this.enqueue(targetState, async () => {
      await this.processAssistantText(targetState, normalized);
    });
  }

  private onLocalAsrText(ws: WebSocket, text: string, isFinal: boolean): void {
    const state = this.sessions.get(ws);
    if (!state) {
      this.sendError(ws, 'BAD_REQUEST', 'Session not started', false);
      return;
    }
    if (this.options.asrProvider !== 'browser') {
      return;
    }

    const next = text.trim();
    if (!next) {
      return;
    }

    this.touch(ws);

    if (!isFinal) {
      if (state.pendingLocalAsrText === next) {
        return;
      }
      state.pendingLocalAsrText = next;
      this.emitAsrText(state, next, false);
      return;
    }

    if (state.lastLocalAsrFinalText === next) {
      return;
    }

    state.lastLocalAsrFinalText = next;
    state.pendingLocalAsrText = '';
    this.emitAsrText(state, next, true);

    this.enqueue(state, async () => {
      await this.processUserText(state, next, 'asr');
    });
  }

  private onChannelEnd(ws: WebSocket): void {
    const state = this.sessions.get(ws);
    if (!state) {
      return;
    }
    this.send(ws, { type: 'channel.ended', sessionId: state.sessionId });
    this.cleanupSession(state);
  }

  private enqueue(state: SessionState, task: () => Promise<void>): void {
    state.queue = state.queue
      .then(async () => {
        await task();
      })
      .catch((error) => {
        const message = toError(error).message;
        const code: ErrorCode = isUpstreamFailure(message) ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR';
        this.sendError(state.ws, code, message, true, state.sessionId);
      });
  }

  private async processSpeechSegment(
    state: SessionState,
    chunks: AudioChunk[],
    _reason: 'manual' | 'vad'
  ): Promise<void> {
    if (this.options.asrProvider === 'browser') {
      return;
    }

    const text = (await this.options.asr.transcribe(chunks)).trim();
    if (!text) {
      return;
    }

    this.emitAsrText(state, text, true);

    await this.processUserText(state, text, 'asr');
  }

  private async processUserText(
    state: SessionState,
    text: string,
    source: 'text' | 'asr'
  ): Promise<void> {
    if (!text) {
      return;
    }

    this.touch(state.ws);

    const createdEvent: ServerEvent = {
      type: 'message.created',
      sessionId: state.sessionId,
      message: {
        role: 'user',
        content: text
      }
    };
    this.send(state.ws, createdEvent);

    if (this.options.openclawMode === 'plugin' && state.clientRole === 'web') {
      for (const peer of this.sessions.values()) {
        if (peer === state || peer.clientRole !== 'plugin') {
          continue;
        }
        this.send(peer.ws, createdEvent);
        this.touch(peer.ws);
      }
    }

    if (this.options.openclawMode !== 'gateway') {
      // In channel-plugin mode, OpenClaw reply is produced by the OpenClaw channel plugin
      // and pushed back as input.assistant.text. The audio service does not call OpenClaw directly.
      return;
    }

    await state.agent.startTurn(state.voiceConfig);

    for await (const token of this.options.openclaw.streamAssistantReply({
      sessionId: state.sessionId,
      text
    })) {
      state.agent.onToken(token);
    }

    await state.agent.endTurn();
  }

  private async processAssistantText(state: SessionState, text: string): Promise<void> {
    if (!text) {
      return;
    }

    this.touch(state.ws);
    await state.agent.startTurn(state.voiceConfig);

    for (const token of [...text]) {
      state.agent.onToken(token);
    }

    await state.agent.endTurn();
  }

  private createTtsClient(): AliyunTtsClient {
    return new AliyunTtsClient({
      apiKey: this.options.aliyun.apiKey,
      url: this.options.aliyun.url,
      reconnectOnce: true
    });
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
    if (!state.idleTimer) {
      return;
    }
    clearTimeout(state.idleTimer);
    state.idleTimer = this.makeIdleTimer(ws);
  }

  private cleanupSession(state: SessionState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    state.vad.reset();
    state.agent.close();
    this.sessions.delete(state.ws);
  }

  private emitAsrText(state: SessionState, text: string, isFinal: boolean): void {
    const event: ServerEvent = {
      type: 'asr.text',
      sessionId: state.sessionId,
      text,
      isFinal
    };

    this.send(state.ws, event);
    if (this.options.openclawMode !== 'plugin' || !isFinal || state.clientRole === 'plugin') {
      return;
    }

    for (const peer of this.sessions.values()) {
      if (peer === state || peer.clientRole !== 'plugin') {
        continue;
      }
      this.send(peer.ws, event);
      this.touch(peer.ws);
    }
  }

  private findSessionById(sessionId: string): SessionState | null {
    for (const state of this.sessions.values()) {
      if (state.sessionId === sessionId) {
        return state;
      }
    }
    return null;
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
      type: 'channel.error',
      sessionId,
      code,
      message,
      retryable
    });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isUpstreamFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('aliyun') ||
    text.includes('openclaw') ||
    text.includes('websocket') ||
    text.includes('chat request') ||
    text.includes('transcription')
  );
}
