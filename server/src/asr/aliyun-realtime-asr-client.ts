import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AudioChunk } from '../vad/simple-vad.js';
import type { RealtimeAsrClient } from './realtime-asr-client.js';

type InputAudioFormat = 'pcm' | 'opus';

interface RawAliyunAsrEvent {
  type?: string;
  transcript?: string;
  text?: string;
  delta?: string;
  stash?: string;
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

export interface AliyunRealtimeAsrClientOptions {
  apiKey: string;
  url: string;
  model: string;
  language?: string;
  sampleRate?: number;
  timeoutMs?: number;
  reconnectOnce?: boolean;
}

export class AliyunRealtimeAsrClient implements RealtimeAsrClient {
  readonly model: string;

  private readonly language: string;

  private readonly sampleRate: number;

  private readonly timeoutMs: number;

  private reconnectOnce: boolean;

  constructor(private readonly options: AliyunRealtimeAsrClientOptions) {
    this.model = options.model;
    this.language = options.language ?? 'zh';
    this.sampleRate = options.sampleRate ?? 16000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.reconnectOnce = options.reconnectOnce ?? true;
  }

  async transcribe(chunks: AudioChunk[]): Promise<string> {
    if (chunks.length === 0) {
      return '';
    }
    return this.transcribeOnce(chunks, this.reconnectOnce);
  }

  close(): void {
    return;
  }

  private async transcribeOnce(chunks: AudioChunk[], canRetry: boolean): Promise<string> {
    try {
      return await this.runRealtimeSession(chunks);
    } catch (error) {
      if (!canRetry) {
        throw error;
      }
      this.reconnectOnce = false;
      return this.transcribeOnce(chunks, false);
    }
  }

  private runRealtimeSession(chunks: AudioChunk[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const targetUrl = this.normalizeRealtimeUrl();
      const inputAudioFormat = detectInputAudioFormat(chunks);
      const sampleRate = firstSampleRate(chunks) ?? this.sampleRate;
      const ws = new WebSocket(targetUrl, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`
        }
      });

      let settled = false;
      let partialTranscript = '';
      let finalTranscript = '';

      const timer = setTimeout(() => {
        finish(
          new Error(
            `ASR timeout after ${this.timeoutMs}ms (model=${this.model}, format=${inputAudioFormat})`
          )
        );
      }, this.timeoutMs);

      const finish = (error?: Error, text?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // noop
        }

        if (error) {
          reject(error);
          return;
        }
        resolve((text ?? '').trim());
      };

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            event_id: randomUUID(),
            type: 'session.update',
            session: {
              model: this.model,
              input_audio_format: inputAudioFormat,
              sample_rate: sampleRate,
              input_audio_transcription: {
                language: this.language
              },
              turn_detection: null
            }
          })
        );

        for (const chunk of chunks) {
          ws.send(
            JSON.stringify({
              event_id: randomUUID(),
              type: 'input_audio_buffer.append',
              audio: chunk.data.toString('base64')
            })
          );
        }

        ws.send(
          JSON.stringify({
            event_id: randomUUID(),
            type: 'input_audio_buffer.commit'
          })
        );

        ws.send(
          JSON.stringify({
            event_id: randomUUID(),
            type: 'session.finish'
          })
        );
      });

      ws.on('message', (raw) => {
        let event: RawAliyunAsrEvent;
        try {
          event = JSON.parse(raw.toString()) as RawAliyunAsrEvent;
        } catch {
          return;
        }

        if (event.type === 'error') {
          const code = event.error?.code ? ` ${event.error.code}` : '';
          const message = event.error?.message ?? event.message ?? 'Unknown ASR upstream error';
          finish(new Error(`Aliyun realtime ASR error${code}: ${message}`));
          return;
        }

        const text = pickTranscript(event);

        if (event.type === 'conversation.item.input_audio_transcription.text') {
          partialTranscript = (partialTranscript + text).trim();
          return;
        }

        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          finalTranscript = text || partialTranscript;
          finish(undefined, finalTranscript);
          return;
        }

        if (event.type === 'conversation.item.input_audio_transcription.failed') {
          const message = event.message ?? event.error?.message ?? 'ASR transcription failed';
          finish(new Error(`Aliyun realtime ASR failed: ${message}`));
          return;
        }

        if (event.type === 'session.finished') {
          finish(undefined, finalTranscript || partialTranscript);
        }
      });

      ws.on('error', (error) => {
        finish(toError(error));
      });

      ws.on('close', (code, reason) => {
        if (settled) {
          return;
        }

        const text = (finalTranscript || partialTranscript).trim();
        if (text) {
          finish(undefined, text);
          return;
        }

        finish(
          new Error(`Aliyun realtime ASR websocket closed (code=${code}, reason=${String(reason)})`)
        );
      });
    });
  }

  private normalizeRealtimeUrl(): string {
    try {
      const url = new URL(this.options.url);
      if (!url.pathname.includes('/api-ws/v1/realtime')) {
        url.pathname = '/api-ws/v1/realtime';
      }
      if (!url.searchParams.get('model')) {
        url.searchParams.set('model', this.model);
      }
      return url.toString();
    } catch {
      return this.options.url;
    }
  }
}

function pickTranscript(event: RawAliyunAsrEvent): string {
  const text = event.transcript ?? event.text ?? event.delta ?? event.stash ?? '';
  return typeof text === 'string' ? text : '';
}

function detectInputAudioFormat(chunks: AudioChunk[]): InputAudioFormat {
  for (const chunk of chunks) {
    if (chunk.encoding === 'webm_opus') {
      return 'opus';
    }
  }
  return 'pcm';
}

function firstSampleRate(chunks: AudioChunk[]): number | null {
  for (const chunk of chunks) {
    if (typeof chunk.sampleRate === 'number' && chunk.sampleRate > 0) {
      return chunk.sampleRate;
    }
  }
  return null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
