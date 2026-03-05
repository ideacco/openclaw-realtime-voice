import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface AudioServiceClientConfig {
  baseUrl: string;
  token: string;
}

export type AudioServiceEvent =
  | { type: 'connected' }
  | { type: 'channel.started'; sessionId: string }
  | { type: 'assistant.text.delta'; text: string }
  | { type: 'audio.output.delta'; data: string; sampleRate: number }
  | { type: 'audio.output.completed' }
  | { type: 'asr.text'; text: string; isFinal: boolean }
  | { type: 'channel.error'; code: string; message: string; retryable: boolean }
  | { type: 'channel.ended' };

export class AudioServiceClient extends EventEmitter {
  private ws: WebSocket | null = null;

  constructor(private readonly config: AudioServiceClientConfig) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.baseUrl.replace(/^http/, 'ws') + `/channel/voice/ws?token=${encodeURIComponent(this.config.token)}`;
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        this.ws = ws;
        this.bindSocket(ws);
        this.emit('event', { type: 'connected' } as AudioServiceEvent);
        resolve();
      });

      ws.on('error', () => reject(new Error('Failed to connect audio service websocket')));
    });
  }

  startChannel(params: { voice: string; sampleRate: number; inputSampleRate: number }): void {
    this.send({
      type: 'channel.start',
      voice: params.voice,
      sampleRate: params.sampleRate,
      inputSampleRate: params.inputSampleRate
    });
  }

  sendText(text: string): void {
    this.send({ type: 'input.text', text });
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

  private bindSocket(ws: WebSocket): void {
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(String(data)) as AudioServiceEvent;
        this.emit('event', event);
      } catch {
        // ignore malformed events
      }
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Audio service websocket is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }
}
