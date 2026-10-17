// AudioWorklet wrapper around PitchShifter. Messages in: { ratio }, { reset }.
// Posts { latency } (seconds) once so content.js can feed the stems that much early.

import { PitchShifter, LATENCY } from './pitch-shift.js';

const SILENCE = new Float32Array(128);

class KaraokePitch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = 1;
    this.shifter = new PitchShifter(2);
    this.port.onmessage = ({ data }) => {
      if (data.ratio) this.ratio = data.ratio;
      if (data.reset) this.shifter.reset();
    };
    this.port.postMessage({ latency: LATENCY / sampleRate });
  }

  process([input], [output]) {
    // Disconnected (key back at 0): idle instead of shifting silence.
    if (!input.length) return true;
    const n = output[0].length;
    const L = input[0] || SILENCE;
    this.shifter.process([L, input[1] || L], output, n, this.ratio);
    return true;
  }
}

registerProcessor('karaoke-pitch', KaraokePitch);
