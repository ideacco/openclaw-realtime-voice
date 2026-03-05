import type { AudioChunk } from '../vad/simple-vad.js';

export interface RealtimeAsrClient {
  readonly model: string;
  transcribe(chunks: AudioChunk[]): Promise<string>;
  close(): void;
}

export interface MockRealtimeAsrClientOptions {
  model: string;
}

export class MockRealtimeAsrClient implements RealtimeAsrClient {
  readonly model: string;

  constructor(options: MockRealtimeAsrClientOptions) {
    this.model = options.model;
  }

  async transcribe(chunks: AudioChunk[]): Promise<string> {
    if (chunks.length === 0) {
      return '';
    }

    const textFromTag = decodeInlineText(chunks);
    if (textFromTag) {
      return textFromTag;
    }

    const durationMs = estimateDurationMs(chunks);
    return `收到语音输入（约 ${durationMs}ms，${chunks.length} 个音频分片）`;
  }

  close(): void {
    return;
  }
}

function estimateDurationMs(chunks: AudioChunk[]): number {
  let total = 0;
  for (const chunk of chunks) {
    if (chunk.encoding === 'pcm_s16le' && chunk.sampleRate > 0) {
      const samples = chunk.data.length / 2;
      total += Math.round((samples / chunk.sampleRate) * 1000);
      continue;
    }

    total += 250;
  }
  return total;
}

function decodeInlineText(chunks: AudioChunk[]): string | null {
  const merged = Buffer.concat(chunks.map((chunk) => chunk.data));
  const text = merged.toString('utf8').trim();
  if (!text.startsWith('TEXT:')) {
    return null;
  }
  const content = text.slice('TEXT:'.length).trim();
  return content.length > 0 ? content : null;
}
