export class PcmAudioPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.nextStartAt = 0;
    this.sources = new Set();
  }

  async init() {
    if (this.ctx) {
      return;
    }
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextImpl({ sampleRate: this.sampleRate });
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.nextStartAt = this.ctx.currentTime;
  }

  async enqueueBase64(base64Pcm) {
    if (!this.ctx) {
      await this.init();
    }
    if (!this.ctx) {
      return;
    }

    const pcm = decodePcm16(base64Pcm);
    const buffer = this.ctx.createBuffer(1, pcm.length, this.sampleRate);
    buffer.copyToChannel(pcm, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      try {
        source.disconnect();
      } catch {
        // noop
      }
    };

    const now = this.ctx.currentTime;
    const startAt = Math.max(now + 0.005, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
  }

  async stop() {
    if (!this.ctx) {
      return;
    }
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // noop
      }
      try {
        source.disconnect();
      } catch {
        // noop
      }
    }
    this.sources.clear();
    this.nextStartAt = this.ctx.currentTime;
  }

  async close() {
    await this.stop();
    if (!this.ctx) {
      return;
    }
    await this.ctx.close();
    this.ctx = null;
    this.nextStartAt = 0;
  }
}

function decodePcm16(base64) {
  const binary = atob(base64);
  const len = binary.length / 2;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
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
