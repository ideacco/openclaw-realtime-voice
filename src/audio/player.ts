export class PcmAudioPlayer {
  private ctx: AudioContext | null = null;

  private nextStartAt = 0;

  private readonly sampleRate: number;

  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
  }

  async init(): Promise<void> {
    if (this.ctx) {
      return;
    }

    const AudioContextImpl = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextImpl({ sampleRate: this.sampleRate });
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.nextStartAt = this.ctx.currentTime;
  }

  async enqueueBase64(base64Pcm: string): Promise<void> {
    if (!this.ctx) {
      await this.init();
    }

    if (!this.ctx) {
      return;
    }

    const pcm = decodePcm16(base64Pcm);
    const audioBuffer = this.ctx.createBuffer(1, pcm.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(pcm);

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now + 0.005, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + audioBuffer.duration;
  }

  async close(): Promise<void> {
    if (!this.ctx) {
      return;
    }

    await this.ctx.close();
    this.ctx = null;
    this.nextStartAt = 0;
  }
}

export function decodePcm16(base64: string): Float32Array {
  const binary = atob(base64);
  const length = binary.length / 2;
  const out = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let sample = (hi << 8) | lo;
    if (sample >= 0x8000) {
      sample -= 0x10000;
    }
    out[i] = sample / 32768;
  }

  return out;
}
