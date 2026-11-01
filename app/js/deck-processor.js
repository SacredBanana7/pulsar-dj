// Pulsar deck playback engine. Runs on the audio thread: variable-rate
// playback (incl. reverse and scratching), loops, slip mode and a WSOLA
// time-stretcher for key lock.

const GRAIN = 2048;           // WSOLA grain length (frames)
const HOP = GRAIN / 2;        // synthesis hop
const SEEK = 384;             // WSOLA search tolerance (frames)
const CMP = 512;              // correlation window
const SCRATCH_FOLLOW = 640;   // frames the platter target is chased over
const REPORT_EVERY = 3;       // blocks between position reports

const HANN = new Float32Array(GRAIN);
for (let i = 0; i < GRAIN; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null;
    this.R = null;
    this.len = 0;
    this.pos = 0;
    this.vel = 0;
    this.playing = false;
    this.tempo = 1;
    this.bend = 0;
    this.reverse = false;
    this.keylock = false;
    this.scratching = false;
    this.scratchTarget = 0;
    this.scratchVel = 0;
    this.startTime = 0;       // seconds for motor start ramp
    this.stopTime = 0;        // seconds for brake
    this.loopOn = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.slip = false;
    this.slipPos = 0;
    this.slipHeld = false;
    this.blocks = 0;
    this.peak = 0;
    // WSOLA state
    this.ola = new Float32Array(GRAIN * 2);   // interleaved-free: L in [0,GRAIN), R in [GRAIN,2*GRAIN)
    this.olaIdx = HOP;
    this.prevGrain = -1;
    this.stretching = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L;
        this.R = m.R || m.L;
        this.len = this.L.length;
        this.pos = 0;
        this.vel = 0;
        this.playing = false;
        this.loopOn = false;
        this.scratching = false;
        this.resetStretch();
        this.report(true);
        break;
      case 'unload':
        this.L = this.R = null;
        this.len = 0;
        this.playing = false;
        this.report(true);
        break;
      case 'play': this.playing = true; break;
      case 'pause': this.playing = false; break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.len - 1, m.pos));
        if (!this.slipHeld) this.slipPos = this.pos;
        this.resetStretch();
        this.report(true);
        break;
      case 'tempo': this.tempo = m.value; break;
      case 'bend': this.bend = m.value; break;
      case 'reverse': this.reverse = m.value; break;
      case 'keylock': this.keylock = m.value; this.resetStretch(); break;
      case 'ramps': this.startTime = m.start; this.stopTime = m.stop; break;
      case 'slip': this.slip = m.value; this.slipPos = this.pos; break;
      case 'loop':
        this.loopOn = !!m.on;
        if (m.on) {
          this.loopStart = m.start;
          this.loopEnd = m.end;
          if (m.jump && this.pos > this.loopEnd) this.pos = this.loopStart;
        }
        break;
      case 'scratch':
        if (m.on && !this.scratching) {
          this.scratchTarget = this.pos;
          this.scratchVel = this.vel;
        }
        this.scratching = m.on;
        break;
      case 'scratchMove':
        if (!this.scratching) {
          this.scratchTarget = this.pos;
          this.scratching = true;
        }
        this.scratchTarget += m.frames;
        break;
    }
  }

  resetStretch() {
    this.ola.fill(0);
    this.olaIdx = HOP;
    this.prevGrain = -1;
  }

  report(force) {
    this.port.postMessage({
      type: 'state',
      pos: this.pos,
      vel: this.vel,
      playing: this.playing,
      time: currentTime,
      peak: this.peak,
      force: !!force,
    });
    this.peak = 0;
  }

  // 4-point Hermite interpolation
  sample(buf, x) {
    const i = Math.floor(x);
    if (i < 1 || i + 2 >= this.len) {
      return i >= 0 && i < this.len ? buf[i] : 0;
    }
    const f = x - i;
    const xm = buf[i - 1], x0 = buf[i], x1 = buf[i + 1], x2 = buf[i + 2];
    const c = (x1 - xm) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const b = w + a;
    return ((a * f - b) * f + c) * f + x0;
  }

  monoAt(i) {
    if (i < 0 || i >= this.len) return 0;
    return this.L[i] + this.R[i];
  }

  // Find the grain start near `center` whose waveform best continues the previous grain.
  bestGrain(center) {
    if (this.prevGrain < 0) return Math.round(center);
    const natural = this.prevGrain + HOP;
    let best = Math.round(center), bestScore = -Infinity;
    const scan = (from, to, step, cmpStep) => {
      for (let c = from; c <= to; c += step) {
        let s = 0;
        for (let k = 0; k < CMP; k += cmpStep) s += this.monoAt(natural + k) * this.monoAt(c + k);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    };
    const c0 = Math.round(center);
    scan(c0 - SEEK, c0 + SEEK, 8, 4);
    const coarse = best;
    scan(coarse - 7, coarse + 7, 1, 2);
    return best;
  }

  // Add the next keylocked grain into the overlap-add buffer.
  pushGrain() {
    const ola = this.ola;
    // shift by HOP
    ola.copyWithin(0, HOP, GRAIN);
    ola.fill(0, GRAIN - HOP, GRAIN);
    ola.copyWithin(GRAIN, GRAIN + HOP, GRAIN * 2);
    ola.fill(0, GRAIN * 2 - HOP, GRAIN * 2);
    const start = this.bestGrain(this.pos - GRAIN / 2);
    const L = this.L, R = this.R, len = this.len;
    for (let k = 0; k < GRAIN; k++) {
      const i = start + k;
      if (i < 0 || i >= len) continue;
      const w = HANN[k];
      ola[k] += L[i] * w;
      ola[GRAIN + k] += R[i] * w;
    }
    this.prevGrain = start;
    this.olaIdx = 0;
  }

  targetVelocity() {
    if (!this.playing) return 0;
    const v = this.tempo * (1 + this.bend);
    return this.reverse ? -v : v;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;

    if (!this.L) {
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      if (++this.blocks % (REPORT_EVERY * 8) === 0) this.report(false);
      return true;
    }

    // Velocity for this block
    const v0 = this.vel;
    let v1;
    if (this.scratching) {
      const want = (this.scratchTarget - this.pos) / SCRATCH_FOLLOW;
      this.scratchVel += (want - this.scratchVel) * 0.55;
      v1 = Math.max(-24, Math.min(24, this.scratchVel));
      if (Math.abs(v1) < 1e-4) v1 = 0;
    } else {
      const target = this.targetVelocity();
      const ramp = target === 0 ? this.stopTime : (Math.abs(v0) < Math.abs(target) ? this.startTime : 0);
      if (ramp > 0) {
        const step = n / (sampleRate * ramp);
        v1 = v0 + Math.max(-step, Math.min(step, target - v0));
      } else {
        // fast but click-free settle (also catches scratch release)
        v1 = Math.abs(target - v0) < 0.002 ? target : v0 + (target - v0) * 0.35;
      }
    }

    const slipEngaged = this.slip && (this.scratching || this.loopOn || this.reverse);
    if (this.slipHeld && !slipEngaged) {
      // slip released: jump back to where the track would be
      this.pos = this.slipPos;
      this.resetStretch();
    }
    this.slipHeld = slipEngaged;
    const slipVel = this.playing ? this.tempo * (1 + this.bend) : 0;

    const stretch = this.keylock && !this.scratching && v0 > 0.05 && v1 > 0.05 &&
      (Math.abs(v1 - 1) > 0.003 || this.stretching);
    if (stretch && !this.stretching) this.resetStretch();
    this.stretching = stretch && Math.abs(v1 - 1) > 0.003;

    const L = this.L, R = this.R;
    let peak = this.peak;
    for (let k = 0; k < n; k++) {
      const v = v0 + (v1 - v0) * (k / n);
      let l, r;
      if (this.stretching) {
        if (this.olaIdx >= HOP) this.pushGrain();
        l = this.ola[this.olaIdx];
        r = this.ola[GRAIN + this.olaIdx];
        this.olaIdx++;
      } else {
        l = this.sample(L, this.pos);
        r = this.sample(R, this.pos);
      }
      oL[k] = l;
      oR[k] = r;
      const a = l < 0 ? -l : l;
      if (a > peak) peak = a;

      this.pos += v;
      if (this.loopOn && v > 0 && this.pos >= this.loopEnd) {
        this.pos -= this.loopEnd - this.loopStart;
        if (this.scratching) this.scratchTarget -= this.loopEnd - this.loopStart;
      }
      if (slipEngaged) this.slipPos += slipVel;
    }
    this.peak = peak;
    this.vel = v1;
    if (!slipEngaged) this.slipPos = this.pos;

    if (this.pos >= this.len) {
      this.pos = this.len - 1;
      this.playing = false;
      this.vel = 0;
      this.port.postMessage({ type: 'ended' });
      this.report(true);
    } else if (this.pos < 0) {
      this.pos = 0;
      if (this.scratching) this.scratchTarget = Math.max(this.scratchTarget, 0);
      this.vel = 0;
    }

    if (++this.blocks % REPORT_EVERY === 0) this.report(false);
    return true;
  }
}

registerProcessor('pulsar-deck', DeckProcessor);
