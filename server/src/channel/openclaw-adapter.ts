export interface OpenClawReplyInput {
  sessionId: string;
  text: string;
}

export interface OpenClawAdapter {
  readonly enabled: boolean;
  streamAssistantReply(input: OpenClawReplyInput): AsyncGenerator<string>;
}

export class DisabledOpenClawAdapter implements OpenClawAdapter {
  readonly enabled = false;

  async *streamAssistantReply(_input: OpenClawReplyInput): AsyncGenerator<string> {
    throw new Error(
      'OpenClaw adapter is disabled. Configure OPENCLAW_GATEWAY_BASE_URL to enable user input -> OpenClaw -> TTS flow.'
    );
  }
}
