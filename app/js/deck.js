// Main-thread deck model: transport, cues, loops, sync and the link to the
// AudioWorklet that actually plays the audio.

export const HOTCUE_COLORS = ['#ff3b5c', '#ff9f1c', '#ffe14d', '#3ddc84', '#22d3ee', '#4f7cff', '#a855f7', '#ff5fd2'];
export const ROLL_BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
export const LOOP_BEATS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
export const JUMP_BEATS = [-1, 1, -4, 4, -8, 8, -16, 16];

export class Deck {
  constructor(app, index) {
    this.app = app;
    this.index = index;
    this.name = 'ABCD'[index];
    this.node = null;
    this.strip = null;
    this.track = null;           // library entry
    this.info = null;            // analysis result
    this.loaded = false;
    this.loading = 0;            // 0 or progress 0..1
    this.sr = 44100;
    this.duration = 0;
    // transport
    this.playing = false;
    this.rep = { pos: 0, vel: 0, time: 0 };
    this.cuePoint = 0;
    this.cueHeld = false;
    this.cuePreview = false;
    this.hotcues = new Array(8).fill(null);
    this.loop = { on: false, start: 0, end: 0, beats: 4, roll: false };
    this.rollReturn = null;
    // tempo
    this.pitchFader = 0;         // -1..1 physical fader
    this.range = 0.08;
    this.pitch = 0;              // effective pitch (ratio - 1)
    this.pickup = false;
    this.sync = false;
    this.isMaster = false;
    this.keylock = true;
    this.slip = false;
    this.vinyl = true;
    this.quantize = true;
    this.reverse = false;
    this.jogTouched = false;
    this.bendTimer = 0;
    this.phaseBend = 0;
    this.manualBend = 0;
    // mixer
    this.mix = { trim: 0.5, high: 0.5, mid: 0.5, low: 0.5, filter: 0.5, volume: index < 2 ? 1 : 0, cue: false, xfAssign: index % 2 === 0 ? 'A' : 'B' };
    this.autoGainDb = 0;
    this.peak = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, 'pulsar-deck', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    this.send({ type: 'keylock', value: this.keylock });
  }

  send(msg, transfer) { this.node.port.postMessage(msg, transfer || []); }

  onMessage(m) {
    if (m.type === 'state') {
      this.rep = { pos: m.pos, vel: m.vel, time: m.time };
      this.playing = m.playing;
      this.peak = Math.max(this.peak * 0.85, m.peak || 0);
    } else if (m.type === 'ended') {
      this.playing = false;
      this.app.onDeckEnded(this);
    }
  }

  // Current playhead in seconds, extrapolated between worklet reports.
  get position() {
    if (!this.loaded) return 0;
    const dt = Math.max(0, Math.min(0.05, this.ctx.currentTime - this.rep.time));
    return Math.max(0, Math.min(this.duration, (this.rep.pos + this.rep.vel * dt * this.sr) / this.sr));
  }

  get bpm() { return this.info?.bpm || 0; }
  get rate() { return 1 + this.pitch; }
  get liveBpm() { return this.bpm * this.rate; }
  beatSeconds() { return this.bpm ? 60 / this.liveBpm : 0.5; }
  trackBeatSec() { return this.bpm ? 60 / this.bpm : 0.5; }

  beatAt(t) { return this.bpm ? (t - (this.info.beatOffset || 0)) / this.trackBeatSec() : 0; }
  timeOfBeat(b) { return (this.info?.beatOffset || 0) + b * this.trackBeatSec(); }
  nearestBeatTime(t) { return this.bpm ? this.timeOfBeat(Math.round(this.beatAt(t))) : t; }

  trimGain() {
    const db = (this.mix.trim - 0.5) * 2 * 12 + (this.app.settings.autoGain ? this.autoGainDb : 0);
    return Math.pow(10, db / 20);
  }

  // ---------- loading ----------
  async load(track, buffer, info, saved) {
    this.stopEverything();
    this.track = track;
    this.info = info;
    this.sr = buffer.sampleRate;
    this.duration = buffer.duration;
    const L = buffer.getChannelData(0).slice();
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
    this.send({ type: 'load', L, R }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.rep = { pos: 0, vel: 0, time: this.ctx.currentTime };
    this.loaded = true;
    this.hotcues = saved?.hotcues ? saved.hotcues.slice() : new Array(8).fill(null);
    this.cuePoint = saved?.cuePoint ?? (info?.bpm ? Math.max(0, info.beatOffset) : 0);
    this.seek(this.cuePoint);
    this.autoGainDb = info ? Math.max(-12, Math.min(12, -12 - info.rmsDb)) : 0;
    this.loop = { on: false, start: 0, end: 0, beats: 4, roll: false };
    this.sync = false;
    this.reverse = false;
    this.applyTempo();
  }

  stopEverything() {
    if (!this.node) return;
    this.send({ type: 'pause' });
    this.send({ type: 'loop', on: false });
    this.send({ type: 'reverse', value: false });
    this.send({ type: 'scratch', on: false });
    this.playing = false;
  }

  persist() { this.app.library.saveCues(this.track, { hotcues: this.hotcues, cuePoint: this.cuePoint }); }

  // ---------- transport ----------
  seek(sec) {
    if (!this.loaded) return;
    sec = Math.max(0, Math.min(this.duration - 0.01, sec));
    this.send({ type: 'seek', pos: sec * this.sr });
    this.rep = { pos: sec * this.sr, vel: this.rep.vel, time: this.ctx.currentTime };
  }

  play() {
    if (!this.loaded) return;
    if (this.sync) this.syncPhase(true);
    this.send({ type: 'play' });
    this.playing = true;
  }

  pause() {
    this.send({ type: 'pause' });
    this.playing = false;
  }

  togglePlay() {
    if (!this.loaded) return;
    if (this.playing || this.cuePreview) {
      if (this.cuePreview) { this.cuePreview = false; return; } // CUE held + PLAY = keep playing
      this.pause();
    } else this.play();
  }

  // CDJ-style cue: paused -> set cue (snapped) and preview while held; playing -> back to cue and stop.
  cueDown() {
    if (!this.loaded) return;
    this.cueHeld = true;
    if (this.playing && !this.cuePreview) {
      this.pause();
      this.seek(this.cuePoint);
      return;
    }
    const pos = this.position;
    if (Math.abs(pos - this.cuePoint) > 0.01) {
      this.cuePoint = this.quantize ? this.nearestBeatTime(pos) : pos;
      if (Math.abs(this.cuePoint - pos) > 0.25) this.cuePoint = pos;
      this.seek(this.cuePoint);
      this.persist();
    }
    this.cuePreview = true;
    this.send({ type: 'play' });
    this.playing = true;
  }

  cueUp() {
    this.cueHeld = false;
    if (this.cuePreview) {
      this.cuePreview = false;
      this.pause();
      this.seek(this.cuePoint);
    }
  }

  jumpToStart() { this.pause(); this.seek(0); }

  // ---------- hot cues ----------
  hotcueDown(i) {
    if (!this.loaded) return;
    const hc = this.hotcues[i];
    if (hc == null) {
      let t = this.position;
      if (this.quantize && this.bpm) t = this.nearestBeatTime(t);
      this.hotcues[i] = t;
      this.persist();
      return;
    }
    if (this.quantize && this.playing && this.bpm) {
      // keep the beat phase: jump so that the cue lands on the same phase
      const phase = this.beatAt(this.position) - Math.round(this.beatAt(this.position));
      this.seek(hc + phase * this.trackBeatSec());
    } else this.seek(hc);
    if (!this.playing) {
      this.hotcuePreview = i;
      this.play();
    }
  }

  hotcueUp(i) {
    if (this.hotcuePreview === i) {
      this.hotcuePreview = null;
      if (!this.cueHeld && this.app.settings.hotcueGate) {
        this.pause();
        this.seek(this.hotcues[i]);
      }
    }
  }

  hotcueClear(i) {
    this.hotcues[i] = null;
    this.persist();
  }

  // ---------- loops ----------
  sendLoop(jump) {
    const l = this.loop;
    this.send({ type: 'loop', on: l.on, start: l.start * this.sr, end: l.end * this.sr, jump });
  }

  beatLoop(beats, roll = false) {
    if (!this.loaded) return;
    const len = beats * this.trackBeatSec();
    if (this.loop.on && !roll && Math.abs(this.loop.beats - beats) < 1e-6 && !this.loop.roll) {
      this.exitLoop();
      return;
    }
    let start = this.position;
    if (this.quantize && this.bpm) {
      const b = this.beatAt(start);
      const grid = beats < 1 ? beats : 1;
      start = this.timeOfBeat(Math.floor(b / grid + 1e-6) * grid);
    }
    this.loop = { on: true, start, end: start + len, beats, roll };
    this.sendLoop(true);
  }

  rollDown(beats) {
    if (!this.loaded) return;
    this.rollSlipWas = this.slip;
    if (!this.loop.roll) this.rollBeatsWas = this.loop.beats;
    if (!this.slip) this.setSlip(true);
    this.beatLoop(beats, true);
  }

  rollUp() {
    if (!this.loop.roll) return;
    this.exitLoop();
    this.loop.beats = this.rollBeatsWas || 4;
    if (!this.rollSlipWas) this.setSlip(false);
  }

  loopIn() {
    this.loop.start = this.quantize && this.bpm ? this.nearestBeatTime(this.position) : this.position;
    this.loop.pendingIn = true;
  }

  loopOut() {
    const end = this.quantize && this.bpm ? this.nearestBeatTime(this.position) : this.position;
    if (end - this.loop.start < 0.02) return;
    this.loop.end = end;
    this.loop.on = true;
    this.loop.roll = false;
    this.loop.pendingIn = false;
    this.loop.beats = this.bpm ? (end - this.loop.start) / this.trackBeatSec() : 0;
    this.sendLoop(false);
  }

  exitLoop() {
    this.loop.on = false;
    this.loop.roll = false;
    this.sendLoop(false);
  }

  reloop() {
    if (this.loop.on) return this.exitLoop();
    if (this.loop.end > this.loop.start) {
      this.loop.on = true;
      this.sendLoop(false);
      if (this.position > this.loop.end) this.seek(this.loop.start);
    }
  }

  resizeLoop(factor) {
    const l = this.loop;
    if (!l.on) {
      this.loop.beats = Math.max(1 / 32, Math.min(64, l.beats * factor));
      return;
    }
    const len = (l.end - l.start) * factor;
    if (len < 0.01 || len > 300) return;
    l.end = l.start + len;
    l.beats *= factor;
    this.sendLoop(false);
    if (this.position > l.end) this.seek(l.start);
  }

  autoLoop() { this.loop.on ? this.exitLoop() : this.beatLoop(this.loop.beats || 4); }

  beatJump(beats) {
    if (!this.loaded) return;
    const d = beats * this.trackBeatSec();
    if (this.loop.on) {
      this.loop.start += d;
      this.loop.end += d;
      this.sendLoop(false);
    }
    this.seek(this.position + d);
  }

  // ---------- tempo & sync ----------
  // Soft takeover: after sync/reset the fader only takes effect once it crosses the real pitch.
  setPitchFader(v) {
    const p = v * this.range;
    const last = this.pitchFader * this.range;
    this.pitchFader = v;
    if (this.sync) return;
    if (this.pickup) {
      const crossed = Math.abs(p - this.pitch) < 0.004 || Math.sign(p - this.pitch) !== Math.sign(last - this.pitch);
      if (!crossed) return;
      this.pickup = false;
    }
    this.pitch = p;
    this.applyTempo();
  }

  nudgePitch(delta) {
    this.sync = false;
    this.pitch = Math.max(-this.range, Math.min(this.range, this.pitch + delta));
    this.pickup = true;
    this.applyTempo();
  }

  resetTempo() {
    this.sync = false;
    this.pitch = 0;
    this.pickup = Math.abs(this.pitchFader) > 0.01;
    this.applyTempo();
  }

  setRange(r) {
    this.range = r;
    if (!this.sync) { this.pitch = Math.max(-r, Math.min(r, this.pitch)); this.applyTempo(); }
  }

  applyTempo() {
    if (!this.node) return;
    this.send({ type: 'tempo', value: this.rate });
    this.send({ type: 'bend', value: this.manualBend + this.phaseBend });
  }

  setBend(b) {
    this.manualBend = b;
    this.send({ type: 'bend', value: this.manualBend + this.phaseBend });
  }

  toggleSync() {
    if (this.sync) {
      this.sync = false;
      this.pickup = true;
      return;
    }
    const m = this.app.masterFor(this);
    if (!m || !this.bpm || !m.bpm) return;
    this.sync = true;
    this.followMaster(m);
    this.syncPhase(true);
  }

  followMaster(m) {
    let target = m.liveBpm / this.bpm;
    // allow half/double time matching
    if (target > 1.5) target /= 2;
    else if (target < 0.66) target *= 2;
    const p = target - 1;
    if (Math.abs(p - this.pitch) > 1e-5) {
      this.pitch = p;
      this.applyTempo();
    }
  }

  // Align beat phase to the master; `snap` seeks, otherwise gentle bend.
  syncPhase(snap) {
    const m = this.app.masterFor(this);
    if (!m || !m.playing || !this.bpm || !m.bpm) return;
    const ratio = this.bpm * this.rate / (m.bpm * m.rate);
    const mb = m.beatAt(m.position);
    const tb = this.beatAt(this.position);
    const mPhase = mb * (ratio > 1.5 ? 2 : ratio < 0.66 ? 0.5 : 1);
    let diff = (mPhase - Math.floor(mPhase)) - (tb - Math.floor(tb));
    diff -= Math.round(diff);
    if (snap) {
      if (Math.abs(diff) > 0.01) this.seek(this.position + diff * this.trackBeatSec());
      this.phaseBend = 0;
    } else {
      const b = Math.abs(diff) < 0.006 ? 0 : Math.max(-0.03, Math.min(0.03, diff * 0.35));
      if (b !== this.phaseBend) {
        this.phaseBend = b;
        this.send({ type: 'bend', value: this.manualBend + this.phaseBend });
      }
    }
  }

  // ---------- toggles ----------
  setKeylock(v) { this.keylock = v; this.send({ type: 'keylock', value: v }); }
  setSlip(v) { this.slip = v; this.send({ type: 'slip', value: v }); }
  setReverse(v) { this.reverse = v; this.send({ type: 'reverse', value: v }); }

  // ---------- jog ----------
  jogTouch(on) {
    this.jogTouched = on;
    if (this.vinyl && this.loaded) this.send({ type: 'scratch', on });
    if (!on) this.setBend(0);
  }

  // ticks: DDJ-SX resolution is 2048 per revolution at 33 1/3 rpm
  jogScratch(ticks) {
    if (!this.loaded) return;
    const secPerRev = 60 / (33 + 1 / 3);
    const frames = (ticks / 2048) * secPerRev * this.sr * this.app.settings.jogSensitivity;
    this.send({ type: 'scratchMove', frames });
  }

  jogBend(ticks) {
    if (!this.loaded) return;
    if (!this.playing) {
      // paused: fine search
      this.seek(this.position + ticks * 0.004);
      return;
    }
    this.setBend(Math.max(-0.5, Math.min(0.5, ticks * 0.012)));
    clearTimeout(this.bendTimer);
    this.bendTimer = setTimeout(() => this.setBend(0), 60);
  }

  // per-frame upkeep called by the app
  tick() {
    if (this.sync) {
      const m = this.app.masterFor(this);
      if (m && m !== this) {
        this.followMaster(m);
        if (this.playing && !this.jogTouched) this.syncPhase(false);
      }
    } else if (this.phaseBend) {
      this.phaseBend = 0;
      this.send({ type: 'bend', value: this.manualBend });
    }
  }
}
