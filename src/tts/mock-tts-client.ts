import { EventEmitter } from 'node:events';
import type { TtsClient, TtsClientEvents, TtsSessionConfig } from './aliyun-tts-client.js';

const CHUNK_MS = 120;

export class MockTtsClient extends EventEmitter implements TtsClient {
  private sampleRate = 24000;

  async connect(): Promise<void> {
    return;
  }

  updateSession(config: TtsSessionConfig): void {
    this.sampleRate = config.sampleRate;
  }

  sendText(text: string): void {
    if (!text.trim()) {
      return;
    }

    const chunks = Math.max(1, Math.ceil(text.length / 10));
    for (let i = 0; i < chunks; i += 1) {
      const frequency = 420 + i * 25;
      const pcm = createSinePcm16Base64(this.sampleRate, CHUNK_MS, frequency);
      setTimeout(() => {
        this.emit('audio.delta', pcm);
        if (i === chunks - 1) {
          this.emit('audio.completed');
        }
      }, i * CHUNK_MS);
    }
  }

  commitInput(): void {
    return;
  }

  close(): void {
    this.emit('close');
  }

  override on<E extends keyof TtsClientEvents>(event: E, listener: TtsClientEvents[E]): this {
    return super.on(event, listener);
  }

  override off<E extends keyof TtsClientEvents>(event: E, listener: TtsClientEvents[E]): this {
    return super.off(event, listener);
  }
}

function createSinePcm16Base64(sampleRate: number, durationMs: number, frequency: number): string {
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.allocUnsafe(sampleCount * 2);

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const amplitude = Math.sin(2 * Math.PI * frequency * t) * 0.25;
    const sample = Math.max(-1, Math.min(1, amplitude));
    const pcm = Math.round(sample * 32767);
    buffer.writeInt16LE(pcm, i * 2);
  }

  return buffer.toString('base64');
}
