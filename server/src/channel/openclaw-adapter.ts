export interface OpenClawReplyInput {
  sessionId: string;
  text: string;
}

export interface OpenClawAdapter {
  streamAssistantReply(input: OpenClawReplyInput): AsyncGenerator<string>;
}
