import { EventEmitter } from 'node:events';

export interface AudioServiceClientConfig {
  baseUrl: string;
  wsUrl?: string;
  token: string;
}

export interface ChannelStartedPayload {
  type: 'channel.started' | 'session.started';
  sessionId: string;
  voice?: string;
  sampleRate?: number;
  asrProvider?: string;
  ttsProvider?: string;
  llmEnabled?: boolean;
  llmMode?: 'plugin' | 'gateway';
}

export type AudioServiceEvent =
  | { type: 'connected' }
  | ChannelStartedPayload
  | { type: 'assistant.text.delta'; text: string }
  | { type: 'message.created'; sessionId: string; message: { role: 'user'; content: string } }
  | { type: 'audio.output.delta'; data: string; sampleRate: number }
  | { type: 'audio.output.completed' }
  | { type: 'asr.text'; text: string; isFinal: boolean }
  | { type: 'channel.error'; code: string; message: string; retryable: boolean }
  | { type: 'channel.ended' };

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  off?: (event: string, handler: (...args: any[]) => void) => void;
  addEventListener?: (event: string, handler: (event: any) => void) => void;
  removeEventListener?: (event: string, handler: (event: any) => void) => void;
  binaryType?: string;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

export class AudioServiceClient extends EventEmitter {
  private ws: WebSocketLike | null = null;

  constructor(private readonly config: AudioServiceClientConfig) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.resolveWsUrl();
      const ws = this.makeSocket(wsUrl, reject);
      if (!ws) {
        return;
      }
      let settled = false;

      const fail = (reason: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(
            `Failed to connect audio service websocket (${wsUrl}): ${toError(reason).message}`
          )
        );
      };

      addSocketListener(ws, 'open', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.ws = ws;
        this.bindSocket(ws);
        this.emit('event', { type: 'connected' } as AudioServiceEvent);
        resolve();
      });

      addSocketListener(ws, 'error', (errorLike) => fail(extractSocketError(errorLike)));
      addSocketListener(ws, 'close', (closeLike) => {
        const { code, reason } = extractCloseInfo(closeLike);
        if (!settled) {
          fail(new Error(`connection closed before open (code=${code}, reason=${reason})`));
        }
      });
    });
  }

  startChannel(params: {
    voice: string;
    sampleRate: number;
    inputSampleRate: number;
    clientRole?: 'web' | 'plugin';
  }): void {
    this.send({
      type: 'channel.start',
      voice: params.voice,
      sampleRate: params.sampleRate,
      inputSampleRate: params.inputSampleRate,
      clientRole: params.clientRole
    });
  }

  async startChannelAndWaitAck(
    params: {
      voice: string;
      sampleRate: number;
      inputSampleRate: number;
      clientRole?: 'web' | 'plugin';
    },
    timeoutMs = 10_000
  ): Promise<ChannelStartedPayload> {
    this.startChannel(params);
    return this.waitForChannelStarted(timeoutMs);
  }

  sendText(text: string): void {
    this.send({ type: 'input.text', text });
  }

  sendAssistantText(text: string, sessionId?: string): void {
    this.send({ type: 'input.assistant.text', text, sessionId });
  }

  endChannel(): void {
    this.send({ type: 'channel.end' });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  targetUrl(): string {
    return this.resolveWsUrl();
  }

  private bindSocket(ws: WebSocketLike): void {
    addSocketListener(ws, 'message', (messageLike) => {
      void this.handleIncomingMessage(messageLike);
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('Audio service websocket is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  private waitForChannelStarted(timeoutMs: number): Promise<ChannelStartedPayload> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error('Audio service websocket is not connected'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting channel.started (${timeoutMs}ms)`));
      }, timeoutMs);

      const onEvent = (event: AudioServiceEvent) => {
        if (event.type === 'channel.started' || event.type === 'session.started') {
          finish(undefined, event);
          return;
        }
        if (event.type === 'channel.error') {
          finish(new Error(`Audio service rejected channel.start: [${event.code}] ${event.message}`));
        }
      };

      const onClose = (closeLike: unknown) => {
        const { code, reason } = extractCloseInfo(closeLike);
        finish(new Error(`Websocket closed before channel.started (code=${code}, reason=${reason})`));
      };

      const onError = (error: unknown) => {
        finish(extractSocketError(error));
      };

      const removeClose = addSocketListener(ws, 'close', onClose);
      const removeError = addSocketListener(ws, 'error', onError);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
        removeClose();
        removeError();
      };

      const finish = (error?: Error, payload?: ChannelStartedPayload) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve(payload as ChannelStartedPayload);
      };

      this.on('event', onEvent);
    });
  }

  private makeSocket(wsUrl: string, reject: (reason?: unknown) => void): WebSocketLike | null {
    const ctor = getRuntimeWebSocketCtor();
    if (ctor) {
      const ws = new ctor(wsUrl);
      if ('binaryType' in ws) {
        ws.binaryType = 'arraybuffer';
      }
      return ws;
    }

    reject(
      new Error(
        'No WebSocket implementation found. Use Node.js 22+ (global WebSocket) or install "ws" in plugin directory.'
      )
    );
    return null;
  }

  private async handleIncomingMessage(messageLike: unknown): Promise<void> {
    const raw = await normalizeMessagePayload(messageLike);
    if (!raw) {
      return;
    }

    try {
      const event = JSON.parse(raw) as AudioServiceEvent;
      this.emit('event', event);
    } catch {
      // ignore malformed events
    }
  }

  private resolveWsUrl(): string {
    const origin = (this.config.wsUrl ?? this.config.baseUrl).trim();
    if (!origin) {
      throw new Error('Audio service url is empty');
    }

    let parsed: URL;
    if (/^wss?:\/\//i.test(origin)) {
      parsed = new URL(origin);
    } else if (/^https?:\/\//i.test(origin)) {
      parsed = new URL(origin.replace(/^http/i, (m) => (m.toLowerCase() === 'https' ? 'wss' : 'ws')));
    } else {
      parsed = new URL(`ws://${origin}`);
    }

    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/channel/voice/ws';
    }
    parsed.searchParams.set('token', this.config.token);
    return parsed.toString();
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function getRuntimeWebSocketCtor(): WebSocketCtor | null {
  const ctor = (globalThis as any).WebSocket;
  if (typeof ctor === 'function') {
    return ctor as WebSocketCtor;
  }
  return null;
}

function addSocketListener(
  ws: WebSocketLike,
  event: string,
  handler: (...args: any[]) => void
): () => void {
  if (typeof ws.on === 'function') {
    const wrapped = (...args: any[]) => {
      if (args.length <= 1) {
        handler(args[0]);
        return;
      }
      handler(args);
    };
    ws.on(event, wrapped);
    return () => {
      ws.off?.(event, wrapped);
    };
  }
  if (typeof ws.addEventListener === 'function') {
    const wrapped = (evt: any) => handler(evt);
    ws.addEventListener(event, wrapped);
    return () => {
      ws.removeEventListener?.(event, wrapped);
    };
  }
  return () => undefined;
}

function extractSocketError(errorLike: unknown): Error {
  if (errorLike && typeof errorLike === 'object' && 'error' in (errorLike as any)) {
    return toError((errorLike as any).error);
  }
  return toError(errorLike);
}

function extractCloseInfo(closeLike: unknown): { code: number; reason: string } {
  if (
    closeLike &&
    typeof closeLike === 'object' &&
    'code' in (closeLike as any) &&
    'reason' in (closeLike as any)
  ) {
    const evt = closeLike as any;
    return {
      code: Number(evt.code ?? 1000),
      reason: String(evt.reason ?? '')
    };
  }
  if (Array.isArray(closeLike)) {
    return {
      code: Number(closeLike[0] ?? 1000),
      reason: String(closeLike[1] ?? '')
    };
  }
  return { code: 1000, reason: '' };
}

async function normalizeMessagePayload(messageLike: unknown): Promise<string | null> {
  let payload = messageLike;
  if (payload && typeof payload === 'object' && 'data' in (payload as any)) {
    payload = (payload as any).data;
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8');
  }

  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
  }

  if (payload && typeof (payload as any).text === 'function') {
    try {
      return String(await (payload as any).text());
    } catch {
      return null;
    }
  }

  if (payload === undefined || payload === null) {
    return null;
  }

  return String(payload);
}
