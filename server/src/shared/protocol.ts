export type ErrorCode =
  | 'BAD_REQUEST'
  | 'AUTH_FAILED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export type AudioEncoding = 'pcm_s16le' | 'webm_opus';

export interface SessionStartEvent {
  type: 'session.start';
  voice?: string;
  sampleRate?: number;
}

export interface AgentInputTextEvent {
  type: 'agent.input.text';
  text: string;
}

export interface SessionEndEvent {
  type: 'session.end';
}

export interface ChannelStartEvent {
  type: 'channel.start';
  voice?: string;
  sampleRate?: number;
  inputSampleRate?: number;
}

export interface InputAudioChunkEvent {
  type: 'input.audio.chunk';
  data: string;
  encoding?: AudioEncoding;
  sampleRate?: number;
}

export interface InputAudioCommitEvent {
  type: 'input.audio.commit';
  reason?: 'manual' | 'vad';
}

export interface InputAsrLocalEvent {
  type: 'input.asr.local';
  text: string;
  isFinal?: boolean;
}

export interface InputTextEvent {
  type: 'input.text';
  text: string;
}

export interface InputAssistantTextEvent {
  type: 'input.assistant.text';
  text: string;
}

export interface ChannelEndEvent {
  type: 'channel.end';
}

export type ClientEvent =
  | SessionStartEvent
  | AgentInputTextEvent
  | SessionEndEvent
  | ChannelStartEvent
  | InputAudioChunkEvent
  | InputAudioCommitEvent
  | InputAsrLocalEvent
  | InputTextEvent
  | InputAssistantTextEvent
  | ChannelEndEvent;

export interface AgentTextDeltaEvent {
  type: 'agent.text.delta';
  sessionId: string;
  text: string;
}

export interface AssistantTextDeltaEvent {
  type: 'assistant.text.delta';
  sessionId: string;
  text: string;
}

export interface AsrTextEvent {
  type: 'asr.text';
  sessionId: string;
  text: string;
  isFinal: boolean;
}

export interface VadSegmentEvent {
  type: 'vad.segment';
  sessionId: string;
  chunkCount: number;
  reason: 'manual' | 'vad';
}

export interface MessageCreatedEvent {
  type: 'message.created';
  sessionId: string;
  message: {
    role: 'user';
    content: string;
  };
}

export interface AudioOutputDeltaEvent {
  type: 'audio.output.delta';
  sessionId: string;
  data: string;
  sampleRate: number;
  format: 'pcm';
}

export interface AudioOutputCompletedEvent {
  type: 'audio.output.completed';
  sessionId: string;
}

export interface SessionErrorEvent {
  type: 'session.error';
  sessionId?: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ChannelErrorEvent {
  type: 'channel.error';
  sessionId?: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface SessionStartedEvent {
  type: 'session.started';
  sessionId: string;
  voice: string;
  sampleRate: number;
}

export interface ChannelStartedEvent {
  type: 'channel.started';
  sessionId: string;
  voice: string;
  sampleRate: number;
  asrProvider?: 'browser' | 'aliyun';
  llmEnabled?: boolean;
  llmMode?: 'plugin' | 'gateway';
}

export interface SessionEndedEvent {
  type: 'session.ended';
  sessionId: string;
}

export interface ChannelEndedEvent {
  type: 'channel.ended';
  sessionId: string;
}

export type ServerEvent =
  | SessionStartedEvent
  | ChannelStartedEvent
  | AgentTextDeltaEvent
  | AssistantTextDeltaEvent
  | AsrTextEvent
  | VadSegmentEvent
  | MessageCreatedEvent
  | AudioOutputDeltaEvent
  | AudioOutputCompletedEvent
  | SessionErrorEvent
  | ChannelErrorEvent
  | SessionEndedEvent
  | ChannelEndedEvent;

export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseClientEvent(raw: string): ClientEvent {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON payload');
  }

  const event = parsed as Record<string, unknown>;
  if (typeof event.type !== 'string') {
    throw new Error('Missing event type');
  }

  switch (event.type) {
    case 'session.start':
      return parseSessionStart(event);
    case 'agent.input.text': {
      if (typeof event.text !== 'string' || !event.text.trim()) {
        throw new Error('agent.input.text.text is required');
      }
      return {
        type: 'agent.input.text',
        text: event.text
      };
    }
    case 'session.end':
      return { type: 'session.end' };
    case 'channel.start':
      return parseChannelStart(event);
    case 'input.audio.chunk': {
      if (typeof event.data !== 'string' || event.data.length === 0) {
        throw new Error('input.audio.chunk.data is required');
      }
      const encoding = parseAudioEncoding(event.encoding);
      if (event.sampleRate !== undefined && typeof event.sampleRate !== 'number') {
        throw new Error('input.audio.chunk.sampleRate must be number');
      }
      return {
        type: 'input.audio.chunk',
        data: event.data,
        encoding,
        sampleRate: event.sampleRate as number | undefined
      };
    }
    case 'input.audio.commit': {
      if (event.reason !== undefined && event.reason !== 'manual' && event.reason !== 'vad') {
        throw new Error('input.audio.commit.reason must be manual or vad');
      }
      return {
        type: 'input.audio.commit',
        reason: event.reason as 'manual' | 'vad' | undefined
      };
    }
    case 'input.asr.local': {
      if (typeof event.text !== 'string' || !event.text.trim()) {
        throw new Error('input.asr.local.text is required');
      }
      if (event.isFinal !== undefined && typeof event.isFinal !== 'boolean') {
        throw new Error('input.asr.local.isFinal must be boolean');
      }
      return {
        type: 'input.asr.local',
        text: event.text,
        isFinal: event.isFinal as boolean | undefined
      };
    }
    case 'input.text': {
      if (typeof event.text !== 'string' || !event.text.trim()) {
        throw new Error('input.text.text is required');
      }
      return {
        type: 'input.text',
        text: event.text
      };
    }
    case 'input.assistant.text': {
      if (typeof event.text !== 'string' || !event.text.trim()) {
        throw new Error('input.assistant.text.text is required');
      }
      return {
        type: 'input.assistant.text',
        text: event.text
      };
    }
    case 'channel.end':
      return { type: 'channel.end' };
    default:
      throw new Error(`Unsupported event type: ${event.type}`);
  }
}

function parseSessionStart(event: Record<string, unknown>): SessionStartEvent {
  if (event.voice !== undefined && typeof event.voice !== 'string') {
    throw new Error('session.start.voice must be string');
  }
  if (event.sampleRate !== undefined && typeof event.sampleRate !== 'number') {
    throw new Error('session.start.sampleRate must be number');
  }
  return {
    type: 'session.start',
    voice: event.voice as string | undefined,
    sampleRate: event.sampleRate as number | undefined
  };
}

function parseChannelStart(event: Record<string, unknown>): ChannelStartEvent {
  if (event.voice !== undefined && typeof event.voice !== 'string') {
    throw new Error('channel.start.voice must be string');
  }
  if (event.sampleRate !== undefined && typeof event.sampleRate !== 'number') {
    throw new Error('channel.start.sampleRate must be number');
  }
  if (event.inputSampleRate !== undefined && typeof event.inputSampleRate !== 'number') {
    throw new Error('channel.start.inputSampleRate must be number');
  }

  return {
    type: 'channel.start',
    voice: event.voice as string | undefined,
    sampleRate: event.sampleRate as number | undefined,
    inputSampleRate: event.inputSampleRate as number | undefined
  };
}

function parseAudioEncoding(input: unknown): AudioEncoding | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === 'pcm_s16le' || input === 'webm_opus') {
    return input;
  }
  throw new Error('input.audio.chunk.encoding must be pcm_s16le or webm_opus');
}

export function encodeServerEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}
