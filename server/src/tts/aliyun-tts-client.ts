import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type TtsMode = 'server_commit' | 'commit';

export interface TtsSessionConfig {
  model: string;
  voice: string;
  format: 'pcm';
  sampleRate: number;
  mode: TtsMode;
}

export interface TtsClientEvents {
  'audio.delta': (base64Audio: string) => void;
  'audio.completed': () => void;
  error: (error: Error) => void;
  close: () => void;
}

export interface TtsClient {
  connect(): Promise<void>;
  updateSession(config: TtsSessionConfig): void;
  sendText(text: string): void;
  commitInput(): void;
  close(): void;
  on<E extends keyof TtsClientEvents>(event: E, listener: TtsClientEvents[E]): this;
  off<E extends keyof TtsClientEvents>(event: E, listener: TtsClientEvents[E]): this;
}

interface RawAliyunEvent {
  type?: string;
  data?: string;
  delta?: string;
  audio?: {
    data?: string;
    delta?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

export interface AliyunTtsClientOptions {
  apiKey: string;
  url: string;
  reconnectOnce?: boolean;
}

export class AliyunTtsClient extends EventEmitter implements TtsClient {
  private ws: WebSocket | null = null;

  private config: TtsSessionConfig | null = null;

  private reconnectOnce: boolean;

  private connected = false;

  constructor(private readonly options: AliyunTtsClientOptions) {
    super();
    this.reconnectOnce = options.reconnectOnce ?? true;
  }

  async connect(): Promise<void> {
    if (this.ws && this.connected) {
      return;
    }

    await this.openSocket();

    if (this.config) {
      this.sendSessionUpdate(this.config);
    }
  }

  updateSession(config: TtsSessionConfig): void {
    this.config = config;
    if (this.ws && this.connected) {
      this.sendSessionUpdate(config);
    }
  }

  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Aliyun websocket is not connected');
    }

    if (!this.config) {
      throw new Error('TTS session config is not initialized');
    }

    this.ws.send(
      JSON.stringify({
        event_id: randomUUID(),
        type: 'input_text_buffer.append',
        text
      })
    );

    if (this.config.mode === 'commit') {
      this.commitInput();
    }
  }

  commitInput(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        event_id: randomUUID(),
        type: 'input_text_buffer.commit'
      })
    );
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private async openSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const targetUrl = this.normalizeRealtimeUrl();
      const ws = new WebSocket(targetUrl, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`
        }
      });

      ws.on('open', () => {
        this.ws = ws;
        this.connected = true;
        this.bindSocketEvents(ws);
        resolve();
      });

      ws.on('error', (error) => {
        reject(error);
      });
    });
  }

  private bindSocketEvents(ws: WebSocket): void {
    ws.on('message', (raw) => {
      const decoded = raw.toString();
      let event: RawAliyunEvent;
      try {
        event = JSON.parse(decoded) as RawAliyunEvent;
      } catch {
        return;
      }

      if (event.type === 'error') {
        const code = event.error?.code ? ` ${event.error.code}` : '';
        const message = event.error?.message ?? event.message ?? 'Unknown upstream error';
        this.emit('error', new Error(`Aliyun realtime error${code}: ${message}`));
        return;
      }

      const audioDelta = event.delta ?? event.audio?.delta ?? event.data ?? event.audio?.data;
      if ((event.type === 'response.audio.delta' || event.type === 'audio.delta') && audioDelta) {
        this.emit('audio.delta', audioDelta);
      }

      if (
        event.type === 'response.audio.done' ||
        event.type === 'audio.completed' ||
        event.type === 'response.done'
      ) {
        this.emit('audio.completed');
      }
    });

    ws.on('close', () => {
      const shouldReconnect = this.reconnectOnce;
      this.connected = false;
      this.ws = null;
      this.emit('close');
      if (shouldReconnect) {
        this.reconnectOnce = false;
        void this.connect().catch((error) => {
          this.emit('error', toError(error));
        });
      }
    });

    ws.on('error', (error) => {
      this.emit('error', toError(error));
    });
  }

  private sendSessionUpdate(config: TtsSessionConfig): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        event_id: randomUUID(),
        type: 'session.update',
        session: {
          model: config.model,
          voice: config.voice,
          response_format: config.format,
          sample_rate: config.sampleRate,
          mode: config.mode
        }
      })
    );
  }

  private normalizeRealtimeUrl(): string {
    try {
      const url = new URL(this.options.url);
      if (!url.pathname.includes('/api-ws/v1/realtime')) {
        url.pathname = '/api-ws/v1/realtime';
      }
      if (this.config?.model && !url.searchParams.get('model')) {
        url.searchParams.set('model', this.config.model);
      }
      return url.toString();
    } catch {
      return this.options.url;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
