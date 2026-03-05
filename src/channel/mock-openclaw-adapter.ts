import { setTimeout as delay } from 'node:timers/promises';
import type { OpenClawAdapter, OpenClawReplyInput } from './openclaw-adapter.js';

export class MockOpenClawAdapter implements OpenClawAdapter {
  async *streamAssistantReply(input: OpenClawReplyInput): AsyncGenerator<string> {
    const reply =
      `你刚刚说的是：${input.text}。` +
      '这是通过 OpenClaw Channel Plugin 返回的流式回复。' +
      '如果接入真实 OpenClaw Runtime，这里会输出模型的实时 token。';

    for (const token of [...reply]) {
      yield token;
      await delay(25);
    }
  }
}
