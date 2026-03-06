import { EventEmitter } from 'node:events';
import type { TtsClient, TtsSessionConfig } from './aliyun-tts-client.js';

export class NoopTtsClient extends EventEmitter implements TtsClient {
  private connected = false;

  private config: TtsSessionConfig | null = null;

  async connect(): Promise<void> {
    this.connected = true;
  }

  updateSession(config: TtsSessionConfig): void {
    this.config = config;
  }

  sendText(_text: string): void {
    if (!this.connected || !this.config) {
      throw new Error('Noop TTS session is not initialized');
    }
  }

  commitInput(): void {
    this.emit('audio.completed');
  }

  close(): void {
    this.connected = false;
    this.config = null;
  }
}
