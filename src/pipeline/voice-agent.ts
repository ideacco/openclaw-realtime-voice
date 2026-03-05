import { EventEmitter } from 'node:events';
import { SentenceSegmenter } from './sentence-segmenter.js';
import type { TtsClient, TtsSessionConfig } from '../tts/aliyun-tts-client.js';

export interface VoiceAgentCallbacks {
  onTextDelta: (text: string) => void;
  onAudioDelta: (base64: string) => void;
  onAudioCompleted: () => void;
  onError: (error: Error) => void;
}

export class VoiceAgent extends EventEmitter {
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ttsClient: TtsClient,
    private readonly segmenter: SentenceSegmenter,
    private readonly callbacks: VoiceAgentCallbacks
  ) {
    super();
    this.bindTtsEvents();
  }

  async startTurn(config: TtsSessionConfig): Promise<void> {
    this.segmenter.reset();
    this.sendChain = Promise.resolve();
    this.ttsClient.updateSession(config);
    await this.ttsClient.connect();
  }

  onToken(token: string): void {
    this.callbacks.onTextDelta(token);
    const sentences = this.segmenter.pushToken(token);
    for (const sentence of sentences) {
      this.enqueueSend(sentence);
    }
  }

  async endTurn(): Promise<void> {
    const tail = this.segmenter.flush();
    for (const sentence of tail) {
      this.enqueueSend(sentence);
    }
    await this.sendChain;
  }

  close(): void {
    this.ttsClient.close();
  }

  private bindTtsEvents(): void {
    this.ttsClient.on('audio.delta', (data) => {
      this.callbacks.onAudioDelta(data);
    });

    this.ttsClient.on('audio.completed', () => {
      this.callbacks.onAudioCompleted();
    });

    this.ttsClient.on('error', (error) => {
      this.callbacks.onError(error);
    });
  }

  private enqueueSend(sentence: string): void {
    this.sendChain = this.sendChain.then(async () => {
      if (!sentence.trim()) {
        return;
      }
      this.ttsClient.sendText(sentence);
    });

    this.sendChain = this.sendChain.catch((error: unknown) => {
      this.callbacks.onError(toError(error));
    });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
