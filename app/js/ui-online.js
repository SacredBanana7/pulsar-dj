// Online part of the library: one search over legally free music sources
// (Openverse/Jamendo, Internet Archive, ccMixter, optional Jamendo API),
// grouped by source, with licence badges, preview, load-to-deck and offline save.

import { h, setText, setClass } from './controls.js';
import OpenMusic, { proxied, openTrackId } from './openmusic.js';
import { keyColor, camelotDistance, bpmDistance } from './library.js';
import { DECK_COLORS } from './waveform.js';

const fmtLen = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

function licenseBadge(lic) {
  if (!lic) return null;
  const warn = lic.nc || lic.nd;
  const cls = lic.publicDomain ? 'pd' : warn ? 'warn' : 'ok';
  const title = [
    lic.label,
    lic.by ? 'Namensnennung erforderlich' : '',
    lic.sa ? 'Bearbeitungen unter gleicher Lizenz' : '',
    lic.nc ? 'NICHT für kommerzielle Auftritte' : '',
    lic.nd ? 'keine Bearbeitungen (Remix/Edit)' : '',
  ].filter(Boolean).join(' · ');
  return h('a', { class: `lic ${cls}`, href: lic.url || '#', target: '_blank', rel: 'noopener', title, onclick: (e) => e.stopPropagation() },
    (lic.label || '').replace(/^Creative Commons /, '').replace(/ \d\.\d.*$/, ''), warn ? ' ⚠' : '');
}

export { licenseBadge };

// Headphone preview: through the cue bus when headphones have their own output, else straight out.
class Preview {
  constructor(app) {
    this.app = app;
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'none';
    this.node = null;
    this.current = null;
    this.audio.addEventListener('ended', () => this.stop());
    this.audio.addEventListener('error', () => {
      if (this.current && !this.triedProxy) {
        this.triedProxy = true;
        this.audio.src = proxied(this.current.streamUrl);
        this.audio.play().catch(() => {});
      } else this.stop();
    });
  }

  route() {
    const e = this.app.engine;
    if (!e.ctx) return;
    const toCue = e.outChannels === 4 || e.routing === 'split';
    if (!this.node) {
      this.node = e.ctx.createMediaElementSource(this.audio);
      this.gain = e.ctx.createGain();
      this.node.connect(this.gain);
    }
    // once captured by Web Audio the element only plays through the graph:
    // headphones (cue bus) if they have their own output, otherwise the main output
    this.gain.disconnect();
    this.gain.connect(toCue ? e.cueBus : e.ctx.destination);
    e.previewing = toCue;
    e.applyMix(this.app.decks);
  }

  play(r) {
    if (this.current === r) return this.stop();
    this.current = r;
    this.triedProxy = !!r.proxy;
    this.route();
    this.audio.src = r.proxy ? proxied(r.streamUrl) : r.streamUrl;
    this.audio.play().catch(() => {});
    this.onChange?.();
  }

  stop() {
    this.audio.pause();
    this.current = null;
    if (this.app.engine.previewing) {
      this.app.engine.previewing = false;
      this.app.engine.applyMix(this.app.decks);
    }
    this.onChange?.();
  }
}

export class OnlinePanel {
  constructor(ui) {
    this.ui = ui;
    this.app = ui.app;
    this.query = '';
    this.genre = '';
    this.license = localStorage.getItem('pulsar.onlineLicense') || 'any';
    this.onlyMatching = false;
    this.groups = [];
    this.loading = false;
    this.page = 1;
    this.expanded = new Map();   // archive album id -> tracks[] | 'loading'
    this.results = new Map();    // key -> result (for drag & drop)
    this.busy = new Map();       // result key -> progress
    this.preview = new Preview(this.app);
    this.preview.onChange = () => this.render();
    this.timer = 0;
    this.build();
  }

  build() {
    const lic = h('select', { class: 'mini', title: 'Lizenzfilter', onchange: (e) => { this.license = e.target.value; localStorage.setItem('pulsar.onlineLicense', this.license); this.run(); } },
      h('option', { value: 'any', selected: this.license === 'any' }, 'Alle freien Lizenzen'),
      h('option', { value: 'commercial', selected: this.license === 'commercial' }, 'Kommerziell auflegbar (ohne NC/ND)'),
      h('option', { value: 'cc0', selected: this.license === 'cc0' }, 'Nur gemeinfrei (CC0/PD)'));
    const match = h('label', { class: 'mini-check', title: 'Nur Treffer, deren BPM/Tonart zum Master-Deck passen (sobald bekannt)' },
      h('input', { type: 'checkbox', onchange: (e) => { this.onlyMatching = e.target.checked; this.render(); } }), 'passend zum Master');
    this.genreBar = h('div', { class: 'genres' }, Object.entries(OpenMusic.GENRES).map(([k, g]) =>
      h('button', { class: 'chip', 'data-g': k, onclick: () => { this.genre = this.genre === k ? '' : k; this.run(); } }, g.label || k)));
    this.status = h('div', { class: 'online-status' });
    this.body = h('div', { class: 'online-body' });
    this.more = h('button', { class: 'btn ghost tiny', onclick: () => { this.page++; this.run(true); } }, 'Mehr laden');
    this.el = h('section', { class: 'online' },
      h('div', { class: 'online-head' },
        h('b', {}, 'Freie Musik online'),
        h('span', { class: 'online-sub' }, 'nur Creative Commons und gemeinfrei · Openverse/Jamendo · Internet Archive · ccMixter'),
        h('div', { class: 'spacer' }), lic, match),
      this.genreBar, this.status, this.body);
  }

  setQuery(q) {
    clearTimeout(this.timer);
    this.query = q.trim();
    this.timer = setTimeout(() => this.run(), 650);
  }

  get active() { return this.query.length >= 3 || !!this.genre; }

  async run(append = false) {
    if (!append) this.page = 1;
    if (!this.active) {
      this.groups = [];
      this.render();
      return;
    }
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    this.loading = true;
    this.render();
    try {
      const res = await OpenMusic.searchAll({
        query: this.query, genre: this.genre, license: this.license, page: this.page,
        jamendoClientId: this.app.settings.jamendoClientId || '', signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      if (append) {
        for (const g of res) {
          const old = this.groups.find((x) => x.source === g.source);
          if (old && g.ok) old.results.push(...g.results);
          else if (!old) this.groups.push(g);
        }
      } else this.groups = res;
      // Openverse often needs a second request for uncached queries: retry it alone once
      const ov = this.groups.find((g) => g.source === 'openverse');
      if (ov && !ov.ok && !append) {
        ov.error = 'antwortet langsam, neuer Versuch läuft …';
        this.render();
        OpenMusic.searchAll({
          query: this.query, genre: this.genre, license: this.license, page: this.page, sources: ['openverse'], signal: ctl.signal,
        }).then(([g]) => {
          if (ctl.signal.aborted || !g) return;
          const i = this.groups.findIndex((x) => x.source === 'openverse');
          if (i >= 0) this.groups[i] = g.ok ? g : { ...g, error: 'gerade nicht erreichbar' };
          this.render();
        }).catch(() => {});
      }
    } catch (e) {
      if (e.name !== 'AbortError') this.ui.toast('Online-Suche fehlgeschlagen: ' + (e.message || e), 'error');
    } finally {
      if (this.abort === ctl) this.loading = false;
      this.render();
    }
  }

  key(r) { return `${r.source}:${r.id}`; }

  known(r) {
    const t = this.app.library.tracks.get(openTrackId(r));
    return { bpm: t?.bpm || r.bpm || 0, camelot: t?.camelot || '', track: t };
  }

  matches(r) {
    if (!this.onlyMatching) return true;
    const m = this.app.masterFor(null);
    if (!m?.track) return true;
    const k = this.known(r);
    if (k.bpm && bpmDistance(m.bpm, k.bpm) > 0.06) return false;
    if (k.camelot && camelotDistance(m.track.camelot, k.camelot) > 1) return false;
    return true;
  }

  async load(deck, r) {
    const a = this.app, d = a.decks[deck];
    // hour-long mixes/podcasts don't fit into memory as decoded audio
    if ((r.durationSec && r.durationSec > 40 * 60) || (r.size && r.size > 120e6)) {
      a.toast(`„${r.title}“ ist zu lang für ein Deck (Mix/Podcast über 40 Minuten).`, 'warn');
      return;
    }
    if (a.settings.loadLock && d.playing && d.mix.volume > 0.05) {
      a.toast(`Deck ${d.name} läuft gerade. Erst stoppen oder den Fader runterziehen.`, 'warn');
      return;
    }
    if (!a.started) await a.start();
    this.ui.overlay?.remove();
    d.loading = 0.02;
    try {
      const t = await a.library.openTrackFile(r, (p) => (d.loading = 0.02 + p * 0.25));
      await a.loadTrack(deck, t);
    } catch (e) {
      d.loading = 0;
      a.toast(`Konnte "${r.title}" nicht laden: ${e.message || e}`, 'error');
    }
  }

  async save(r) {
    const k = this.key(r);
    if (this.busy.has(k)) return;
    this.busy.set(k, 0);
    this.render();
    try {
      await this.app.library.downloadOpenTrack(r, (p) => { this.busy.set(k, p); this.renderProgress(k); });
      this.ui.toast(`Offline gespeichert: ${r.title}`);
    } catch (e) {
      this.ui.toast(`Speichern fehlgeschlagen: ${e.message || e}`, 'error');
    } finally {
      this.busy.delete(k);
      this.render();
    }
  }

  freeDeck() {
    const a = this.app;
    return (a.decks.slice(0, a.settings.fourDecks ? 4 : 2).find((d) => !d.playing) || a.decks[0]).index;
  }

  async toggleAlbum(r) {
    if (this.expanded.has(r.id)) { this.expanded.delete(r.id); return this.render(); }
    this.expanded.set(r.id, 'loading');
    this.render();
    try {
      const tracks = await r.tracks();
      this.expanded.set(r.id, tracks);
    } catch (e) {
      this.expanded.delete(r.id);
      this.ui.toast('Album konnte nicht geladen werden: ' + (e.message || e), 'error');
    }
    this.render();
  }

  row(r, nested = false) {
    const k = this.key(r);
    this.results.set(k, r);
    if (r.kind === 'album') {
      const open = this.expanded.get(r.id);
      return h('div', { class: 'orow album', onclick: () => this.toggleAlbum(r) },
        h('span', { class: 'ocaret' }, open ? '▾' : '▸'),
        h('div', { class: 'otitle' }, h('b', {}, r.title), h('span', { class: 'oartist' }, r.artist || '')),
        licenseBadge(r.license),
        h('span', { class: 'odur' }, open === 'loading' ? 'lädt …' : 'Album'),
        h('a', { class: 'olink', href: r.pageUrl, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), title: 'Quelle öffnen' }, '↗'));
    }
    const kn = this.known(r);
    const saved = kn.track && !kn.track.transient && this.app.library.isDownloaded?.(kn.track);
    const prog = this.busy.get(k);
    const playing = this.preview.current === r;
    const onDeck = this.app.decks.findIndex((d) => d.track && d.track.id === openTrackId(r));
    const el = h('div', {
      class: `orow${nested ? ' nested' : ''}${playing ? ' playing' : ''}`,
      draggable: 'true',
      ondragstart: (e) => { e.dataTransfer.setData('text/pulsar-open', k); e.dataTransfer.effectAllowed = 'copy'; },
      ondblclick: () => this.load(this.freeDeck(), r),
    },
    h('button', { class: `obtn play${playing ? ' on' : ''}`, title: 'Vorhören', onclick: () => this.preview.play(r) }, playing ? '■' : '▶'),
    h('div', { class: 'otitle' },
      onDeck >= 0 ? h('span', { class: 'on-deck', style: { background: DECK_COLORS[onDeck] } }, 'ABCD'[onDeck]) : null,
      h('b', {}, r.title || '–'),
      r.artistUrl ? h('a', { class: 'oartist', href: r.artistUrl, target: '_blank', rel: 'noopener' }, r.artist || '') : h('span', { class: 'oartist' }, r.artist || '')),
    licenseBadge(r.license),
    h('span', { class: 'obpm' }, kn.bpm ? kn.bpm.toFixed(0) : ''),
    kn.camelot ? h('span', { class: 'key-badge', style: { '--k': keyColor(kn.camelot) } }, kn.camelot) : h('span', { class: 'okey' }),
    h('span', { class: 'odur' }, fmtLen(r.durationSec)),
    ...[0, 1].map((d) => h('button', { class: 'obtn deck', style: { '--deck': DECK_COLORS[d] }, title: `Auf Deck ${'AB'[d]} laden`, onclick: () => this.load(d, r) }, 'AB'[d])),
    saved ? h('span', { class: 'obtn saved', title: 'Offline in der Sammlung' }, '✓')
      : h('button', { class: 'obtn save', title: 'Offline speichern (mit Lizenz und Urheber)', onclick: () => this.save(r), 'data-k': k },
        prog != null ? `${Math.round(prog * 100)}%` : '⬇'),
    h('a', { class: 'olink', href: r.pageUrl, target: '_blank', rel: 'noopener', title: 'Quelle öffnen' }, '↗'));
    return el;
  }

  renderProgress(k) {
    const b = this.body.querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (b) b.textContent = `${Math.round((this.busy.get(k) || 0) * 100)}%`;
  }

  render() {
    this.genreBar.querySelectorAll('.chip').forEach((c) => setClass(c, 'on', c.dataset.g === this.genre));
    if (!this.active) {
      setText(this.status, 'Suchbegriff eingeben (mind. 3 Zeichen) oder ein Genre wählen.');
      this.body.replaceChildren();
      return;
    }
    const total = this.groups.reduce((n, g) => n + (g.results?.length || 0), 0);
    setText(this.status, this.loading ? 'Suche läuft …' : `${total} freie Treffer`);
    this.results.clear();
    const parts = [];
    for (const g of this.groups) {
      const rows = (g.results || []).filter((r) => r.kind === 'album' || this.matches(r));
      parts.push(h('div', { class: 'ogroup' },
        h('span', {}, g.label || g.source),
        g.ok ? h('small', {}, `${rows.length}${g.total > rows.length ? ` von ${g.total}` : ''}`) : h('small', { class: 'err' }, g.error || 'nicht erreichbar')));
      for (const r of rows) {
        parts.push(this.row(r));
        const tracks = r.kind === 'album' ? this.expanded.get(r.id) : null;
        if (Array.isArray(tracks)) for (const t of tracks) parts.push(this.row(t, true));
      }
    }
    if (total && !this.loading) parts.push(h('div', { class: 'omore' }, this.more));
    this.body.replaceChildren(...parts);
  }
}
