// open-dj-library: an open catalog of freely licensed tracks that already carry
// BPM, beat grid and key (https://github.com/SacredBanana7/open-dj-library).
// Loaded once a day, cached in IndexedDB, searched locally. Results use the same
// shape as openmusic.js, so the online panel can show and load them directly.

import { db } from './db.js';
import { SOURCES } from './openmusic.js';

export const CATALOG_URL = 'https://raw.githubusercontent.com/SacredBanana7/open-dj-library/main/catalog.json';
const MAX_AGE = 24 * 3600 * 1000;

function toResult(e) {
  const l = e.license || {};
  const a = e.analysis || {};
  return {
    kind: 'track',
    id: e.id.slice(e.source.length + 1),
    source: e.source,
    sourceLabel: SOURCES[e.source]?.label || e.source,
    provider: e.provider,
    title: e.title,
    artist: e.artist,
    artistUrl: e.artistUrl || '',
    album: e.album || '',
    durationSec: a.durationSec || 0,
    streamUrl: e.audioUrl,
    pageUrl: e.pageUrl,
    fileName: e.fileName || '',
    size: e.sizeBytes || 0,
    license: {
      code: l.code, version: l.version, url: l.url, label: l.label,
      by: !!l.attribution, sa: !!l.shareAlike, nc: !l.commercial, nd: !l.derivatives,
      publicDomain: !!l.publicDomain, open: true,
    },
    genre: e.genre || '',
    tags: e.tags || [],
    bpm: a.bpm || 0,
    camelot: a.key?.camelot || '',
    keyName: a.key?.name || '',
    proxy: e.source === 'ccmixter',
    catalog: e,
  };
}

export class Catalog {
  constructor() {
    this.entries = [];
    this.results = [];
    this.loaded = false;
    this.error = '';
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const cached = await db.get('kv', 'odl-catalog').catch(() => null);
      if (cached?.data) this.use(cached.data);
      if (cached && Date.now() - cached.fetchedAt < MAX_AGE) return;
      try {
        const res = await fetch(CATALOG_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.format !== 'open-dj-library') throw new Error('unbekanntes Format');
        this.use(data);
        db.put('kv', 'odl-catalog', { fetchedAt: Date.now(), data }).catch(() => {});
      } catch (e) {
        this.error = this.loaded ? '' : `Katalog nicht erreichbar (${e.message})`;
      }
    })();
    return this.loading;
  }

  use(data) {
    this.entries = data.tracks || [];
    this.results = this.entries.map(toResult);
    this.loaded = true;
    this.error = '';
  }

  // query: free text (title, artist, genre, tags, "8A", "124"); genre: label match
  search({ query = '', genre = '', genreLabel = '', license = 'any', limit = 60 } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const g = (genreLabel || genre || '').toLowerCase();
    return this.results.filter((r) => {
      if (license === 'commercial' && (r.license.nc || r.license.nd)) return false;
      if (license === 'cc0' && !r.license.publicDomain) return false;
      if (g && !(r.genre || '').toLowerCase().includes(g) && !r.tags.some((t) => t.toLowerCase().includes(g))) return false;
      if (!terms.length) return true;
      const hay = `${r.title} ${r.artist} ${r.album} ${r.genre} ${r.tags.join(' ')} ${r.camelot} ${Math.round(r.bpm)}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    }).slice(0, limit);
  }
}
