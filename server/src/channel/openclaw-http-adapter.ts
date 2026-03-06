import { TextDecoder } from 'node:util';
import type { OpenClawAdapter, OpenClawReplyInput } from './openclaw-adapter.js';

interface OpenAIChatDelta {
  content?: string | Array<{ type?: string; text?: string }>;
}

interface OpenAIChatChunk {
  choices?: Array<{
    delta?: OpenAIChatDelta;
    finish_reason?: string | null;
  }>;
}

export interface OpenClawHttpAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  agentId?: string;
  model?: string;
  chatPath?: string;
  timeoutMs?: number;
  systemPrompt?: string;
}

export class OpenClawHttpAdapter implements OpenClawAdapter {
  readonly enabled = true;

  private readonly endpoint: string;

  private readonly timeoutMs: number;

  constructor(private readonly options: OpenClawHttpAdapterOptions) {
    const origin = options.baseUrl.replace(/\/+$/, '');
    const chatPath = (options.chatPath ?? '/v1/chat/completions').trim();
    this.endpoint = `${origin}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async *streamAssistantReply(input: OpenClawReplyInput): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...(this.options.agentId ? { 'x-openclaw-agent-id': this.options.agentId } : {})
        },
        body: JSON.stringify({
          model: this.options.model ?? 'openclaw',
          stream: true,
          messages: [
            ...(this.options.systemPrompt
              ? [{ role: 'system', content: this.options.systemPrompt }]
              : []),
            { role: 'user', content: input.text }
          ]
        }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      throw wrapRequestError(error, this.endpoint);
    }

    if (!response.ok) {
      clearTimeout(timer);
      const body = await safeReadBody(response);
      throw new Error(
        `OpenClaw chat request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`
      );
    }
    if (!response.body) {
      clearTimeout(timer);
      throw new Error('OpenClaw chat response has empty body');
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let boundary = findSseBoundary(buffer);
        while (boundary) {
          const block = buffer.slice(0, boundary.start);
          buffer = buffer.slice(boundary.end);
          const token = parseSseBlock(block);
          if (token === null) {
            boundary = findSseBoundary(buffer);
            continue;
          }
          if (token === '[DONE]') {
            return;
          }

          const chunk = safeJsonParse(token) as OpenAIChatChunk | null;
          if (!chunk) {
            boundary = findSseBoundary(buffer);
            continue;
          }

          for (const text of extractTextFromChunk(chunk)) {
            yield text;
          }
          boundary = findSseBoundary(buffer);
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

function parseSseBlock(block: string): string | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.map((line) => line.slice('data:'.length).trim()).join('\n');
}

function findSseBoundary(buffer: string): { start: number; end: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) {
    return null;
  }
  if (lf >= 0 && (crlf < 0 || lf <= crlf)) {
    return { start: lf, end: lf + 2 };
  }
  return { start: crlf, end: crlf + 4 };
}

function extractTextFromChunk(chunk: OpenAIChatChunk): string[] {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta || delta.content === undefined) {
    return [];
  }

  if (typeof delta.content === 'string') {
    return delta.content ? [delta.content] : [];
  }

  const out: string[] = [];
  for (const part of delta.content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
      out.push(part.text);
      continue;
    }
    if (typeof part?.text === 'string' && part.text) {
      out.push(part.text);
    }
  }
  return out;
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function wrapRequestError(error: unknown, endpoint: string): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`OpenClaw chat request timeout after endpoint=${endpoint}`);
  }
  if (error instanceof Error) {
    return new Error(`OpenClaw chat request failed: ${error.message}`);
  }
  return new Error(`OpenClaw chat request failed: ${String(error)}`);
}
