export interface SentenceSegmenterOptions {
  punctuation?: string[];
  maxChars?: number;
  timeWindowMs?: number;
  minCharsForTimeFlush?: number;
}

const DEFAULT_PUNCTUATION = ['。', '！', '？', '；', '.', '!', '?', ';', ','];

export class SentenceSegmenter {
  private buffer = '';

  private lastEmitAt = 0;

  private readonly punctuation: Set<string>;

  private readonly maxChars: number;

  private readonly timeWindowMs: number;

  private readonly minCharsForTimeFlush: number;

  constructor(options: SentenceSegmenterOptions = {}) {
    this.punctuation = new Set(options.punctuation ?? DEFAULT_PUNCTUATION);
    this.maxChars = options.maxChars ?? 40;
    this.timeWindowMs = options.timeWindowMs ?? 180;
    this.minCharsForTimeFlush = options.minCharsForTimeFlush ?? 8;
  }

  pushToken(token: string, now: number = Date.now()): string[] {
    if (!token) {
      return [];
    }
    if (this.lastEmitAt === 0) {
      this.lastEmitAt = now;
    }

    this.buffer += token;
    const out: string[] = [];
    const trimmed = this.buffer.trim();
    if (!trimmed) {
      return out;
    }

    const lastChar = trimmed.at(-1);
    const punctTriggered = !!lastChar && this.punctuation.has(lastChar);
    const lengthTriggered = trimmed.length >= this.maxChars;
    const timeTriggered =
      now - this.lastEmitAt >= this.timeWindowMs &&
      trimmed.length >= this.minCharsForTimeFlush;

    if (punctTriggered || lengthTriggered || timeTriggered) {
      out.push(trimmed);
      this.buffer = '';
      this.lastEmitAt = now;
    }

    return out;
  }

  flush(now: number = Date.now()): string[] {
    const trimmed = this.buffer.trim();
    if (!trimmed) {
      return [];
    }
    this.buffer = '';
    this.lastEmitAt = now;
    return [trimmed];
  }

  reset(): void {
    this.buffer = '';
    this.lastEmitAt = 0;
  }
}
