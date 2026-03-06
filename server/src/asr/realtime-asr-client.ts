import type { AudioChunk } from '../vad/simple-vad.js';

export type AsrProvider = 'browser' | 'aliyun';

export interface RealtimeAsrClient {
  readonly model: string;
  transcribe(chunks: AudioChunk[]): Promise<string>;
  close(): void;
}

export interface BrowserRealtimeAsrClientOptions {
  model: string;
}

// Browser local ASR mode:
// recognition text should be pushed from web client via input.asr.local.
// This client intentionally returns empty string if no local text was provided.
export class BrowserRealtimeAsrClient implements RealtimeAsrClient {
  readonly model: string;

  constructor(options: BrowserRealtimeAsrClientOptions) {
    this.model = options.model;
  }

  async transcribe(_chunks: AudioChunk[]): Promise<string> {
    return '';
  }

  close(): void {
    return;
  }
}
