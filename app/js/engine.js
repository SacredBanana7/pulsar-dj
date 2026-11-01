// Audio graph: 4 deck channel strips -> crossfader -> master (limiter, recorder)
// plus a pre-fader cue bus for headphones. Output routing adapts to the device:
// 4+ channels put master on 1/2 and headphones on 3/4 (DDJ-SX sound card).

import { FxUnit } from './fx.js';

const dbToGain = (db) => Math.pow(10, db / 20);

// EQ knob 0..1 -> gain: 0 = kill, 0.5 = 0 dB, 1 = +6 dB
export function eqGain(v) {
  if (v >= 0.5) return dbToGain((v - 0.5) * 2 * 6);
  if (v <= 0.01) return 0;
  return dbToGain(-((0.5 - v) / 0.5) * 30) * Math.min(1, v * 8);
}

class ChannelStrip {
  constructor(ctx, index) {
    this.ctx = ctx;
    this.index = index;
    this.input = ctx.createGain();
    this.trim = ctx.createGain();
    // 3-band isolator: LR4-style split into low / mid / high
    const mk = (type, f) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = Math.SQRT1_2;
      return b;
    };
    const lo1 = mk('lowpass', 220), lo2 = mk('lowpass', 220);
    const mh1 = mk('highpass', 220), mh2 = mk('highpass', 220);
    const ml1 = mk('lowpass', 2800), ml2 = mk('lowpass', 2800);
    const hi1 = mk('highpass', 2800), hi2 = mk('highpass', 2800);
    this.low = ctx.createGain();
    this.mid = ctx.createGain();
    this.high = ctx.createGain();
    this.eqSum = ctx.createGain();
    this.input.connect(this.trim);
    this.trim.connect(lo1).connect(lo2).connect(this.low).connect(this.eqSum);
    this.trim.connect(mh1).connect(mh2).connect(ml1).connect(ml2).connect(this.mid).connect(this.eqSum);
    this.trim.connect(hi1).connect(hi2).connect(this.high).connect(this.eqSum);
    // one-knob filter
    this.lpf = mk('lowpass', 22000);
    this.hpf = mk('highpass', 10);
    this.lpf.Q.value = this.hpf.Q.value = 1.2;
    this.eqSum.connect(this.hpf).connect(this.lpf);
    this.fxIn = this.lpf;              // FX chains are inserted after the filter
    this.post = ctx.createGain();      // end of the pre-fader section
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.cue = ctx.createGain();
    this.cue.gain.value = 0;
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 512;
    this.meterBuf = new Float32Array(512);
    this.post.connect(this.fader).connect(this.xf);
    this.post.connect(this.cue);
    this.fader.connect(this.meter);
    this.fxChains = [];
    this.rewireFx([]);
  }

  rewireFx(chains) {
    this.fxIn.disconnect();
    for (const c of this.fxChains) c.output.disconnect();
    let prev = this.fxIn;
    for (const c of chains) {
      prev.connect(c.input);
      prev = c.output;
    }
    prev.connect(this.post);
    this.fxChains = chains;
  }

  setFilter(v) {
    const t = this.ctx.currentTime;
    if (Math.abs(v - 0.5) < 0.02) {
      this.lpf.frequency.setTargetAtTime(22000, t, 0.02);
      this.hpf.frequency.setTargetAtTime(10, t, 0.02);
    } else if (v < 0.5) {
      const x = (0.5 - v) / 0.5; // 0..1
      this.lpf.frequency.setTargetAtTime(20000 * Math.pow(60 / 20000, x), t, 0.02);
      this.hpf.frequency.setTargetAtTime(10, t, 0.02);
    } else {
      const x = (v - 0.5) / 0.5;
      this.hpf.frequency.setTargetAtTime(10 * Math.pow(1200, x), t, 0.02);
      this.lpf.frequency.setTargetAtTime(22000, t, 0.02);
    }
  }

  level() {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let p = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const a = Math.abs(this.meterBuf[i]);
      if (a > p) p = a;
    }
    return p;
  }
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.strips = [];
    this.fxUnits = [
      new FxUnit(0, ['echo', 'reverb', 'flanger']),
      new FxUnit(1, ['gate', 'crush', 'riser']),
    ];
    this.xfader = 0.5;
    this.xfCurve = 0.5;          // 0 = smooth mix, 1 = sharp cut
    this.headMix = 0.0;          // 0 = cue only, 1 = master only
    this.headVol = 0.8;
    this.masterVol = 0.8;
    this.routing = 'auto';       // auto | stereo | split
    this.splitCue = false;
    this.outChannels = 2;
    this.recorder = null;
  }

  async init(sinkId) {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('js/deck-processor.js');
    if (sinkId && ctx.setSinkId) {
      try { await ctx.setSinkId(sinkId); } catch (e) { console.warn('setSinkId', e); }
    }
    this.masterBus = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterBus.connect(this.masterGain).connect(this.limiter);
    this.masterMeterL = ctx.createAnalyser();
    this.masterMeterR = ctx.createAnalyser();
    this.masterMeterL.fftSize = this.masterMeterR.fftSize = 512;
    const split = ctx.createChannelSplitter(2);
    this.limiter.connect(split);
    split.connect(this.masterMeterL, 0);
    split.connect(this.masterMeterR, 1);
    this.meterBuf = new Float32Array(512);

    this.cueBus = ctx.createGain();
    this.headCue = ctx.createGain();
    this.headMaster = ctx.createGain();
    this.headGain = ctx.createGain();
    this.cueBus.connect(this.headCue).connect(this.headGain);
    this.limiter.connect(this.headMaster).connect(this.headGain);

    this.recDest = ctx.createMediaStreamDestination();
    this.limiter.connect(this.recDest);

    for (let i = 0; i < 4; i++) {
      const s = new ChannelStrip(ctx, i);
      s.xf.connect(this.masterBus);
      s.cue.connect(this.cueBus);
      this.strips.push(s);
    }
    this.configureOutput();
    this.applyMix();
  }

  async setSink(sinkId) {
    if (!this.ctx?.setSinkId) return false;
    await this.ctx.setSinkId(sinkId || '');
    this.configureOutput();
    return true;
  }

  // Wire master + headphones onto the destination channels.
  configureOutput() {
    const ctx = this.ctx, dest = ctx.destination;
    const max = dest.maxChannelCount || 2;
    const want = this.routing === 'stereo' ? 2 : this.routing === 'auto' ? Math.min(4, max) : 2;
    const chans = max >= 4 && want >= 4 ? 4 : 2;
    this.outChannels = chans;
    dest.channelCount = chans;
    dest.channelInterpretation = 'discrete';
    dest.channelCountMode = 'explicit';
    if (this.merger) this.merger.disconnect();
    if (this.masterSplit) {
      try { this.limiter.disconnect(this.masterSplit); } catch {}
      this.masterSplit.disconnect();
    }
    if (this.headSplit) {
      this.headGain.disconnect();
      this.headSplit.disconnect();
    }

    const merger = ctx.createChannelMerger(chans);
    const ms = ctx.createChannelSplitter(2);
    const hs = ctx.createChannelSplitter(2);
    this.limiter.connect(ms);
    this.headGain.connect(hs);
    if (chans === 4) {
      ms.connect(merger, 0, 0);
      ms.connect(merger, 1, 1);
      hs.connect(merger, 0, 2);
      hs.connect(merger, 1, 3);
    } else if (this.routing === 'split') {
      // mono master left, mono cue right (one stereo headphone jack)
      ms.connect(merger, 0, 0);
      ms.connect(merger, 1, 0);
      hs.connect(merger, 0, 1);
      hs.connect(merger, 1, 1);
    } else {
      ms.connect(merger, 0, 0);
      ms.connect(merger, 1, 1);
    }
    merger.connect(dest);
    this.merger = merger;
    this.masterSplit = ms;
    this.headSplit = hs;
  }

  attachDeck(deck) {
    const strip = this.strips[deck.index];
    deck.node.connect(strip.input);
    deck.strip = strip;
  }

  // Re-insert FX chains into a deck's strip according to unit assignments.
  rewireFx(decks) {
    for (const deck of decks) {
      const chains = [];
      for (const u of this.fxUnits) {
        if (u.assigned[deck.index]) chains.push(u.chainFor(this.ctx, deck));
      }
      deck.strip.rewireFx(chains);
    }
    this.updateFx(decks);
  }

  updateFx(decks) {
    for (const u of this.fxUnits) u.update(this.ctx, decks);
  }

  // crossfader gains for side A (left) and B (right)
  xfGains() {
    const x = this.xfader;
    const sharp = this.xfCurve;
    // blend between constant-power and a near-cut curve
    const cpA = Math.cos(x * Math.PI / 2), cpB = Math.sin(x * Math.PI / 2);
    const k = 1 + sharp * 40;
    const cutA = Math.min(1, (1 - x) * k), cutB = Math.min(1, x * k);
    const mix = sharp;
    return [cpA * (1 - mix) + cutA * mix, cpB * (1 - mix) + cutB * mix];
  }

  applyMix(decks = []) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const [ga, gb] = this.xfGains();
    for (const deck of decks) {
      const s = deck.strip;
      if (!s) continue;
      s.trim.gain.setTargetAtTime(deck.trimGain(), t, 0.01);
      s.high.gain.setTargetAtTime(eqGain(deck.mix.high), t, 0.01);
      s.mid.gain.setTargetAtTime(eqGain(deck.mix.mid), t, 0.01);
      s.low.gain.setTargetAtTime(eqGain(deck.mix.low), t, 0.01);
      s.setFilter(deck.mix.filter);
      const f = deck.mix.volume;
      s.fader.gain.setTargetAtTime(f * f * (3 - 2 * f), t, 0.008);
      const side = deck.mix.xfAssign; // 'A' | 'B' | 'THRU'
      s.xf.gain.setTargetAtTime(side === 'A' ? ga : side === 'B' ? gb : 1, t, 0.005);
      s.cue.gain.setTargetAtTime(deck.mix.cue ? 1 : 0, t, 0.01);
    }
    this.masterGain.gain.setTargetAtTime(this.masterVol * this.masterVol * 1.25, t, 0.01);
    const anyCue = decks.some((d) => d.mix.cue) || this.previewing;
    const hm = anyCue ? this.headMix : 1;
    this.headCue.gain.setTargetAtTime(Math.cos(hm * Math.PI / 2), t, 0.01);
    this.headMaster.gain.setTargetAtTime(Math.sin(hm * Math.PI / 2), t, 0.01);
    this.headGain.gain.setTargetAtTime(this.headVol * this.headVol * 1.4, t, 0.01);
  }

  masterLevels() {
    const peak = (an) => {
      an.getFloatTimeDomainData(this.meterBuf);
      let p = 0;
      for (let i = 0; i < this.meterBuf.length; i++) {
        const a = Math.abs(this.meterBuf[i]);
        if (a > p) p = a;
      }
      return p;
    };
    return [peak(this.masterMeterL), peak(this.masterMeterR)];
  }

  startRecording() {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(this.recDest.stream, { mimeType, audioBitsPerSecond: 320000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const a = document.createElement('a');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      a.download = `pulsar-mix-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.webm`;
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    };
    rec.start(1000);
    this.recorder = rec;
    this.recStart = performance.now();
  }

  stopRecording() {
    if (this.recorder) this.recorder.stop();
    this.recorder = null;
  }
}
