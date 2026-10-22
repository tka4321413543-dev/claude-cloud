// Lấy audio từ mic (Float32, sampleRate của máy), downsample về 16kHz PCM16 cho Live API.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = [];
    this.chunk = 1600; // 100ms @ 16kHz
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Linear-interpolation resample
    while (this.pos < ch.length - 1) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      this.out.push(ch[i] * (1 - f) + ch[i + 1] * f);
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    if (this.out.length >= this.chunk) {
      const pcm = new Int16Array(this.out.length);
      for (let i = 0; i < this.out.length; i++) {
        const s = Math.max(-1, Math.min(1, this.out[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      this.out = [];
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
