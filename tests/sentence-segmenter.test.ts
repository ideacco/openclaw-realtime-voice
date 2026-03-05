import { describe, expect, it } from 'vitest';
import { SentenceSegmenter } from '../src/pipeline/sentence-segmenter.js';

describe('SentenceSegmenter', () => {
  it('flushes on punctuation', () => {
    const segmenter = new SentenceSegmenter();
    const out1 = segmenter.pushToken('你');
    const out2 = segmenter.pushToken('好');
    const out3 = segmenter.pushToken('。');

    expect(out1).toEqual([]);
    expect(out2).toEqual([]);
    expect(out3).toEqual(['你好。']);
  });

  it('flushes on max length', () => {
    const segmenter = new SentenceSegmenter({ maxChars: 5 });
    const out = segmenter.pushToken('hello');
    expect(out).toEqual(['hello']);
  });

  it('flushes on time window when text is long enough', () => {
    const segmenter = new SentenceSegmenter({ timeWindowMs: 100, minCharsForTimeFlush: 3 });
    segmenter.pushToken('你', 0);
    segmenter.pushToken('好', 10);
    const out = segmenter.pushToken('啊', 120);
    expect(out).toEqual(['你好啊']);
  });

  it('flush returns tail buffer', () => {
    const segmenter = new SentenceSegmenter();
    segmenter.pushToken('A');
    segmenter.pushToken('B');
    expect(segmenter.flush()).toEqual(['AB']);
    expect(segmenter.flush()).toEqual([]);
  });
});
