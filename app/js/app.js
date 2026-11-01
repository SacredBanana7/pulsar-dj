// Pulsar application core: owns engine, decks, library and MIDI and
// routes every control action (mouse, keyboard, MIDI) through act().

import { Engine } from './engine.js';
import { Deck } from './deck.js';
import { Library } from './library.js';
import { Midi } from './midi.js';
import { FX_TYPES } from './fx.js';

const RANGES = [0.06, 0.08, 0.16, 0.5];

const DEFAULT_SETTINGS = {
  fourDecks: false,
  autoGain: true,
  hotcueGate: true,
  loadLock: true,
  invertTempo: false,
  jogSensitivity: 1,
  defaultRange: 0.08,
  routing: 'auto',
  sinkId: '',
  brake: 0,
};

export class App {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('pulsar.settings') || '{}') };
    this.engine = new Engine();
    this.engine.routing = this.settings.routing;
    this.decks = [0, 1, 2, 3].map((i) => new Deck(this, i));
    this.decks.forEach((d) => (d.range = this.settings.defaultRange));
    this.library = new Library(this);
    this.midi = new Midi(this);
    this.masterIndex = null;
    this.padMode = ['hotcue', 'hotcue', 'hotcue', 'hotcue'];
    this.focus = [0, 1];               // which deck each side shows (A/C, B/D)
    this.selected = null;              // selected library track
    this.ui = null;
    this.started = false;
    this.toasts = [];
  }

  saveSettings() { localStorage.setItem('pulsar.settings', JSON.stringify(this.settings)); }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.engine.init(this.settings.sinkId);
    for (const d of this.decks) {
      d.init(this.engine.ctx);
      this.engine.attachDeck(d);
      d.send({ type: 'ramps', start: 0, stop: this.settings.brake });
    }
    this.engine.applyMix(this.decks);
    this.engine.rewireFx(this.decks);
    this.midi.init();
    let last = 0;
    const loop = (t) => {
      for (const d of this.decks) d.tick();
      if (t - last > 33) {
        last = t;
        this.engine.updateFx(this.decks);
        this.midi.feedback();
      }
      this.ui?.frame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  toast(msg, kind = 'info') { this.ui?.toast(msg, kind); }

  masterFor(deck) {
    const pick = (d) => d && d !== deck && d.loaded && d.bpm;
    if (this.masterIndex != null && pick(this.decks[this.masterIndex])) return this.decks[this.masterIndex];
    const playing = this.decks.filter((d) => pick(d) && d.playing);
    const audible = (d) => d.mix.volume * (d.mix.xfAssign === 'THRU' ? 1 : this.engine.xfGains()[d.mix.xfAssign === 'A' ? 0 : 1]);
    playing.sort((a, b) => (a.sync - b.sync) || (audible(b) - audible(a)));
    if (playing.length) return playing[0];
    return this.decks.find((d) => pick(d) && !d.sync) || null;
  }

  get clockBpm() {
    const m = this.masterIndex != null ? this.decks[this.masterIndex] : this.masterFor(null);
    return m && m.loaded ? m.liveBpm : 0;
  }

  // ---------- loading ----------
  async loadTrack(index, track) {
    const d = this.decks[index];
    if (!track) return;
    if (!this.library.available(track)) {
      this.toast('Datei ist in dieser Sitzung nicht verfügbar. Ordner neu verbinden.', 'warn');
      return;
    }
    if (this.settings.loadLock && d.playing && d.mix.volume > 0.05) {
      this.toast(`Deck ${d.name} läuft gerade. Erst stoppen oder den Fader runterziehen.`, 'warn');
      return;
    }
    if (!this.started) await this.start();
    d.loading = 0.02;
    try {
      const { buffer, info } = await this.library.prepare(track, this.engine.ctx, (p) => (d.loading = p));
      const saved = await this.library.loadCues(track);
      await d.load(track, buffer, info, saved);
      d.playedMarked = false;
      if (this.settings.fourDecks) this.focus[index % 2] = index;
      this.engine.rewireFx(this.decks);
      this.engine.applyMix(this.decks);
    } catch (e) {
      console.error(e);
      this.toast(`Laden fehlgeschlagen: ${e.message || e}`, 'error');
    } finally {
      d.loading = 0;
      this.ui?.refreshDeck(index);
    }
  }

  onDeckEnded(deck) { this.ui?.refreshDeck(deck.index); }

  // ---------- one entry point for every control ----------
  act(name, t, a, b) {
    const d = typeof t === 'number' ? this.decks[t] : null;
    const e = this.engine;
    if (d && !this.started && name !== 'load') this.start();
    switch (name) {
      case 'play':
        d.togglePlay();
        if (d.playing && !d.playedMarked && d.track) { d.playedMarked = true; this.library.markPlayed(d.track); }
        break;
      case 'stutter': d.seek(d.cuePoint); d.play(); break;
      case 'cueDown': d.cueDown(); break;
      case 'cueUp': d.cueUp(); break;
      case 'jumpStart': d.jumpToStart(); break;
      case 'sync': d.toggleSync(); break;
      case 'master': this.masterIndex = this.masterIndex === t ? null : t; break;
      case 'quantize': d.quantize = !d.quantize; break;
      case 'keylock': d.setKeylock(!d.keylock); break;
      case 'range': {
        const i = RANGES.indexOf(d.range);
        d.setRange(RANGES[(i + 1) % RANGES.length]);
        this.toast(`Deck ${d.name}: Pitch-Bereich ±${Math.round(d.range * 100)} %`);
        break;
      }
      case 'tempoReset': d.resetTempo(); break;
      case 'tempo': d.setPitchFader(a); break;
      case 'tempoAbs': d.setPitchFader((a * 2 - 1) * (this.settings.invertTempo ? -1 : 1)); break;
      case 'pitchNudge': d.nudgePitch(a); break;
      case 'vinyl': d.vinyl = !d.vinyl; break;
      case 'vinylState': d.vinyl = a; break;
      case 'deckSelect':
        if (t >= 2 && !this.settings.fourDecks) {
          this.settings.fourDecks = true;
          this.saveSettings();
        }
        this.focus[t % 2] = t;
        this.ui?.layout();
        break;
      case 'slip': d.setSlip(!d.slip); break;
      case 'reverse': d.setReverse(a === undefined ? !d.reverse : !!a); break;
      case 'headCue': d.mix.cue = !d.mix.cue; e.applyMix(this.decks); break;
      case 'jogTouch': d.jogTouch(!!a); this.focusDeck(t); break;
      case 'jog':
        if (b) d.jogBend(a);
        else if (d.vinyl && d.jogTouched) d.jogScratch(a);
        else d.jogBend(a);
        break;
      case 'scratchMouse': d.jogScratch(a); break;
      case 'needle': if (!d.playing) d.seek(a * d.duration); break;
      case 'seek': d.seek(a); break;
      case 'loopIn': d.loopIn(); break;
      case 'loopOut': d.loopOut(); break;
      case 'loopExit': d.exitLoop(); break;
      case 'reloop': d.reloop(); break;
      case 'autoLoop': d.autoLoop(); break;
      case 'loopHalf': d.resizeLoop(0.5); break;
      case 'loopDouble': d.resizeLoop(2); break;
      case 'beatJump': d.beatJump(a); break;
      case 'beatLoop': d.beatLoop(a); break;
      case 'rollDown': d.rollDown(a); break;
      case 'rollUp': d.rollUp(); break;
      case 'slice': {
        if (!d.bpm) break;
        const b0 = Math.floor(d.beatAt(d.position) / 8) * 8;
        const phase = d.beatAt(d.position) % 1;
        d.seek(d.timeOfBeat(b0 + a + (d.quantize ? phase : 0)));
        break;
      }
      case 'hotcueDown': d.hotcueDown(a); break;
      case 'hotcueUp': d.hotcueUp(a); break;
      case 'hotcueClear': d.hotcueClear(a); break;
      case 'padMode': this.padMode[t] = a === 'slicer' ? 'loop' : a === 'sampler' ? 'jump' : a; break;
      case 'padPage': {
        const modes = ['hotcue', 'roll', 'loop', 'jump'];
        const i = modes.indexOf(this.padMode[t]);
        this.padMode[t] = modes[(i + a + modes.length) % modes.length];
        break;
      }
      case 'pad': {
        // on-screen pad: a = index, b = down(true)/up(false)
        const mode = this.padMode[t];
        if (mode === 'hotcue') b ? (this.uiShift ? d.hotcueClear(a) : d.hotcueDown(a)) : d.hotcueUp(a);
        else if (mode === 'roll') b ? d.rollDown([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8][a]) : d.rollUp();
        else if (mode === 'loop' && b) d.beatLoop([1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32][a]);
        else if (mode === 'jump' && b) d.beatJump([-1, 1, -4, 4, -8, 8, -16, 16][a]);
        break;
      }
      case 'volume': d.mix.volume = a; e.applyMix(this.decks); break;
      case 'trim': d.mix.trim = a; e.applyMix(this.decks); break;
      case 'eq': d.mix[a] = b; e.applyMix(this.decks); break;
      case 'filter': this.decks[t].mix.filter = a; e.applyMix(this.decks); break;
      case 'xfAssign': d.mix.xfAssign = a; e.applyMix(this.decks); break;
      case 'xfader': e.xfader = a; e.applyMix(this.decks); break;
      case 'xfCurve': e.xfCurve = a; e.applyMix(this.decks); break;
      case 'masterVol': e.masterVol = a; e.applyMix(this.decks); break;
      case 'headMix': e.headMix = a; e.applyMix(this.decks); break;
      case 'headVol': e.headVol = a; e.applyMix(this.decks); break;
      case 'fxSlot': {
        const s = e.fxUnits[t].slots[a];
        s.on = !s.on;
        if (s.on && !e.fxUnits[t].assigned.some(Boolean)) {
          // nothing assigned yet: assign to the focused decks so the button does something
          this.focus.forEach((i) => (e.fxUnits[t].assigned[i] = true));
          e.rewireFx(this.decks);
        }
        break;
      }
      case 'fxLevel': e.fxUnits[t].slots[a].level = b; break;
      case 'fxBeats': e.fxUnits[t].stepBeats(a); break;
      case 'fxType': e.fxUnits[t].slots[a].type = b; e.rewireFx(this.decks); break;
      case 'fxCycle': {
        const u = e.fxUnits[t];
        const types = Object.keys(FX_TYPES);
        const s = u.slots[0];
        s.type = types[(types.indexOf(s.type) + 1) % types.length];
        e.rewireFx(this.decks);
        this.toast(`FX ${t + 1}: ${FX_TYPES[s.type]}`);
        break;
      }
      case 'fxAssign': e.fxUnits[t].assigned[a] = !e.fxUnits[t].assigned[a]; e.rewireFx(this.decks); break;
      case 'load': {
        // the library selection lives in the UI (row click, arrow keys, browse knob)
        const track = this.ui?.selected || this.selected;
        if (!track) {
          this.toast('Erst einen Track in der Bibliothek auswählen (Browse-Regler drehen oder anklicken).', 'warn');
          break;
        }
        this.loadTrack(t, track);
        break;
      }
      case 'loadSuggested': this.ui?.showSuggestions(); break;
      case 'browse': this.ui?.moveSelection(a); break;
      case 'browseClick': this.ui?.toggleBrowseFocus(); break;
      case 'browseBack': this.ui?.toggleBrowseFocus(); break;
      case 'splitCue':
        this.settings.routing = this.settings.routing === 'split' ? 'auto' : 'split';
        e.routing = this.settings.routing;
        e.configureOutput();
        this.saveSettings();
        this.toast(this.settings.routing === 'split' ? 'Split-Cue: links Master, rechts Vorhören' : 'Ausgabe: normal');
        break;
      case 'toggleView':
        this.settings.fourDecks = !this.settings.fourDecks;
        this.saveSettings();
        this.ui?.layout();
        break;
      case 'record':
        if (!this.started) break;
        e.recorder ? e.stopRecording() : e.startRecording();
        break;
      case 'gridHalf': this.editGrid(d, (i) => ({ ...i, bpm: i.bpm / 2 })); break;
      case 'gridDouble': this.editGrid(d, (i) => ({ ...i, bpm: i.bpm * 2 })); break;
      case 'gridHere': this.editGrid(d, (i) => {
        const beat = 60 / i.bpm;
        let off = d.position;
        while (off - beat * 4 >= 0) off -= beat * 4;
        return { ...i, beatOffset: off };
      }); break;
      case 'gridNudge': this.editGrid(d, (i) => ({ ...i, beatOffset: i.beatOffset + a })); break;
      case 'gridBpm': this.editGrid(d, (i) => ({ ...i, bpm: a })); break;
    }
    this.ui?.dirty();
  }

  focusDeck(i) {
    if (!this.settings.fourDecks) return;
    this.focus[i % 2] = i;
  }

  editGrid(d, fn) {
    if (!d?.info || !d.info.bpm) return;
    d.info = fn(d.info);
    this.library.updateGrid(d.track, d.info);
  }
}
