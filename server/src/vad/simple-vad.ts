import type { AudioEncoding } from '../shared/protocol.js';

export interface AudioChunk {
  data: Buffer;
  encoding: AudioEncoding;
  sampleRate: number;
  receivedAt: number;
}

export interface VadEngine {
  push(chunk: AudioChunk): AudioChunk[] | null;
  flush(): AudioChunk[];
  reset(): void;
}

export interface SimpleVadOptions {
  energyThreshold?: number;
  minSpeechChunks?: number;
  maxSilenceChunks?: number;
}

export class SimpleVadEngine implements VadEngine {
  private readonly energyThreshold: number;

  private readonly minSpeechChunks: number;

  private readonly maxSilenceChunks: number;

  private current: AudioChunk[] = [];

  private speechChunks = 0;

  private silenceStreak = 0;

  constructor(options: SimpleVadOptions = {}) {
    this.energyThreshold = options.energyThreshold ?? 0.02;
    this.minSpeechChunks = options.minSpeechChunks ?? 3;
    this.maxSilenceChunks = options.maxSilenceChunks ?? 4;
  }

  push(chunk: AudioChunk): AudioChunk[] | null {
    this.current.push(chunk);

    const hasSpeech = this.isSpeechChunk(chunk);
    if (hasSpeech) {
      this.speechChunks += 1;
      this.silenceStreak = 0;
      return null;
    }

    this.silenceStreak += 1;
    const shouldCut =
      this.speechChunks >= this.minSpeechChunks && this.silenceStreak >= this.maxSilenceChunks;

    if (!shouldCut) {
      return null;
    }

    const segment = [...this.current];
    this.reset();
    return segment;
  }

  flush(): AudioChunk[] {
    if (this.current.length === 0) {
      return [];
    }
    const segment = [...this.current];
    this.reset();
    return segment;
  }

  reset(): void {
    this.current = [];
    this.speechChunks = 0;
    this.silenceStreak = 0;
  }

  private isSpeechChunk(chunk: AudioChunk): boolean {
    if (chunk.encoding !== 'pcm_s16le') {
      return true;
    }

    if (chunk.data.length < 2) {
      return false;
    }

    const samples = Math.floor(chunk.data.length / 2);
    let sum = 0;

    for (let i = 0; i < samples; i += 1) {
      const value = chunk.data.readInt16LE(i * 2) / 32768;
      sum += Math.abs(value);
    }

    const avgEnergy = sum / samples;
    return avgEnergy >= this.energyThreshold;
  }
}
