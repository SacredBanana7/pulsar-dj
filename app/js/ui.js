// Pulsar user interface: decks, waveforms, mixer, FX, library and dialogs.

import { h, setText, setClass, setStyle, Knob, Fader } from './controls.js';
import { ScrollingWave, Overview, drawPhase, DECK_COLORS } from './waveform.js';
import { HOTCUE_COLORS, ROLL_BEATS, LOOP_BEATS, JUMP_BEATS } from './deck.js';
import { FX_TYPES, FX_GROUPS, FxUnit } from './fx.js';
import { keyColor, camelotDistance, bpmDistance } from './library.js';
import { OnlinePanel, licenseBadge } from './ui-online.js';
import LibFormat from './libformat.js';
import { classify, TAXONOMY, GENRES } from './genres.js';

const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const fmtLen = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
const fmtBeats = (b) => {
  if (!b) return '–';
  if (b >= 1) return String(Math.round(b * 100) / 100);
  return `1/${Math.round(1 / b)}`;
};
const PAD_LABELS = {
  hotcue: (i) => String(i + 1),
  roll: (i) => fmtBeats(ROLL_BEATS[i]),
  loop: (i) => fmtBeats(LOOP_BEATS[i]),
  jump: (i) => (JUMP_BEATS[i] > 0 ? `+${JUMP_BEATS[i]}` : String(JUMP_BEATS[i])),
};
const PAD_MODES = [['hotcue', 'Hot Cue'], ['roll', 'Roll'], ['loop', 'Loop'], ['jump', 'Jump']];
const ROW_H = 30;
// Screen order of the decks, like the channels of a 4-channel mixer: C A | B D
const DECK_ORDER = [2, 0, 1, 3];

export class UI {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.decks = [];
    this.waves = [];
    this.strips = [];
    this.libView = 'all';
    this.search = '';
    this.sort = { key: 'addedAt', dir: -1 };
    this.rows = [];
    this.libDirty = true;
    this.browseFocus = 'list';
    this.onlineFocus = false;    // browse knob / LOAD act on the free-music list
    app.ui = this;
    app.library.onChange(() => { this.libDirty = true; });
    app.midi.onUpdate = (fromMsg) => { if (!fromMsg) this.renderMidiStatus(); };
    this.build();
    this.layout();
    this.bindKeys();
  }

  // ======================= build =======================
  build() {
    const a = this.app;
    this.toastBox = h('div', { class: 'toasts' });
    this.topbar = this.buildTopbar();
    this.waveArea = h('section', { class: 'waves' });
    const waveRows = [0, 1, 2, 3].map((i) => this.buildWaveRow(i));
    this.waveArea.append(...DECK_ORDER.map((i) => waveRows[i]));
    this.fxBar = this.buildFx();
    const left = h('div', { class: 'deck-side left' });
    const right = h('div', { class: 'deck-side right' });
    for (let i = 0; i < 4; i++) {
      const p = this.buildDeck(i);
      (i % 2 === 0 ? left : right).append(p.el);
      this.decks.push(p);
    }
    this.mixer = this.buildMixer();
    this.console = h('main', { class: 'console' }, left, this.mixer, right);
    this.libraryEl = this.buildLibrary();
    this.root.append(this.topbar, this.waveArea, this.fxBar, this.console, this.libraryEl, this.toastBox);
    this.root.append(this.buildStartOverlay());
    this.settingsEl = this.buildSettings();
    this.root.append(this.settingsEl);

    // drag & drop audio files anywhere / onto decks
    this.root.addEventListener('dragover', (e) => { e.preventDefault(); });
    this.root.addEventListener('drop', async (e) => {
      e.preventDefault();
      const deckEl = e.target.closest('[data-deck]');
      const openKey = e.dataTransfer.getData('text/pulsar-open');
      if (openKey) {
        const r = this.online.results.get(openKey);
        if (r) this.online.load(deckEl ? Number(deckEl.dataset.deck) : this.online.freeDeck(), r);
        return;
      }
      const id = e.dataTransfer.getData('text/pulsar-track');
      if (id) {
        const t = a.library.tracks.get(id);
        if (deckEl && t) a.loadTrack(Number(deckEl.dataset.deck), t);
        return;
      }
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      const added = await a.library.addFiles(files);
      if (deckEl && added[0]) a.loadTrack(Number(deckEl.dataset.deck), added[0]);
      else if (added.length) this.toast(`${added.length} Track(s) importiert`);
    });

    // MIDI learn: click a control while learning
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('learning')) return;
      const el = e.target.closest('[data-learn]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.learn-target').forEach((x) => x.classList.remove('learn-target'));
      el.classList.add('learn-target');
      a.midi.startLearn(JSON.parse(el.dataset.learn));
      this.toast('Jetzt Regler oder Taste am Controller bewegen …');
    }, true);
  }

  buildTopbar() {
    const a = this.app;
    this.clockBpm = h('span', { class: 'clock-bpm' }, '—');
    this.recBtn = h('button', { class: 'btn rec', title: 'Mix aufnehmen', onclick: () => a.act('record') }, h('span', { class: 'rec-dot' }), h('span', { class: 'rec-label' }, 'REC'));
    this.midiStatus = h('div', { class: 'status midi' }, h('span', { class: 'dot' }), h('span', { class: 'txt' }, 'MIDI …'));
    this.audioStatus = h('div', { class: 'status audio' }, h('span', { class: 'dot' }), h('span', { class: 'txt' }, 'Audio aus'));
    this.masterMeter = h('div', { class: 'master-meter' }, h('div', { class: 'mm l' }), h('div', { class: 'mm r' }));
    this.viewBtn = h('button', { class: 'btn ghost', onclick: () => a.act('toggleView'), title: '2 oder 4 Decks (Panel-Taste am DDJ-SX)' }, '2 Decks');
    this.learnBtn = h('button', { class: 'btn ghost', onclick: () => this.toggleLearn(), title: 'MIDI-Learn für andere Controller' }, 'MIDI-Learn');
    return h('header', { class: 'topbar' },
      h('div', { class: 'brand' },
        h('div', { class: 'logo' }, h('i'), h('i'), h('i')),
        h('span', {}, 'PULSAR'), h('small', {}, 'DJ')),
      h('div', { class: 'clock' }, h('small', {}, 'MASTER'), this.clockBpm, h('small', {}, 'BPM')),
      this.masterMeter,
      h('div', { class: 'spacer' }),
      this.recBtn,
      this.viewBtn,
      this.learnBtn,
      this.midiStatus,
      this.audioStatus,
      h('button', { class: 'btn icon', title: 'Einstellungen', onclick: () => this.openSettings() }, '⚙'));
  }

  buildWaveRow(i) {
    const a = this.app;
    const canvas = h('canvas', { class: 'wave' });
    const phase = h('canvas', { class: 'phase' });
    const label = h('div', { class: 'wave-label', style: { '--deck': DECK_COLORS[i] } }, 'ABCD'[i]);
    const row = h('div', { class: `wave-row deck-${i}`, 'data-deck': i }, label, h('div', { class: 'wave-wrap' }, canvas, phase));
    const sw = new ScrollingWave(canvas, a.decks[i]);
    // drag on the waveform scrubs like a platter
    canvas.addEventListener('pointerdown', (e) => {
      const d = a.decks[i];
      if (!d.loaded) return;
      canvas.setPointerCapture(e.pointerId);
      a.act('jogTouch', i, true);
      const pxPerSec = canvas.clientWidth / (7 * sw.zoom);
      let last = e.clientX;
      const move = (ev) => {
        const dx = last - ev.clientX;
        last = ev.clientX;
        const frames = (dx / pxPerSec) * d.sr;
        if (d.vinyl) d.send({ type: 'scratchMove', frames });
        else d.seek(d.position + dx / pxPerSec);
      };
      const up = () => {
        a.act('jogTouch', i, false);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      sw.zoom = Math.max(0.25, Math.min(4, sw.zoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
    this.waves.push({ row, wave: sw, phase });
    return row;
  }

  buildDeck(i) {
    const a = this.app, d = a.decks[i];
    const color = DECK_COLORS[i];
    const r = {};
    const btn = (label, action, cls = '', learn, extra = {}) => h('button', {
      class: `btn ${cls}`,
      learn: learn || { action, target: i },
      onclick: () => a.act(action, i),
      ...extra,
    }, label);

    r.title = h('div', { class: 'title' }, 'Kein Track geladen');
    r.artist = h('div', { class: 'artist' }, 'Track hierher ziehen oder in der Bibliothek doppelklicken');
    r.key = h('span', { class: 'key-badge' }, '–');
    r.bpm = h('div', { class: 'bpm' }, '—');
    r.bpmBase = h('div', { class: 'bpm-base' }, '');
    r.pitch = h('div', { class: 'pitch' }, '0.00 %');
    r.time = h('div', { class: 'time' }, '0:00.0');
    r.remain = h('div', { class: 'remain' }, '-0:00.0');
    r.loading = h('div', { class: 'loading-bar' });
    r.overview = h('canvas', { class: 'overview' });
    r.ov = new Overview(r.overview, d, (sec) => a.act('seek', i, sec));

    // deck switch (4-deck mode)
    const pair = i % 2 === 0 ? [2, 0] : [1, 3];
    r.switch = h('div', { class: 'deck-switch' }, pair.map((k) =>
      h('button', { class: `sw sw-${k}`, style: { '--deck': DECK_COLORS[k] }, onclick: () => { a.focus[i % 2] = k; this.layout(); } }, 'ABCD'[k])));

    // platter
    r.platter = h('canvas', { class: 'platter' });
    this.bindPlatter(r.platter, i);

    // pitch fader (top = minus, like Pioneer)
    r.pitchFader = new Fader({
      value: 0.5, def: 0.5, cls: 'pitch-fader',
      learn: { action: 'tempoAbs', target: i },
      onInput: (v) => a.act('tempo', i, (1 - v) * 2 - 1),
    });
    r.range = h('button', { class: 'btn tiny', onclick: () => a.act('range', i), learn: { action: 'range', target: i } }, '±8');

    r.play = btn('▶❚❚', 'play', 'play big');
    r.cue = h('button', { class: 'btn cue big', learn: { action: 'cue', target: i, hold: true } }, 'CUE');
    r.cue.addEventListener('pointerdown', () => a.act('cueDown', i));
    r.cue.addEventListener('pointerup', () => a.act('cueUp', i));
    r.cue.addEventListener('pointerleave', (e) => { if (e.buttons) a.act('cueUp', i); });
    r.sync = btn('SYNC', 'sync', 'sync');
    r.master = btn('MASTER', 'master', 'tiny');
    r.keylock = btn('KEY', 'keylock', 'tiny', null, { title: 'Key Lock: Tonhöhe bleibt beim Tempo ändern' });
    r.slip = btn('SLIP', 'slip', 'tiny', null, { title: 'Slip: nach Scratch/Loop läuft der Track weiter, als wäre nichts passiert' });
    r.vinyl = btn('VINYL', 'vinyl', 'tiny', null, { title: 'Vinyl-Modus: Jogwheel-Oberfläche scratcht' });
    r.quant = btn('Q', 'quantize', 'tiny', null, { title: 'Quantize: Cues und Loops rasten auf den Beat ein' });
    r.rev = h('button', { class: 'btn tiny', learn: { action: 'reverse', target: i }, onclick: () => a.act('reverse', i), title: 'Rückwärts' }, 'REV');

    // loop section
    r.loopLen = h('div', { class: 'loop-len' }, '4');
    r.loopAuto = btn('LOOP', 'autoLoop', 'loop-auto');
    const loopRow = h('div', { class: 'loop-row' },
      btn('IN', 'loopIn', 'tiny'), btn('OUT', 'loopOut', 'tiny'), btn('RELOOP', 'reloop', 'tiny'),
      btn('½', 'loopHalf', 'tiny'), r.loopLen, btn('×2', 'loopDouble', 'tiny'), r.loopAuto,
      h('button', { class: 'btn tiny', onclick: () => a.act('beatJump', i, -(d.loop.beats || 4)), title: 'Beatjump zurück' }, '◀◀'),
      h('button', { class: 'btn tiny', onclick: () => a.act('beatJump', i, d.loop.beats || 4), title: 'Beatjump vor' }, '▶▶'));

    // pads
    r.modeBtns = PAD_MODES.map(([m, label]) => h('button', { class: 'mode', onclick: () => { a.padMode[i] = m; this.dirty(); } }, label));
    r.pads = [];
    const padGrid = h('div', { class: 'pads' });
    for (let p = 0; p < 8; p++) {
      const pad = h('button', { class: 'pad', learn: { action: 'hotcue', target: i, arg: p, hold: true } }, h('span', {}, String(p + 1)));
      pad.addEventListener('pointerdown', (e) => { a.uiShift = e.shiftKey || e.button === 2; a.act('pad', i, p, true); });
      pad.addEventListener('pointerup', () => a.act('pad', i, p, false));
      pad.addEventListener('contextmenu', (e) => e.preventDefault());
      padGrid.append(pad);
      r.pads.push(pad);
    }

    // grid editing
    r.gridMenu = h('div', { class: 'grid-menu' },
      h('button', { class: 'btn tiny', onclick: () => a.act('gridHalf', i), title: 'BPM halbieren' }, '÷2'),
      h('button', { class: 'btn tiny', onclick: () => a.act('gridDouble', i), title: 'BPM verdoppeln' }, '×2'),
      h('button', { class: 'btn tiny', onclick: () => a.act('gridNudge', i, -0.01), title: 'Grid 10 ms früher' }, '◂'),
      h('button', { class: 'btn tiny', onclick: () => a.act('gridNudge', i, 0.01), title: 'Grid 10 ms später' }, '▸'),
      h('button', { class: 'btn tiny', onclick: () => a.act('gridHere', i), title: 'Takt-Eins auf aktuelle Position setzen' }, '1 HIER'),
      h('button', { class: 'btn tiny', onclick: () => this.tapTempo(i), title: 'Tempo eintippen' }, 'TAP'));

    const el = h('section', { class: `deck deck-${i}`, 'data-deck': i, style: { '--deck': color } },
      h('div', { class: 'deck-head' },
        h('div', { class: 'deck-letter' }, 'ABCD'[i]),
        r.switch,
        h('div', { class: 'meta' }, r.title, h('div', { class: 'artist-line' }, r.artist, r.lic = h('span', { class: 'deck-lic' }))),
        h('div', { class: 'tempo-box' }, r.key, h('div', { class: 'bpm-wrap' }, r.bpm, r.bpmBase))),
      h('div', { class: 'deck-sub' },
        h('div', { class: 'times' }, r.time, r.remain),
        r.pitch,
        r.gridMenu),
      h('div', { class: 'ov-wrap' }, r.overview, r.loading),
      h('div', { class: 'deck-body' },
        h('div', { class: 'deck-left' },
          h('div', { class: 'platter-wrap' }, r.platter),
          h('div', { class: 'transport' }, r.cue, r.play)),
        h('div', { class: 'deck-mid' },
          h('div', { class: 'toggles' }, r.sync, r.master, r.keylock, r.slip, r.vinyl, r.quant, r.rev),
          loopRow,
          h('div', { class: 'pad-modes' }, r.modeBtns),
          padGrid),
        h('div', { class: 'deck-pitch' }, r.range, r.pitchFader.el)));
    return { el, r };
  }

  bindPlatter(canvas, i) {
    const a = this.app;
    canvas.addEventListener('pointerdown', (e) => {
      const d = a.decks[i];
      if (!d.loaded) return;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      let last = Math.atan2(e.clientY - cy, e.clientX - cx);
      const outer = Math.hypot(e.clientX - cx, e.clientY - cy) > rect.width * 0.42;
      if (!outer) a.act('jogTouch', i, true);
      const move = (ev) => {
        const ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        let da = ang - last;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        last = ang;
        a.act('jog', i, (da / (2 * Math.PI)) * 2048 * (outer ? 0.08 : 1), outer);
      };
      const up = () => {
        if (!outer) a.act('jogTouch', i, false);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
  }

  buildMixer() {
    const a = this.app;
    const channels = h('div', { class: 'channels' });
    for (let i = 0; i < 4; i++) {
      const d = a.decks[i];
      const s = {};
      s.trim = new Knob({ label: 'GAIN', value: 0.5, size: 's', onInput: (v) => a.act('trim', i, v), learn: { action: 'trim', target: i } });
      s.high = new Knob({ label: 'HI', value: 0.5, size: 's', kill: true, onInput: (v) => a.act('eq', i, 'high', v), learn: { action: 'eq', target: i, arg: 'high' } });
      s.mid = new Knob({ label: 'MID', value: 0.5, size: 's', kill: true, onInput: (v) => a.act('eq', i, 'mid', v), learn: { action: 'eq', target: i, arg: 'mid' } });
      s.low = new Knob({ label: 'LOW', value: 0.5, size: 's', kill: true, onInput: (v) => a.act('eq', i, 'low', v), learn: { action: 'eq', target: i, arg: 'low' } });
      s.filter = new Knob({ label: 'FILTER', value: 0.5, size: 's', color: 'var(--filter)', onInput: (v) => a.act('filter', i, v), learn: { action: 'filter', target: i } });
      s.cue = h('button', { class: 'btn cue-btn', onclick: () => a.act('headCue', i), learn: { action: 'headCue', target: i } }, '🎧');
      s.fader = new Fader({ value: d.mix.volume, onInput: (v) => a.act('volume', i, v), learn: { action: 'volume', target: i } });
      s.meter = h('div', { class: 'vu' }, h('div', { class: 'vu-fill' }));
      s.xf = h('div', { class: 'xf-assign' }, ['A', 'THRU', 'B'].map((x) =>
        h('button', { class: 'xa', 'data-x': x, onclick: () => a.act('xfAssign', i, x) }, x === 'THRU' ? '·' : x)));
      const el = h('div', { class: `strip deck-${i}`, style: { '--deck': DECK_COLORS[i] }, 'data-deck': i },
        h('div', { class: 'strip-head' }, 'ABCD'[i]),
        h('div', { class: 'strip-body' },
          h('div', { class: 'strip-knobs' }, s.trim.el, s.high.el, s.mid.el, s.low.el, s.filter.el),
          h('div', { class: 'strip-fader' }, s.cue, h('div', { class: 'fader-row' }, s.meter, s.fader.el))),
        s.xf);
      s.el = el;
      this.strips.push(s);
    }
    channels.append(...DECK_ORDER.map((i) => this.strips[i].el));
    this.xfader = new Fader({ value: 0.5, def: 0.5, horizontal: true, cls: 'xfader', onInput: (v) => a.act('xfader', 0, v), learn: { action: 'xfader', target: 0 } });
    this.masterKnob = new Knob({ label: 'MASTER', value: a.engine.masterVol, def: 0.8, bipolar: false, color: 'var(--text)', onInput: (v) => a.act('masterVol', 0, v), learn: { action: 'masterVol', target: 0 } });
    this.headMixKnob = new Knob({ label: 'CUE/MST', value: 0, def: 0.5, bipolar: false, color: 'var(--cue)', onInput: (v) => a.act('headMix', 0, v), learn: { action: 'headMix', target: 0 } });
    this.headVolKnob = new Knob({ label: 'PHONES', value: a.engine.headVol, def: 0.8, bipolar: false, color: 'var(--cue)', onInput: (v) => a.act('headVol', 0, v), learn: { action: 'headVol', target: 0 } });
    this.xfCurveKnob = new Knob({ label: 'X-CURVE', value: a.engine.xfCurve, def: 0.5, bipolar: false, size: 's', onInput: (v) => a.act('xfCurve', 0, v) });
    return h('section', { class: 'mixer' },
      channels,
      h('div', { class: 'mixer-master' }, this.masterKnob.el, this.headMixKnob.el, this.headVolKnob.el, this.xfCurveKnob.el),
      h('div', { class: 'xf-wrap' }, h('span', {}, 'A'), this.xfader.el, h('span', {}, 'B')));
  }

  buildFx() {
    const a = this.app;
    this.fx = a.engine.fxUnits.map((u, ui) => {
      const r = { slots: [] };
      u.slots.forEach((s, si) => {
        const sel = h('select', { class: 'fx-type', onchange: (e) => a.act('fxType', ui, si, e.target.value) },
          Object.entries(FX_GROUPS).map(([group, types]) => h('optgroup', { label: group },
            types.map((k) => h('option', { value: k, selected: k === s.type }, FX_TYPES[k])))));
        const knob = new Knob({ value: s.level, def: 0.5, bipolar: false, size: 's', color: 'var(--fx)', onInput: (v) => a.act('fxLevel', ui, si, v), learn: { action: 'fxLevel', target: ui, arg: si } });
        const on = h('button', { class: 'btn tiny fx-on', onclick: () => a.act('fxSlot', ui, si), learn: { action: 'fxSlot', target: ui, arg: si } }, 'ON');
        r.slots.push({ sel, knob, on });
      });
      r.beats = h('div', { class: 'fx-beats' }, '1');
      r.assign = [0, 1, 2, 3].map((d) => h('button', { class: `fx-assign deck-${d}`, style: { '--deck': DECK_COLORS[d] }, onclick: () => a.act('fxAssign', ui, d), learn: { action: 'fxAssign', target: ui, arg: d } }, 'ABCD'[d]));
      r.el = h('div', { class: 'fx-unit' },
        h('div', { class: 'fx-name' }, `FX ${ui + 1}`),
        h('div', { class: 'fx-assigns' }, DECK_ORDER.map((d) => r.assign[d])),
        r.slots.map((s) => h('div', { class: 'fx-slot' }, s.sel, s.knob.el, s.on)),
        h('div', { class: 'fx-beat-box' },
          h('button', { class: 'btn tiny', onclick: () => a.act('fxBeats', ui, -1) }, '−'),
          h('div', {}, h('small', {}, 'BEATS'), r.beats),
          h('button', { class: 'btn tiny', onclick: () => a.act('fxBeats', ui, 1) }, '+')));
      return r;
    });
    return h('section', { class: 'fx-bar' }, this.fx[0].el, h('div', { class: 'fx-gap' }), this.fx[1].el);
  }

  buildLibrary() {
    const a = this.app;
    this.navItems = {};
    const nav = (id, label, extra) => {
      const el = h('button', { class: 'nav-item', onclick: () => { this.libView = id; this.libDirty = true; this.scrollTop(); } }, label, extra);
      this.navItems[id] = el;
      return el;
    };
    this.rootsBox = h('div', { class: 'roots' });
    this.analyzeBtn = h('button', { class: 'btn ghost wide', onclick: () => this.analyzeAll() }, 'Alle analysieren');
    this.reconnectBtn = h('button', { class: 'btn warn wide', onclick: async () => { if (await a.library.reconnect()) this.toast('Ordner verbunden'); } }, 'Ordner neu verbinden');
    const sidebar = h('aside', { class: 'lib-side' },
      h('div', { class: 'lib-actions' },
        h('button', { class: 'btn primary wide', onclick: () => this.addFolder() }, '+ Musikordner'),
        h('label', { class: 'btn ghost wide file-btn' }, 'Dateien …',
          h('input', { type: 'file', multiple: true, accept: 'audio/*', onchange: async (e) => { await a.library.addFiles([...e.target.files]); e.target.value = ''; } })),
        this.reconnectBtn),
      nav('all', 'Sammlung', h('span', { class: 'count' })),
      nav('online', h('span', {}, 'Freie Musik ', h('small', { class: 'sub' }, 'CC · online')), null),
      nav('foryou', h('span', {}, 'Für dich ', h('small', { class: 'sub foryou-sub' })), null),
      h('div', { class: 'nav-label' }, 'Genres'),
      this.genreBox = h('div', { class: 'genre-box' }),
      nav('downloaded', 'Offline gespeichert', h('span', { class: 'sub dl-count' })),
      h('div', { class: 'nav-label' }, 'Passt zu …'),
      ...DECK_ORDER.map((d) => nav(`match${d}`, h('span', {}, h('b', { style: { color: DECK_COLORS[d] } }, 'Deck ' + 'ABCD'[d])), h('span', { class: 'sub' }))),
      h('div', { class: 'nav-label nav-pl' }, 'Playlists', h('button', { class: 'nav-add', title: 'Neue Playlist', onclick: () => this.newPlaylist() }, '+')),
      this.plBox = h('div', { class: 'pl-box' }),
      h('div', { class: 'nav-label' }, 'Sitzung'),
      nav('history', 'Verlauf'),
      nav('unanalyzed', 'Nicht analysiert'),
      h('div', { class: 'nav-label' }, 'Ordner'),
      this.rootsBox,
      this.analyzeBtn);
    this.online = new OnlinePanel(this);
    this.searchInput = h('input', {
      class: 'search', type: 'search', placeholder: 'Suchen – deine Sammlung und freie Musik online: Titel, Artist, Genre, 8A, 124 …',
      oninput: (e) => { this.search = e.target.value; this.libDirty = true; this.scrollTop(); this.online.setQuery(this.search); },
    });
    this.libInfo = h('div', { class: 'lib-info' });
    const cols = [
      ['', ''], ['title', 'Titel'], ['artist', 'Artist'], ['bpm', 'BPM'], ['camelot', 'Key'], ['duration', 'Zeit'], ['genre', 'Genre'], ['plays', '▶'],
    ];
    this.thead = h('div', { class: 'lib-row lib-head' }, cols.map(([k, label]) =>
      h('div', { class: `c c-${k || 'state'}`, onclick: () => { if (!k) return; this.sort = { key: k, dir: this.sort.key === k ? -this.sort.dir : 1 }; this.libDirty = true; } }, label)));
    this.listInner = h('div', { class: 'lib-inner' });
    this.list = h('div', { class: 'lib-list', tabindex: 0 }, this.listInner);
    this.list.addEventListener('scroll', () => this.renderRows());
    this.emptyLib = h('div', { class: 'lib-empty' },
      h('div', { class: 'big' }, 'Deine Musik gehört hierher'),
      h('p', {}, 'Wähle deinen Musikordner. Pulsar liest Titel und Tags und analysiert BPM, Beatgrid und Tonart. Die Dateien bleiben dabei auf deinem PC.'),
      h('button', { class: 'btn primary', onclick: () => this.addFolder() }, '+ Musikordner wählen'));
    return h('section', { class: 'library' },
      sidebar,
      h('div', { class: 'lib-main' },
        h('div', { class: 'lib-top' }, this.searchInput, this.libInfo, h('div', { class: 'spacer' }), this.libTools()),
        this.localEl = h('div', { class: 'lib-local' }, this.thead, this.list, this.emptyLib),
        this.online.el));
  }

  // import / export menu in the library header
  libTools() {
    const a = this.app;
    const file = h('input', { type: 'file', accept: '.json,.xml,.m3u,.m3u8,application/json,text/xml', style: { display: 'none' }, onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const res = await LibFormat.importAny(a.library, await f.text(), { name: f.name });
        const kind = { json: 'Pulsar-Bibliothek', rekordbox: 'Rekordbox-XML', m3u: 'Playlist' }[res.kind] || res.kind;
        const n = res.matched ?? res.tracks ?? 0;
        const lists = res.playlistsCreated || res.playlists || 0;
        const missing = (res.missing || res.unmatched || []).length;
        this.toast(`${kind} importiert: ${n} Tracks zugeordnet${lists ? `, ${lists} Playlist(s)` : ''}${missing ? `, ${missing} nicht gefunden` : ''}`);
      } catch (err) {
        this.toast('Import fehlgeschlagen: ' + (err.message || err), 'error');
      }
    } });
    const save = (text, name, type) => {
      const url = URL.createObjectURL(new Blob([text], { type }));
      h('a', { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    };
    const menu = h('div', { class: 'menu hidden' },
      h('button', { onclick: async () => save(await LibFormat.exportLibraryJSON(a.library), 'pulsar-library.json', 'application/json') }, 'Sammlung als JSON (offenes Format)'),
      h('button', { onclick: async () => {
        const base = prompt('In welchem Ordner liegt dein Musikordner? (z. B. C:/Users/Name/Music)\nRekordbox braucht vollständige Pfade.', localStorage.getItem('pulsar.rbBase') || '');
        if (base == null) return;
        localStorage.setItem('pulsar.rbBase', base);
        save(await LibFormat.exportRekordboxXML(a.library, { basePath: base }), 'pulsar-rekordbox.xml', 'text/xml');
      } }, 'Rekordbox-XML'),
      this.m3uBtn = h('button', { onclick: () => {
        const id = this.libView.slice(3);
        const pl = a.library.playlists.find((p) => p.id === id);
        if (pl) save(LibFormat.playlistToM3U8(a.library, id), `${pl.name}.m3u8`, 'audio/x-mpegurl');
      } }, 'Diese Playlist als M3U8'),
      h('hr'),
      h('button', { onclick: () => file.click() }, 'Importieren … (JSON, Rekordbox-XML, M3U)'));
    const btn = h('button', { class: 'btn ghost tiny', onclick: (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
      this.m3uBtn.classList.toggle('hidden', !this.libView.startsWith('pl:'));
    } }, 'Import / Export ▾');
    document.addEventListener('click', () => menu.classList.add('hidden'));
    return h('div', { class: 'menu-wrap' }, btn, menu, file);
  }

  async newPlaylist() {
    const name = prompt('Name der Playlist:', 'Neue Playlist');
    if (!name) return;
    const pl = await this.app.library.createPlaylist(name, this.selected ? [this.selected] : []);
    this.libView = `pl:${pl.id}`;
    this.libDirty = true;
  }

  // genre per track, cached until the track's tags/bpm change
  genreOf(t) {
    const key = `${t.genre}|${(t.tags || []).join(',')}|${Math.round(t.bpm || 0)}`;
    if (t._gk !== key) {
      Object.defineProperty(t, '_g', { value: classify(t), writable: true, configurable: true, enumerable: false });
      Object.defineProperty(t, '_gk', { value: key, writable: true, configurable: true, enumerable: false });
    }
    return t._g;
  }

  genreRank(t) {
    const g = this.genreOf(t);
    const fi = TAXONOMY.findIndex((f) => f.id === g.family);
    const gi = fi >= 0 ? TAXONOMY[fi].genres.findIndex((x) => x.id === g.id) : 0;
    return fi < 0 ? 999 : fi * 20 + gi;
  }

  // sidebar: families ordered by the learned style, genres with counts, only non-empty ones
  renderGenres(collection) {
    const st = this.app.style;
    const counts = new Map();
    for (const t of collection) {
      const g = this.genreOf(t);
      counts.set(g.id, (counts.get(g.id) || 0) + 1);
      counts.set(`fam:${g.family}`, (counts.get(`fam:${g.family}`) || 0) + 1);
    }
    this.genreOpen = this.genreOpen || new Set();
    const fams = [...st.familyOrder(), { id: 'unknown', label: 'Unsortiert', color: '#555b66', genres: [{ id: 'unknown', label: 'Unbekannt' }] }];
    const items = [];
    for (const f of fams) {
      const n = counts.get(`fam:${f.id}`) || 0;
      if (!n) continue;
      const open = this.genreOpen.has(f.id) || this.libView === `fam:${f.id}` || f.genres.some((g) => this.libView === `gen:${g.id}`);
      const liked = st.families[f.id] > 0;
      items.push(h('button', { class: `nav-item fam${this.libView === `fam:${f.id}` ? ' on' : ''}`, onclick: () => {
        open && this.libView === `fam:${f.id}` ? this.genreOpen.delete(f.id) : this.genreOpen.add(f.id);
        this.libView = `fam:${f.id}`; this.libDirty = true; this.scrollTop();
      } },
      h('span', {}, h('i', { class: 'gdot', style: { background: f.color } }), f.label, liked ? h('small', { class: 'liked', title: 'gehört zu deinem Stil' }, ' ♥') : null),
      h('span', { class: 'count' }, String(n))));
      if (!open) continue;
      for (const g of f.genres) {
        const c = counts.get(g.id) || 0;
        if (!c) continue;
        items.push(h('button', { class: `nav-item gen${this.libView === `gen:${g.id}` ? ' on' : ''}`, onclick: () => { this.libView = `gen:${g.id}`; this.libDirty = true; this.scrollTop(); } },
          h('span', {}, g.label), h('span', { class: 'count' }, String(c))));
      }
    }
    if (!items.length) items.push(h('div', { class: 'root muted' }, 'erscheinen, sobald Tracks da sind'));
    this.genreBox.replaceChildren(...items);
    const top = st.topGenres(2);
    setText(this.navItems.foryou.querySelector('.foryou-sub'), top.length ? top.map((g) => g.label).join(', ') : 'lernt beim Auflegen');
  }

  renderPlaylists() {
    const lib = this.app.library;
    this.plBox.replaceChildren(...(lib.playlists || []).map((p) => {
      const id = `pl:${p.id}`;
      const el = h('button', {
        class: `nav-item pl${this.libView === id ? ' on' : ''}`,
        onclick: () => { this.libView = id; this.libDirty = true; this.scrollTop(); },
        ondragover: (e) => { e.preventDefault(); el.classList.add('drop'); },
        ondragleave: () => el.classList.remove('drop'),
        ondrop: async (e) => {
          e.preventDefault();
          e.stopPropagation();
          el.classList.remove('drop');
          const tid = e.dataTransfer.getData('text/pulsar-track');
          const ok = e.dataTransfer.getData('text/pulsar-open');
          let t = tid ? lib.tracks.get(tid) : null;
          if (!t && ok) {
            const r = this.online.results.get(ok);
            if (r) { this.toast('Track wird offline gespeichert …'); t = await lib.downloadOpenTrack(r); }
          }
          if (t) { await lib.addToPlaylist(p.id, [t]); this.toast(`Zu „${p.name}“ hinzugefügt`); }
        },
      },
      h('span', {}, '♫ ', p.name),
      h('span', { class: 'pl-tools' },
        h('span', { class: 'count' }, String(p.trackIds.length)),
        h('i', { title: 'Umbenennen', onclick: async (e) => { e.stopPropagation(); const n = prompt('Neuer Name:', p.name); if (n) await lib.renamePlaylist(p.id, n); } }, '✎'),
        h('i', { title: 'Löschen', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Playlist „${p.name}“ löschen? Die Tracks bleiben in der Sammlung.`)) return;
          await lib.deletePlaylist(p.id);
          if (this.libView === id) this.libView = 'all';
          this.libDirty = true;
        } }, '✕')));
      return el;
    }));
    if (!lib.playlists?.length) this.plBox.append(h('div', { class: 'root muted' }, 'Mit + anlegen, dann Tracks hierher ziehen'));
  }

  buildStartOverlay() {
    const a = this.app;
    this.overlay = h('div', { class: 'overlay start' },
      h('div', { class: 'start-card' },
        h('div', { class: 'logo big' }, h('i'), h('i'), h('i')),
        h('h1', {}, 'PULSAR'),
        h('p', {}, '4 Decks · Key Lock · Slip · Sync · Harmonic Mixing · 140+ Controller · freie Musik'),
        h('button', { class: 'btn primary huge', onclick: async () => {
          await a.start();
          this.overlay.remove();
          this.renderAudioStatus();
        } }, 'Starten'),
        h('small', {}, 'Am besten zuerst den Controller per USB anschließen.')));
    return this.overlay;
  }

  buildSettings() {
    const a = this.app, s = a.settings;
    const row = (label, control, hint) => h('label', { class: 'set-row' }, h('span', {}, label, hint ? h('small', {}, hint) : null), control);
    const check = (key, after) => h('input', { type: 'checkbox', checked: s[key], onchange: (e) => { s[key] = e.target.checked; a.saveSettings(); after?.(); } });
    this.sinkSelect = h('select', { onchange: async (e) => {
      s.sinkId = e.target.value;
      a.saveSettings();
      if (a.started) { await a.engine.setSink(s.sinkId); this.renderAudioStatus(); }
    } });
    const routing = h('select', { onchange: (e) => {
      s.routing = e.target.value;
      a.engine.routing = s.routing;
      a.saveSettings();
      if (a.started) { a.engine.configureOutput(); this.renderAudioStatus(); }
    } },
      h('option', { value: 'auto', selected: s.routing === 'auto' }, 'Automatisch (DDJ-SX: Master 1/2, Kopfhörer 3/4)'),
      h('option', { value: 'stereo', selected: s.routing === 'stereo' }, 'Nur Master (Stereo)'),
      h('option', { value: 'split', selected: s.routing === 'split' }, 'Split-Cue: links Master, rechts Vorhören'));
    const range = h('select', { onchange: (e) => { s.defaultRange = Number(e.target.value); a.decks.forEach((d) => d.setRange(s.defaultRange)); a.saveSettings(); } },
      [0.06, 0.08, 0.16, 0.5].map((r) => h('option', { value: r, selected: s.defaultRange === r }, `±${r * 100} %`)));
    const jog = h('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: s.jogSensitivity, oninput: (e) => { s.jogSensitivity = Number(e.target.value); a.saveSettings(); } });
    const brake = h('input', { type: 'range', min: 0, max: 2, step: 0.1, value: s.brake, oninput: (e) => {
      s.brake = Number(e.target.value); a.saveSettings();
      a.decks.forEach((d) => d.node && d.send({ type: 'ramps', start: 0, stop: s.brake }));
    } });
    this.midiInfo = h('div', { class: 'midi-info' });
    this.midiMon = h('pre', { class: 'midi-mon' });
    const body = h('div', { class: 'settings-body' },
      h('h3', {}, 'Audio'),
      row('Ausgabegerät', this.sinkSelect),
      h('div', { class: 'set-row' }, h('span', {}, ''), h('button', { class: 'btn ghost', onclick: () => this.unlockDeviceNames() }, 'Gerätenamen anzeigen')),
      row('Ausgabe-Routing', routing),
      this.audioInfo = h('div', { class: 'hint' }),
      row('Auto-Gain', check('autoGain', () => a.engine.applyMix(a.decks)), 'gleicht unterschiedlich laute Tracks an'),
      h('h3', {}, 'Freie Musik'),
      row('Jamendo client_id', h('input', { class: 'text-in', type: 'text', placeholder: 'optional', value: s.jamendoClientId || '', onchange: (e) => { s.jamendoClientId = e.target.value.trim(); a.saveSettings(); } }),
        'kostenlos auf developer.jamendo.com, sonst läuft Jamendo über Openverse'),
      h('div', { class: 'hint' }, 'Pulsar sucht nur Musik unter Creative-Commons-Lizenz oder gemeinfreie Musik. BY = Urheber nennen, NC = nicht für kommerzielle Auftritte, ND = keine Bearbeitungen.'),
      h('h3', {}, 'Decks'),
      row('Standard Pitch-Bereich', range),
      row('Tempo-Fader umkehren', check('invertTempo'), 'oben = schneller'),
      row('Jog-Empfindlichkeit', jog),
      row('Vinyl-Bremse (Stopp)', brake, 'Sekunden'),
      row('Hot Cue Vorhören', check('hotcueGate'), 'Pad halten spielt nur im Stand'),
      row('Laufende Decks sperren', check('loadLock'), 'kein versehentliches Laden'),
      h('h3', {}, 'MIDI'),
      this.midiInfo,
      h('div', { class: 'set-row' }, h('span', {}, 'Gelernte Zuweisungen'), h('button', { class: 'btn ghost', onclick: () => { a.midi.clearLearned(); this.toast('MIDI-Learn zurückgesetzt'); } }, 'Zurücksetzen')),
      h('div', { class: 'hint' }, 'MIDI-Monitor (letzte Nachrichten):'),
      this.midiMon,
      h('h3', {}, 'Tastatur'),
      h('div', { class: 'keys' },
        ...[['Q / P', 'Play Deck A / B'], ['W / O', 'Cue Deck A / B'], ['1–8', 'Hot Cues Deck A'], ['Shift + 1–8', 'Hot Cues Deck B'], ['← / →', 'Track in Deck A / B laden'], ['↑ / ↓', 'In der Bibliothek blättern'], ['S / L', 'Sync Deck A / B'], ['Strg + F', 'Suchen']]
          .map(([k, v]) => h('div', {}, h('kbd', {}, k), h('span', {}, v)))));
    return h('div', { class: 'overlay settings hidden', onclick: (e) => { if (e.target === e.currentTarget) this.closeSettings(); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' }, h('h2', {}, 'Einstellungen'), h('button', { class: 'btn icon', onclick: () => this.closeSettings() }, '✕')),
        body));
  }

  // ======================= behaviour =======================
  layout() {
    const four = this.app.settings.fourDecks;
    document.body.classList.toggle('four', four);
    setText(this.viewBtn, four ? '4 Decks' : '2 Decks');
    if (!four) this.app.focus = [0, 1];
    this.decks.forEach((p, i) => {
      const shown = this.app.focus.includes(i);
      p.el.classList.toggle('hidden', !shown);
      p.r.switch.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.classList.contains(`sw-${i}`)));
    });
    this.waves.forEach((w, i) => w.row.classList.toggle('hidden', !four && i > 1));
    this.strips.forEach((s, i) => s.el.classList.toggle('hidden', !four && i > 1));
    this.fx.forEach((f) => f.assign.forEach((b, i) => b.classList.toggle('hidden', !four && i > 1)));
    this.libDirty = true;
  }

  dirty() { this.uiDirty = true; }

  refreshDeck() { this.libDirty = true; }

  toast(msg, kind = 'info') {
    const t = h('div', { class: `toast ${kind}` }, msg);
    this.toastBox.append(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3700);
  }

  toggleLearn() {
    const on = !document.body.classList.contains('learning');
    document.body.classList.toggle('learning', on);
    setClass(this.learnBtn, 'on', on);
    if (!on) {
      this.app.midi.cancelLearn();
      document.querySelectorAll('.learn-target').forEach((x) => x.classList.remove('learn-target'));
    } else this.toast('MIDI-Learn: Bedienelement anklicken, dann am Controller bewegen. Nochmal klicken zum Beenden.');
  }

  async addFolder() {
    try {
      await this.app.library.addFolder();
      this.toast('Ordner eingelesen');
    } catch (e) {
      if (e.name !== 'AbortError') this.toast(e.message || String(e), 'error');
    }
  }

  async analyzeAll() {
    const a = this.app;
    if (!a.started) await a.start();
    this.overlay?.remove();
    a.library.analyzeAll(a.engine.ctx);
  }

  tapTempo(i) {
    const now = performance.now();
    this.taps = this.taps?.deck === i && now - this.taps.last < 2000 ? this.taps : { deck: i, times: [] };
    this.taps.times.push(now);
    this.taps.last = now;
    const t = this.taps.times;
    if (t.length >= 4) {
      const avg = (t[t.length - 1] - t[0]) / (t.length - 1);
      const bpm = Math.round((60000 / avg) * 10) / 10;
      this.app.act('gridBpm', i, bpm);
      this.toast(`Deck ${'ABCD'[i]}: ${bpm} BPM`);
    }
  }

  openSettings() {
    this.settingsEl.classList.remove('hidden');
    this.fillSinks();
    this.renderAudioStatus();
    this.renderMidiStatus();
    this.monTimer = setInterval(() => {
      this.midiMon.textContent = this.app.midi.monitor.slice(0, 14).map((m) => `${m.bytes}   ${m.dev}`).join('\n') || '–';
    }, 150);
  }

  closeSettings() {
    this.settingsEl.classList.add('hidden');
    clearInterval(this.monTimer);
  }

  async unlockDeviceNames() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {}
    this.fillSinks();
  }

  async fillSinks() {
    const devs = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const s = this.app.settings;
    this.sinkSelect.replaceChildren(
      h('option', { value: '', selected: !s.sinkId }, 'Standardgerät'),
      ...outs.filter((d) => d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId, selected: s.sinkId === d.deviceId }, d.label || `Ausgabe ${i + 1}`)));
  }

  renderAudioStatus() {
    const e = this.app.engine;
    if (!e.ctx) return;
    const ch = e.outChannels;
    const max = e.ctx.destination.maxChannelCount;
    setText(this.audioStatus.querySelector('.txt'), `${Math.round(e.ctx.sampleRate / 100) / 10} kHz · ${ch === 4 ? 'Master+Phones' : 'Stereo'}`);
    this.audioStatus.classList.add('ok');
    if (this.audioInfo) {
      const lat = ((e.ctx.baseLatency || 0) + (e.ctx.outputLatency || 0)) * 1000;
      this.audioInfo.textContent = `Gerät meldet ${max} Kanäle. ${ch === 4 ? 'Master auf 1/2, Kopfhörer auf 3/4.' : 'Kopfhörer-Vorhören braucht ein Gerät mit 4 Kanälen (z. B. DDJ-SX) oder Split-Cue.'} Latenz ca. ${lat.toFixed(0)} ms.`;
    }
  }

  renderMidiStatus() {
    const m = this.app.midi;
    const txt = this.midiStatus.querySelector('.txt');
    const ctrls = m.activeControllers ? m.activeControllers() : [];
    const live = ctrls.find((c) => c.state === 'native' || c.state === 'running');
    const shortName = (n) => (n || '').replace(/^(MIDIIN\d* \(|\d+- )/, '').replace(/\)$/, '');
    if (m.error) { setText(txt, 'kein MIDI'); this.midiStatus.className = 'status midi bad'; }
    else if (live) {
      setText(txt, live.state === 'native' ? `${shortName(live.input)} verbunden` : `${shortName(live.input)} · ${live.name}`);
      this.midiStatus.className = `status midi ${live.errors ? 'warn' : 'ok'}`;
      this.midiStatus.title = live.lastError || '';
    } else if (m.inputs.length) { setText(txt, `${shortName(m.inputs[0].name)} (kein Mapping)`); this.midiStatus.className = 'status midi warn'; }
    else { setText(txt, 'Kein Controller'); this.midiStatus.className = 'status midi'; }
    if (this.midiInfo) this.renderControllerRows(m, ctrls);
    if (!m.learnTarget) document.querySelectorAll('.learn-target').forEach((x) => x.classList.remove('learn-target'));
  }

  // one row per MIDI input: chosen mapping (native DDJ-SX, Mixxx mapping or none) and its state
  renderControllerRows(m, ctrls) {
    if (m.error) { this.midiInfo.replaceChildren(m.error); return; }
    if (!m.inputs.length) {
      this.midiInfo.replaceChildren('Kein MIDI-Gerät gefunden. Controller per USB anschließen, er wird automatisch erkannt.');
      return;
    }
    const states = { native: 'nativ', running: 'aktiv', loading: 'lädt …', idle: 'bereit', none: 'aus', error: 'Fehler' };
    const index = m.mappingIndex || [];
    this.midiInfo.replaceChildren(...m.inputs.map((inp) => {
      const c = ctrls.find((x) => x.input === inp.name) || {};
      const choice = m.mappingChoice ? m.mappingChoice(inp.name) : 'native';
      const sel = h('select', { class: 'map-sel', onchange: (e) => m.setMapping(inp.name, e.target.value) },
        /DDJ-?SX/i.test(inp.name) ? h('option', { value: 'native', selected: choice === 'native' }, 'Pulsar nativ (DDJ-SX, getestet)') : null,
        h('option', { value: 'none', selected: choice === 'none' }, 'Kein Mapping (nur MIDI-Learn)'),
        index.map((e) => h('option', { value: e.file, selected: choice === e.file }, e.name)));
      return h('div', { class: 'ctrl-row' },
        h('div', { class: 'ctrl-name' }, h('b', {}, inp.name), c.auto ? h('small', {}, ' automatisch erkannt') : null,
          c.output === null ? h('small', { class: 'warn' }, ' · kein MIDI-Ausgang, LEDs aus') : null),
        sel,
        h('span', { class: `ctrl-state s-${c.state || 'none'}`, title: c.lastError || '' }, states[c.state] || '–', c.errors ? ` · ${c.errors} Fehler` : ''));
    }), h('div', { class: 'hint' }, `${index.length} Controller-Mappings aus dem Mixxx-Projekt verfügbar. Für nicht gelistete Geräte gibt es MIDI-Learn.`));
  }

  // keyboard
  bindKeys() {
    const a = this.app;
    const held = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) {
        if (e.key === 'Escape') e.target.blur();
        if (e.target === this.searchInput && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
          e.preventDefault();
          if (e.key === 'Enter') this.list.focus();
          else this.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.searchInput.focus(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (held.has(e.code)) { if (/^Arrow(Up|Down)$/.test(e.key)) e.preventDefault(); else return; }
      held.add(e.code);
      const digit = /^Digit([1-8])$/.exec(e.code);
      if (digit) { a.act('hotcueDown', e.shiftKey ? 1 : 0, Number(digit[1]) - 1); return; }
      switch (k) {
        case 'q': a.act('play', 0); break;
        case 'p': a.act('play', 1); break;
        case 'w': a.act('cueDown', 0); break;
        case 'o': a.act('cueDown', 1); break;
        case 's': a.act('sync', 0); break;
        case 'l': a.act('sync', 1); break;
        case 'arrowleft': e.preventDefault(); a.act('load', 0); break;
        case 'arrowright': e.preventDefault(); a.act('load', 1); break;
        case 'arrowdown': e.preventDefault(); this.moveSelection(1); held.delete(e.code); break;
        case 'arrowup': e.preventDefault(); this.moveSelection(-1); held.delete(e.code); break;
        case 'escape': this.closeSettings(); break;
        case 'delete':
          if (this.libView.startsWith('pl:') && this.selected) a.library.removeFromPlaylist(this.libView.slice(3), [this.selected]);
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      held.delete(e.code);
      const digit = /^Digit([1-8])$/.exec(e.code);
      if (digit) { a.act('hotcueUp', 0, Number(digit[1]) - 1); a.act('hotcueUp', 1, Number(digit[1]) - 1); return; }
      const k = e.key.toLowerCase();
      if (k === 'w') a.act('cueUp', 0);
      if (k === 'o') a.act('cueUp', 1);
    });
  }

  // ======================= library =======================
  scrollTop() { this.list.scrollTop = 0; }

  computeRows() {
    const lib = this.app.library;
    let rows;
    const v = this.libView;
    if (v.startsWith('match')) {
      const d = this.app.decks[Number(v.slice(5))];
      rows = d.track ? lib.suggestions(d.track) : [];
    } else if (v === 'history') rows = lib.history.slice();
    else if (v === 'unanalyzed') rows = [...lib.tracks.values()].filter((t) => !t.analyzed && !t.transient);
    else if (v === 'downloaded') rows = [...lib.tracks.values()].filter((t) => !t.transient && lib.isDownloaded?.(t));
    else if (v.startsWith('pl:')) rows = lib.playlistTracks(v.slice(3));
    else if (v === 'online') rows = [];
    else if (v === 'foryou') {
      // the collection ranked by how well it fits the learned style, least played first
      const st = this.app.style;
      rows = [...lib.tracks.values()].filter((t) => !t.transient)
        .map((t) => [t, st.affinity(t) - Math.min(0.3, (t.plays || 0) * 0.05)])
        .sort((a, b) => b[1] - a[1]).map(([t]) => t);
    } else if (v.startsWith('fam:') || v.startsWith('gen:')) {
      const id = v.slice(4);
      rows = [...lib.tracks.values()].filter((t) => !t.transient && (v.startsWith('fam:') ? this.genreOf(t).family === id : this.genreOf(t).id === id));
    }
    else rows = [...lib.tracks.values()].filter((t) => !t.transient);
    const q = this.search.trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/);
      rows = rows.filter((t) => {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${this.genreOf(t).label} ${this.genreOf(t).familyLabel} ${t.camelot} ${t.keyName} ${Math.round(t.bpm)}`.toLowerCase();
        return terms.every((x) => hay.includes(x));
      });
    }
    if (!v.startsWith('match') && v !== 'history' && !v.startsWith('pl:') && v !== 'foryou') {
      const { key, dir } = this.sort;
      const val = (t) => {
        const x = t[key];
        if (key === 'camelot') { const m = /^(\d+)([AB])$/.exec(x || ''); return m ? Number(m[1]) * 2 + (m[2] === 'B' ? 1 : 0) : 99; }
        // genre: taxonomy order (family, then genre), then tempo inside the genre
        if (key === 'genre') return this.genreRank(t) * 1000 + (t.bpm || 0);
        return typeof x === 'string' ? x.toLowerCase() : x || 0;
      };
      rows.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : 0));
    }
    this.rows = rows;
    if (this.selected && !rows.includes(this.selected)) this.selected = null;
  }

  renderLibrary() {
    const lib = this.app.library;
    this.computeRows();
    const collection = [...lib.tracks.values()].filter((t) => !t.transient);
    const total = collection.length;
    const onlineView = this.libView === 'online';
    const showOnline = onlineView || this.online.active;
    this.emptyLib.classList.toggle('hidden', total > 0 || showOnline);
    this.list.classList.toggle('hidden', total === 0);
    this.thead.classList.toggle('hidden', total === 0);
    this.localEl.classList.toggle('hidden', onlineView);
    this.online.el.classList.toggle('hidden', !showOnline);
    this.online.el.classList.toggle('full', onlineView);
    if (onlineView) this.online.autoGenre();
    this.renderPlaylists();
    this.renderGenres(collection);
    setText(this.navItems.downloaded.querySelector('.dl-count'), String(collection.filter((t) => lib.isDownloaded?.(t)).length || ''));
    Object.entries(this.navItems).forEach(([id, el]) => el.classList.toggle('on', id === this.libView));
    setText(this.navItems.all.querySelector('.count'), String(total));
    for (let d = 0; d < 4; d++) {
      const item = this.navItems[`match${d}`];
      const t = this.app.decks[d].track;
      setText(item.querySelector('.sub'), t ? `${t.camelot || '?'} · ${t.bpm ? t.bpm.toFixed(1) : '?'}` : 'leer');
      item.classList.toggle('hidden', !this.app.settings.fourDecks && d > 1);
    }
    this.reconnectBtn.classList.toggle('hidden', !lib.needsPermission);
    this.rootsBox.replaceChildren(...lib.roots.map((r) => h('div', { class: 'root' }, '📁 ', r.name)));
    if (!lib.roots.length) this.rootsBox.append(h('div', { class: 'root muted' }, 'noch keiner'));
    const pending = [...lib.tracks.values()].filter((t) => !t.analyzed).length;
    if (lib.analyzing) {
      const done = lib.analysisTotal - lib.analysisQueue.length;
      setText(this.analyzeBtn, `Analysiere ${done}/${lib.analysisTotal} …`);
      this.analyzeBtn.disabled = true;
    } else {
      setText(this.analyzeBtn, pending ? `Alle analysieren (${pending})` : 'Alles analysiert ✓');
      this.analyzeBtn.disabled = !pending;
    }
    const pl = this.libView.startsWith('pl:') ? lib.playlists.find((p) => p.id === this.libView.slice(3)) : null;
    const gv = this.libView.startsWith('gen:') ? GENRES.get(this.libView.slice(4)) : null;
    const fv = this.libView.startsWith('fam:') ? TAXONOMY.find((f) => f.id === this.libView.slice(4)) : null;
    const viewName = gv ? `Genre ${gv.label} (${gv.bpm[0]}–${gv.bpm[1]} BPM typisch)` : fv ? `${fv.label} · sortiert nach Genre und Tempo`
      : this.libView === 'foryou' ? (this.app.style.empty ? 'Für dich: lernt aus dem, was du auflegst' : `Für dich: passt zu deinem Stil (${this.app.style.topGenres(3).map((g) => g.label).join(', ')})`)
      : this.libView.startsWith('match') ? `Passend zu Deck ${'ABCD'[Number(this.libView.slice(5))]} (Key + BPM)`
      : pl ? `Playlist „${pl.name}“ · Entf entfernt den markierten Track` : onlineView ? 'Freie Musik' : '';
    setText(this.libInfo, `${this.rows.length} Tracks${viewName ? ' · ' + viewName : ''}${lib.scanning ? ' · lese Ordner …' : ''}`);
    this.listInner.style.height = `${this.rows.length * ROW_H}px`;
    this.rowCache = new Map();
    this.renderRows(true);
  }

  renderRows(force) {
    const top = this.list.scrollTop, hgt = this.list.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 4);
    const last = Math.min(this.rows.length, Math.ceil((top + hgt) / ROW_H) + 4);
    if (!force && first === this.rFirst && last === this.rLast) return;
    this.rFirst = first; this.rLast = last;
    const ref = this.refTrack();
    const frag = [];
    for (let i = first; i < last; i++) frag.push(this.rowEl(this.rows[i], i, ref));
    this.listInner.replaceChildren(...frag);
  }

  refTrack() {
    const m = this.app.masterFor(null);
    return m?.track || this.app.decks.find((d) => d.track)?.track || null;
  }

  rowEl(t, i, ref) {
    const a = this.app;
    const onDeck = a.decks.findIndex((d) => d.track === t);
    const kd = ref && ref !== t ? camelotDistance(ref.camelot, t.camelot) : 50;
    const bd = ref && ref !== t ? bpmDistance(ref.bpm, t.bpm) : 1;
    const good = kd <= 1 && bd < 0.06;
    const el = h('div', {
      class: `lib-row${t === this.selected ? ' sel' : ''}${a.library.history.includes(t) ? ' played' : ''}${!a.library.available(t) ? ' missing' : ''}`,
      style: { top: `${i * ROW_H}px` },
      draggable: 'true',
      onclick: () => { this.selected = t; this.onlineFocus = false; this.renderRows(true); },
      ondblclick: () => {
        const target = a.decks.slice(0, a.settings.fourDecks ? 4 : 2).find((d) => !d.playing) || a.decks[0];
        a.loadTrack(target.index, t);
      },
      ondragstart: (e) => { e.dataTransfer.setData('text/pulsar-track', t.id); e.dataTransfer.effectAllowed = 'copy'; },
    },
    h('div', { class: 'c c-state' }, onDeck >= 0 ? h('span', { class: 'on-deck', style: { background: DECK_COLORS[onDeck] } }, 'ABCD'[onDeck]) : (t.analyzed ? '' : h('span', { class: 'na', title: 'noch nicht analysiert' }, '•'))),
    h('div', { class: 'c c-title' }, t.title, t.license ? licenseBadge(t.license) : null),
    h('div', { class: 'c c-artist' }, t.artist),
    h('div', { class: `c c-bpm${good ? ' good' : ''}` }, t.bpm ? t.bpm.toFixed(1) : ''),
    h('div', { class: 'c c-camelot' }, t.camelot ? h('span', { class: `key-badge${kd <= 1 ? ' match' : ''}`, style: { '--k': keyColor(t.camelot) } }, t.camelot) : (t.tagKey || '')),
    h('div', { class: 'c c-duration' }, fmtLen(t.duration)),
    (() => {
      const g = this.genreOf(t);
      return h('div', { class: `c c-genre${g.estimated ? ' est' : ''}`, title: g.estimated ? `geschätzt aus dem Tempo${t.genre ? ` (Tag: ${t.genre})` : ''}` : `${g.familyLabel}${t.genre && t.genre !== g.label ? ` · Tag: ${t.genre}` : ''}` },
        h('i', { class: 'gdot', style: { background: g.color } }), g.estimated && g.id !== 'unknown' ? `~${g.label}` : g.label);
    })(),
    h('div', { class: 'c c-plays' }, t.plays ? String(t.plays) : ''));
    return el;
  }

  // the collection list and the free-music list below it form one browse list
  moveSelection(delta) {
    const onlineView = this.libView === 'online';
    const showOnline = onlineView || this.online.active;
    let i = this.rows.indexOf(this.selected);
    if (showOnline && (onlineView || !this.rows.length || this.onlineFocus || (delta > 0 && i === this.rows.length - 1))) {
      if (this.online.moveSelection(delta)) { this.onlineFocus = true; return; }
      this.onlineFocus = false;
      if (onlineView || !this.rows.length) return;
      i = this.rows.length;   // moved up out of the free-music list: back to the last collection row
    }
    if (!this.rows.length) return;
    this.onlineFocus = false;
    i = Math.max(0, Math.min(this.rows.length - 1, (i < 0 ? -1 : i) + delta));
    this.selected = this.rows[i];
    const y = i * ROW_H;
    if (y < this.list.scrollTop) this.list.scrollTop = y;
    else if (y + ROW_H > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = y + ROW_H - this.list.clientHeight;
    this.renderRows(true);
  }

  // LOAD on a selected free-music result; false when the collection selection applies
  loadSelectedOpen(deck) {
    const onlineView = this.libView === 'online';
    if (!(onlineView || (this.online.active && this.onlineFocus))) return false;
    return this.online.loadSelected(deck);
  }

  toggleBrowseFocus() {
    const views = ['all', 'match0', 'match1', 'history'];
    this.libView = views[(views.indexOf(this.libView) + 1) % views.length];
    this.libDirty = true;
  }

  showSuggestions() {
    const m = this.app.masterFor(null) || this.app.decks.find((d) => d.track);
    if (!m) return;
    this.libView = `match${m.index}`;
    this.libDirty = true;
  }

  // ======================= per-frame =======================
  frame(t) {
    const a = this.app;
    if (this.libDirty && (!this.lastLib || t - this.lastLib > 150)) {
      this.libDirty = false;
      this.lastLib = t;
      this.renderLibrary();
    }
    const four = a.settings.fourDecks;
    const master = a.masterFor(null);
    a.decks.forEach((d, i) => {
      if (!four && i > 1) return;
      const w = this.waves[i];
      w.wave.draw();
      drawPhase(w.phase, d, a.masterFor(d));
      if (a.focus.includes(i)) this.renderDeck(i, master);
      this.renderStrip(i);
    });
    const clk = a.clockBpm;
    setText(this.clockBpm, clk ? clk.toFixed(1) : '—');
    if (a.engine.ctx) {
      const [l, r] = a.engine.masterLevels();
      const pct = (v) => `${Math.max(0, Math.min(100, ((20 * Math.log10(v + 1e-6) + 40) / 40) * 100))}%`;
      setStyle(this.masterMeter.children[0], '--v', pct(l));
      setStyle(this.masterMeter.children[1], '--v', pct(r));
      setClass(this.masterMeter, 'clip', Math.max(l, r) > 0.97);
    }
    const rec = a.engine.recorder;
    setClass(this.recBtn, 'on', !!rec);
    setText(this.recBtn.lastChild, rec ? fmtLen((performance.now() - a.engine.recStart) / 1000) || '0:00' : 'REC');
    a.engine.fxUnits.forEach((u, ui) => {
      const f = this.fx[ui];
      setText(f.beats, fmtBeats(u.beats));
      u.slots.forEach((s, si) => {
        setClass(f.slots[si].on, 'on', s.on);
        f.slots[si].knob.set(s.level);
        if (f.slots[si].sel.value !== s.type) f.slots[si].sel.value = s.type;
      });
      f.assign.forEach((b, d) => setClass(b, 'on', u.assigned[d]));
    });
    this.xfader.set(a.engine.xfader);
    this.xfCurveKnob.set(a.engine.xfCurve);
  }

  renderDeck(i, master) {
    const a = this.app, d = a.decks[i], { r } = this.decks[i];
    const t = d.track;
    setText(r.title, t ? t.title : 'Kein Track geladen');
    setText(r.artist, t ? (t.artist || '—') : 'Track hierher ziehen oder in der Bibliothek doppelklicken');
    if (r.licFor !== t) {
      r.licFor = t;
      r.lic.replaceChildren(...(t?.license ? [licenseBadge(t.license), t.pageUrl ? h('a', { class: 'src', href: t.pageUrl, target: '_blank', rel: 'noopener' }, t.source || 'Quelle') : ''] : []));
    }
    const cam = d.info?.key?.camelot || '';
    setText(r.key, cam || '–');
    setStyle(r.key, '--k', keyColor(cam));
    setClass(r.key, 'match', !!(master && master !== d && master.info?.key && camelotDistance(master.info.key.camelot, cam) <= 1));
    setText(r.bpm, d.bpm ? d.liveBpm.toFixed(2) : '—');
    setText(r.bpmBase, d.bpm ? `${d.bpm.toFixed(1)} orig` : '');
    const p = d.pitch * 100;
    setText(r.pitch, `${p >= 0 ? '+' : ''}${p.toFixed(2)} %  ·  ±${Math.round(d.range * 100)}`);
    setText(r.range, `±${Math.round(d.range * 100)}`);
    const pos = d.position;
    setText(r.time, fmtTime(pos));
    const left = d.duration - pos;
    setText(r.remain, `-${fmtTime(left)}`);
    setClass(r.remain, 'warn', d.loaded && left < 30);
    setStyle(r.loading, 'width', `${(d.loading || 0) * 100}%`);
    setClass(r.loading, 'on', !!d.loading);
    setClass(r.play, 'on', d.playing);
    setClass(r.cue, 'on', d.loaded && !d.playing);
    setClass(r.sync, 'on', d.sync);
    setClass(r.master, 'on', a.masterIndex === i || (a.masterIndex == null && master === d));
    setClass(r.keylock, 'on', d.keylock);
    setClass(r.slip, 'on', d.slip);
    setClass(r.vinyl, 'on', d.vinyl);
    setClass(r.quant, 'on', d.quantize);
    setClass(r.rev, 'on', d.reverse);
    setClass(r.loopAuto, 'on', d.loop.on);
    setText(r.loopLen, fmtBeats(d.loop.beats));
    // pitch fader shows the physical/virtual fader; when synced show the effective pitch
    const fv = d.sync || d.pickup ? d.pitch / d.range : d.pitchFader;
    r.pitchFader.set(Math.max(0, Math.min(1, (1 - fv) / 2)));
    setClass(r.pitchFader.el, 'synced', d.sync);
    // pads
    const mode = a.padMode[i];
    r.modeBtns.forEach((b, k) => setClass(b, 'on', PAD_MODES[k][0] === mode));
    r.pads.forEach((pad, k) => {
      setText(pad.firstChild, PAD_LABELS[mode](k));
      let col = '', lit = false;
      if (mode === 'hotcue') { lit = d.hotcues[k] != null; col = HOTCUE_COLORS[k]; }
      else if (mode === 'roll') { lit = d.loop.on && d.loop.roll && Math.abs(d.loop.beats - ROLL_BEATS[k]) < 1e-6; col = '#3ddc84'; }
      else if (mode === 'loop') { lit = d.loop.on && !d.loop.roll && Math.abs(d.loop.beats - LOOP_BEATS[k]) < 1e-6; col = '#3ddc84'; }
      else { col = '#4f7cff'; }
      setClass(pad, 'lit', lit);
      setStyle(pad, '--pad', col || '#4f7cff');
      setClass(pad, `mode-${mode}`, true);
      ['hotcue', 'roll', 'loop', 'jump'].forEach((m) => m !== mode && setClass(pad, `mode-${m}`, false));
    });
    r.ov.draw();
    this.drawPlatter(r.platter, d);
  }

  drawPlatter(canvas, d) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.round(canvas.clientWidth * dpr);
    if (!s) return;
    if (canvas.width !== s) { canvas.width = s; canvas.height = s; }
    const g = canvas.getContext('2d');
    const c = s / 2, R = c - 2 * dpr;
    g.clearRect(0, 0, s, s);
    // outer ring with progress
    g.lineWidth = 4 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.beginPath(); g.arc(c, c, R - 2 * dpr, 0, Math.PI * 2); g.stroke();
    if (d.loaded) {
      const prog = d.position / d.duration;
      const left = d.duration - d.position;
      g.strokeStyle = left < 30 && Math.floor(performance.now() / 400) % 2 ? '#ff3b5c' : DECK_COLORS[d.index];
      g.beginPath(); g.arc(c, c, R - 2 * dpr, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); g.stroke();
    }
    // disc
    const grad = g.createRadialGradient(c, c, R * 0.1, c, c, R * 0.9);
    grad.addColorStop(0, '#1d212b');
    grad.addColorStop(1, '#0d0f14');
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, R * 0.86, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.lineWidth = dpr;
    for (let k = 0.35; k < 0.86; k += 0.07) { g.beginPath(); g.arc(c, c, R * k, 0, Math.PI * 2); g.stroke(); }
    // rotating marker: 33 1/3 rpm
    const ang = (d.position / 1.8) * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = d.jogTouched ? '#fff' : DECK_COLORS[d.index];
    g.lineWidth = 3 * dpr;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(c + Math.cos(ang) * R * 0.3, c + Math.sin(ang) * R * 0.3);
    g.lineTo(c + Math.cos(ang) * R * 0.8, c + Math.sin(ang) * R * 0.8);
    g.stroke();
    // centre label
    g.fillStyle = d.jogTouched ? '#fff' : DECK_COLORS[d.index];
    g.beginPath(); g.arc(c, c, R * 0.16, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0b0d12';
    g.font = `800 ${R * 0.16}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(d.name, c, c + 1);
  }

  renderStrip(i) {
    const a = this.app, d = a.decks[i], s = this.strips[i];
    s.trim.set(d.mix.trim);
    s.high.set(d.mix.high);
    s.mid.set(d.mix.mid);
    s.low.set(d.mix.low);
    s.filter.set(d.mix.filter);
    s.fader.set(d.mix.volume);
    setClass(s.cue, 'on', d.mix.cue);
    s.xf.querySelectorAll('.xa').forEach((b) => setClass(b, 'on', b.dataset.x === d.mix.xfAssign));
    const lvl = d.strip ? d.strip.level() : 0;
    const pct = Math.max(0, Math.min(100, ((20 * Math.log10(lvl + 1e-6) + 40) / 40) * 100));
    setStyle(s.meter, '--v', `${pct.toFixed(0)}%`);
    setClass(s.meter, 'clip', lvl > 0.97);
  }
}
