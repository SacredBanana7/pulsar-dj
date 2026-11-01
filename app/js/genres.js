// Genre taxonomy, track classification and the adaptive style profile.
//
// Every track gets a genre from its tags/genre text (aliases below). If the tags
// say nothing, a cautious guess from BPM and analysis is used and marked as
// estimated. The style profile learns from what is played and how long, so the
// library and the online suggestions follow the DJ's own style over time.

import { db } from './db.js';

// family -> genres; bpm = typical range; aliases = lowercase substrings of tags
export const TAXONOMY = [
  { id: 'house', label: 'House', color: '#ff9f1c', genres: [
    { id: 'deep-house', label: 'Deep House', bpm: [115, 124], aliases: ['deep house', 'deephouse'] },
    { id: 'tech-house', label: 'Tech House', bpm: [122, 128], aliases: ['tech house', 'tech-house', 'techhouse'] },
    { id: 'progressive-house', label: 'Progressive House', bpm: [122, 130], aliases: ['progressive house', 'prog house'] },
    { id: 'afro-house', label: 'Afro House', bpm: [118, 124], aliases: ['afro house', 'afrohouse', 'amapiano'] },
    { id: 'disco-house', label: 'Disco / Nu-Disco', bpm: [110, 126], aliases: ['nu disco', 'nu-disco', 'disco', 'funk', 'boogie'] },
    { id: 'house', label: 'House', bpm: [118, 128], aliases: ['house', 'garage', 'chicago'] },
  ] },
  { id: 'techno', label: 'Techno', color: '#22d3ee', genres: [
    { id: 'minimal', label: 'Minimal / Microhouse', bpm: [120, 128], aliases: ['minimal', 'microhouse', 'micro house', 'clicks'] },
    { id: 'melodic-techno', label: 'Melodic Techno', bpm: [120, 128], aliases: ['melodic techno'] },
    { id: 'hard-techno', label: 'Hard / Industrial Techno', bpm: [135, 155], aliases: ['hard techno', 'industrial', 'schranz', 'hardtechno'] },
    { id: 'dub-techno', label: 'Dub Techno', bpm: [115, 125], aliases: ['dub techno', 'dubtechno'] },
    { id: 'acid', label: 'Acid', bpm: [125, 140], aliases: ['acid', 'tb303', 'tb-303', '303'] },
    { id: 'techno', label: 'Techno', bpm: [125, 140], aliases: ['techno', 'detroit'] },
  ] },
  { id: 'trance', label: 'Trance', color: '#a855f7', genres: [
    { id: 'psytrance', label: 'Psytrance / Goa', bpm: [138, 150], aliases: ['psytrance', 'psy trance', 'psychedelic trance', 'goa', 'psy'] },
    { id: 'progressive-trance', label: 'Progressive Trance', bpm: [128, 136], aliases: ['progressive trance'] },
    { id: 'trance', label: 'Trance', bpm: [130, 142], aliases: ['trance', 'uplifting'] },
  ] },
  { id: 'bass', label: 'Drum & Bass / Bass', color: '#3ddc84', genres: [
    { id: 'liquid-dnb', label: 'Liquid DnB', bpm: [168, 176], aliases: ['liquid'] },
    { id: 'neurofunk', label: 'Neurofunk', bpm: [170, 176], aliases: ['neurofunk', 'neuro'] },
    { id: 'jungle', label: 'Jungle', bpm: [160, 175], aliases: ['jungle', 'ragga'] },
    { id: 'dnb', label: 'Drum & Bass', bpm: [165, 178], aliases: ['drum and bass', 'drum & bass', 'drum n bass', 'drumnbass', 'dnb', 'd&b'] },
    { id: 'dubstep', label: 'Dubstep', bpm: [138, 142], aliases: ['dubstep', 'brostep', 'riddim'] },
    { id: 'uk-garage', label: 'UK Garage / 2-Step', bpm: [130, 138], aliases: ['uk garage', '2-step', '2step', 'ukg', 'speed garage'] },
    { id: 'bass-music', label: 'Bass Music', bpm: [125, 150], aliases: ['bass music', 'future bass', 'wonky'] },
  ] },
  { id: 'breaks', label: 'Breaks & Electro', color: '#f472b6', genres: [
    { id: 'electro', label: 'Electro', bpm: [120, 135], aliases: ['electro', 'electroclash', 'miami bass'] },
    { id: 'breakbeat', label: 'Breakbeat', bpm: [125, 140], aliases: ['breakbeat', 'breaks', 'big beat', 'nu skool'] },
    { id: 'idm', label: 'IDM / Electronica', bpm: [90, 160], aliases: ['idm', 'electronica', 'glitch', 'experimental electronic'] },
  ] },
  { id: 'urban', label: 'Hip-Hop & Beats', color: '#ffe14d', genres: [
    { id: 'trap', label: 'Trap', bpm: [130, 150], aliases: ['trap'] },
    { id: 'lofi', label: 'Lo-Fi / Chillhop', bpm: [70, 95], aliases: ['lofi', 'lo-fi', 'chillhop', 'lo fi'] },
    { id: 'boom-bap', label: 'Boom Bap', bpm: [85, 98], aliases: ['boom bap', 'boombap'] },
    { id: 'hiphop', label: 'Hip-Hop', bpm: [80, 105], aliases: ['hip hop', 'hip-hop', 'hiphop', 'rap', 'beats', 'instrumental hip'] },
    { id: 'rnb', label: 'R&B / Soul', bpm: [60, 110], aliases: ['r&b', 'rnb', 'soul', 'neo soul'] },
  ] },
  { id: 'downtempo', label: 'Downtempo & Ambient', color: '#94a3b8', genres: [
    { id: 'ambient', label: 'Ambient', bpm: [0, 100], aliases: ['ambient', 'drone', 'soundscape'] },
    { id: 'chillout', label: 'Chillout / Downtempo', bpm: [80, 115], aliases: ['chillout', 'chill out', 'downtempo', 'lounge', 'trip hop', 'trip-hop', 'chill'] },
    { id: 'dub', label: 'Dub / Reggae', bpm: [60, 90], aliases: ['dub', 'reggae', 'dancehall'] },
  ] },
  { id: 'world', label: 'World, Latin & Pop', color: '#fb7185', genres: [
    { id: 'latin', label: 'Latin / Reggaeton', bpm: [88, 105], aliases: ['latin', 'reggaeton', 'cumbia', 'salsa', 'baile', 'moombahton'] },
    { id: 'afrobeats', label: 'Afrobeats', bpm: [95, 115], aliases: ['afrobeat', 'afro beat', 'afro'] },
    { id: 'pop', label: 'Pop / Dance-Pop', bpm: [95, 130], aliases: ['pop', 'dance pop', 'synthpop', 'synth-pop', 'eurodance'] },
    { id: 'rock', label: 'Rock / Indie', bpm: [90, 160], aliases: ['rock', 'indie', 'punk', 'metal', 'alternative'] },
    { id: 'jazz', label: 'Jazz / Funk', bpm: [70, 140], aliases: ['jazz', 'swing', 'bossa'] },
  ] },
];

export const GENRES = new Map();
for (const fam of TAXONOMY) for (const g of fam.genres) GENRES.set(g.id, { ...g, family: fam.id, familyLabel: fam.label, color: fam.color });
export const FAMILIES = new Map(TAXONOMY.map((f) => [f.id, f]));

// longest alias first so "deep house" wins over "house", "drum and bass" over "bass"
const ALIASES = [...GENRES.values()].flatMap((g) => g.aliases.map((a) => [a, g.id])).sort((a, b) => b[0].length - a[0].length);

function textMatch(text) {
  const t = ` ${text.toLowerCase().replace(/[_/|,;]+/g, ' ')} `;
  for (const [alias, id] of ALIASES) {
    // whole-word-ish match; avoids "psy" in "psychedelic rock" only via longer aliases first
    const re = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(t)) return id;
  }
  return null;
}

// -> { id, label, family, familyLabel, color, estimated }
export function classify(t) {
  // the explicit genre field wins over loose tags
  const tags = [...(t.tags || []), t.album].filter(Boolean).join(' | ');
  let id = (t.genre && textMatch(t.genre)) || (tags ? textMatch(tags) : null);
  let estimated = false;
  if (id) {
    // the tag says "house" but the tempo is clearly DnB etc.: trust the tempo for the family
    const g = GENRES.get(id);
    if (t.bpm && g.bpm[1] && (t.bpm > g.bpm[1] * 1.25 || t.bpm < g.bpm[0] * 0.75) && !(t.bpm * 2 >= g.bpm[0] && t.bpm * 2 <= g.bpm[1]) && !(t.bpm / 2 >= g.bpm[0] && t.bpm / 2 <= g.bpm[1])) {
      const byBpm = guessByBpm(t.bpm);
      if (byBpm) { id = byBpm; estimated = true; }
    }
  } else if (t.bpm) {
    id = guessByBpm(t.bpm);
    estimated = true;
  }
  if (!id) return { id: 'unknown', label: 'Unbekannt', family: 'unknown', familyLabel: 'Unsortiert', color: '#555b66', estimated: true };
  const g = GENRES.get(id);
  return { id, label: g.label, family: g.family, familyLabel: g.familyLabel, color: g.color, estimated };
}

// cautious tempo-only guess (only the main genre of each family)
function guessByBpm(bpm) {
  if (bpm >= 160) return 'dnb';
  if (bpm >= 145) return 'hard-techno';
  if (bpm >= 136) return 'trance';
  if (bpm >= 128) return 'techno';
  if (bpm >= 115) return 'house';
  if (bpm >= 100) return 'pop';
  if (bpm >= 80) return 'hiphop';
  if (bpm > 0) return 'chillout';
  return null;
}

// ---------- adaptive style profile ----------
// weights per genre/family decay slowly, so the profile follows a changing style
const HALF_LIFE_DAYS = 45;

export class StyleProfile {
  constructor() {
    this.genres = {};      // id -> weight
    this.families = {};
    this.bpm = {};         // 5-BPM bucket -> weight
    this.keys = {};        // camelot -> weight
    this.updated = Date.now();
  }

  async load() {
    const p = await db.get('kv', 'style-profile').catch(() => null);
    if (p) Object.assign(this, p);
    return this;
  }

  save() { db.put('kv', 'style-profile', { genres: this.genres, families: this.families, bpm: this.bpm, keys: this.keys, updated: this.updated }).catch(() => {}); }

  decay() {
    const days = (Date.now() - this.updated) / 86400000;
    if (days < 0.5) return;
    const f = Math.pow(0.5, days / HALF_LIFE_DAYS);
    for (const m of [this.genres, this.families, this.bpm, this.keys]) for (const k in m) m[k] *= f;
    this.updated = Date.now();
  }

  // weight: 1 for a play, more for long plays, a bit for saving/loading
  learn(track, weight = 1) {
    if (!track) return;
    this.decay();
    const g = classify(track);
    const w = g.estimated ? weight * 0.5 : weight;
    if (g.id !== 'unknown') {
      this.genres[g.id] = (this.genres[g.id] || 0) + w;
      this.families[g.family] = (this.families[g.family] || 0) + w;
    }
    if (track.bpm) {
      const b = String(Math.round(track.bpm / 5) * 5);
      this.bpm[b] = (this.bpm[b] || 0) + weight;
    }
    if (track.camelot) this.keys[track.camelot] = (this.keys[track.camelot] || 0) + weight;
    this.save();
  }

  get empty() { return !Object.keys(this.genres).length; }

  topGenres(n = 5) {
    return Object.entries(this.genres).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, w]) => ({ ...GENRES.get(id), id, weight: w }));
  }

  familyOrder() {
    return [...TAXONOMY].sort((a, b) => (this.families[b.id] || 0) - (this.families[a.id] || 0));
  }

  bpmRange() {
    const e = Object.entries(this.bpm).filter(([, w]) => w > 0);
    if (!e.length) return null;
    const total = e.reduce((s, [, w]) => s + w, 0);
    const mean = e.reduce((s, [b, w]) => s + Number(b) * w, 0) / total;
    return [Math.round(mean - 8), Math.round(mean + 8)];
  }

  // 0..1 how well a track fits the learned style
  affinity(track) {
    if (this.empty) return 0;
    const g = classify(track);
    const maxG = Math.max(...Object.values(this.genres), 1e-9);
    const maxF = Math.max(...Object.values(this.families), 1e-9);
    const gs = (this.genres[g.id] || 0) / maxG;
    const fs = (this.families[g.family] || 0) / maxF;
    let bs = 0;
    if (track.bpm) {
      const maxB = Math.max(...Object.values(this.bpm), 1e-9);
      bs = (this.bpm[String(Math.round(track.bpm / 5) * 5)] || 0) / maxB;
    }
    return Math.min(1, gs * 0.55 + fs * 0.25 + bs * 0.2);
  }
}
