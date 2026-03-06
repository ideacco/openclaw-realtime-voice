import { describe, expect, it } from 'vitest';
import { encodeServerEvent, parseClientEvent } from '../src/shared/protocol.js';

describe('protocol parsing', () => {
  it('parses session.start', () => {
    const event = parseClientEvent(JSON.stringify({ type: 'session.start', voice: 'Bunny' }));
    expect(event).toEqual({ type: 'session.start', voice: 'Bunny', sampleRate: undefined });
  });

  it('parses agent.input.text', () => {
    const event = parseClientEvent(JSON.stringify({ type: 'agent.input.text', text: '你好' }));
    expect(event).toEqual({ type: 'agent.input.text', text: '你好' });
  });

  it('parses channel.start', () => {
    const event = parseClientEvent(
      JSON.stringify({ type: 'channel.start', voice: 'Bunny', sampleRate: 24000, inputSampleRate: 16000 })
    );
    expect(event).toEqual({
      type: 'channel.start',
      voice: 'Bunny',
      sampleRate: 24000,
      inputSampleRate: 16000
    });
  });

  it('parses input.audio.chunk', () => {
    const event = parseClientEvent(
      JSON.stringify({ type: 'input.audio.chunk', data: 'YWJj', encoding: 'webm_opus', sampleRate: 48000 })
    );
    expect(event).toEqual({
      type: 'input.audio.chunk',
      data: 'YWJj',
      encoding: 'webm_opus',
      sampleRate: 48000
    });
  });

  it('parses input.asr.local', () => {
    const event = parseClientEvent(
      JSON.stringify({ type: 'input.asr.local', text: '你好，这是本地识别', isFinal: true })
    );
    expect(event).toEqual({
      type: 'input.asr.local',
      text: '你好，这是本地识别',
      isFinal: true
    });
  });

  it('parses input.assistant.text', () => {
    const event = parseClientEvent(
      JSON.stringify({ type: 'input.assistant.text', text: '这是 OpenClaw 的回复' })
    );
    expect(event).toEqual({
      type: 'input.assistant.text',
      text: '这是 OpenClaw 的回复'
    });
  });

  it('rejects invalid payload', () => {
    expect(() => parseClientEvent('{')).toThrow();
    expect(() => parseClientEvent(JSON.stringify({ type: 'agent.input.text', text: '' }))).toThrow();
    expect(() =>
      parseClientEvent(JSON.stringify({ type: 'input.audio.chunk', data: 'xx', encoding: 'mp3' }))
    ).toThrow();
  });

  it('encodes server event', () => {
    const encoded = encodeServerEvent({
      type: 'session.error',
      code: 'BAD_REQUEST',
      message: 'bad',
      retryable: false
    });
    expect(encoded).toContain('session.error');
  });
});
