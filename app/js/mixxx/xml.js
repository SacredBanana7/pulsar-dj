// Parser for Mixxx *.midi.xml controller mappings (MixxxMIDIPreset).
// Turns the XML into plain objects: controller id, script files with their
// function prefixes, input <controls>, LED <outputs> and <settings> defaults.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const OPTION_NAMES = {
  normal: 'normal', invert: 'invert', rot64: 'rot64', rot64inv: 'rot64inv', rot64_inv: 'rot64inv',
  rot64fast: 'rot64fast', rot64_fast: 'rot64fast', diff: 'diff', button: 'button', switch: 'switch',
  hercjog: 'hercjog', hercjogfast: 'hercjogfast', spread64: 'spread64', selectknob: 'selectknob',
  'soft-takeover': 'softtakeover', softtakeover: 'softtakeover', 'script-binding': 'script',
  'fourteen-bit-msb': 'msb', 'fourteen-bit-lsb': 'lsb',
};

// Qt's toInt(&ok, 0): hex (0x..), octal (0..) or decimal
function int(text, fallback) {
  if (text == null) return fallback;
  const s = String(text).trim();
  if (!s) return fallback;
  let n;
  if (/^[-+]?0x[0-9a-f]+$/i.test(s)) n = parseInt(s, 16);
  else if (/^[-+]?0[0-7]+$/.test(s)) n = parseInt(s, 8);
  else if (/^[-+]?\d+$/.test(s)) n = parseInt(s, 10);
  else return fallback;
  return Number.isFinite(n) ? n : fallback;
}

function num(text, fallback) {
  if (text == null) return fallback;
  const s = String(text).trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

const child = (el, name) => {
  for (const c of el.children) if (c.nodeName.toLowerCase() === name) return c;
  return null;
};
const text = (el, name) => {
  const c = child(el, name);
  return c ? c.textContent.trim() : null;
};

function parseOptions(el) {
  const opts = new Set();
  const o = child(el, 'options');
  if (!o) return opts;
  for (const c of o.children) {
    const name = OPTION_NAMES[c.nodeName.toLowerCase()];
    if (name && name !== 'normal') opts.add(name);
  }
  return opts;
}

function parseSettings(root) {
  const out = {};
  for (const opt of root.getElementsByTagName('option')) {
    const variable = opt.getAttribute('variable');
    if (!variable) continue;
    const type = (opt.getAttribute('type') || 'string').toLowerCase();
    const def = opt.getAttribute('default');
    let v;
    if (type === 'boolean') v = def === 'true' || def === '1';
    else if (type === 'integer' || type === 'real' || type === 'number') v = num(def, 0);
    else if (type === 'enum') {
      const values = [...opt.getElementsByTagName('value')];
      const pick = values.find((x) => x.getAttribute('default') === 'true') || values[0];
      v = pick ? pick.textContent.trim() : '';
    } else if (type === 'color') v = int(def, 0);
    else v = def ?? '';
    out[variable] = v;
  }
  return out;
}

export function parseMapping(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 200));
  const root = doc.documentElement;
  const info = child(root, 'info');
  const ctl = child(root, 'controller');
  if (!ctl) throw new Error('no <controller> element');
  const result = {
    name: info ? text(info, 'name') || '' : '',
    author: info ? text(info, 'author') || '' : '',
    id: ctl.getAttribute('id') || '',
    scripts: [],
    controls: [],
    outputs: [],
    settings: parseSettings(root),
  };
  const sf = child(ctl, 'scriptfiles');
  if (sf) {
    for (const f of sf.children) {
      if (f.nodeName.toLowerCase() !== 'file') continue;
      const file = f.getAttribute('filename');
      if (file) result.scripts.push({ file, prefix: (f.getAttribute('functionprefix') || '').trim() });
    }
  }
  const controls = child(ctl, 'controls');
  if (controls) {
    for (const c of controls.children) {
      if (c.nodeName.toLowerCase() !== 'control') continue;
      const status = int(text(c, 'status'), null);
      if (status == null) continue;
      result.controls.push({
        group: text(c, 'group') || '',
        key: text(c, 'key') || '',
        status: status & 0xff,
        midino: int(text(c, 'midino'), 0) & 0xff,
        options: parseOptions(c),
      });
    }
  }
  const outputs = child(ctl, 'outputs');
  if (outputs) {
    for (const o of outputs.children) {
      if (o.nodeName.toLowerCase() !== 'output') continue;
      result.outputs.push({
        group: text(o, 'group') || '',
        key: text(o, 'key') || '',
        status: int(text(o, 'status'), 0) & 0xff,
        midino: int(text(o, 'midino'), 0) & 0xff,
        on: int(text(o, 'on'), 0x7f),
        off: int(text(o, 'off'), 0x00),
        min: num(text(o, 'minimum'), 0),
        max: num(text(o, 'maximum'), 1),
      });
    }
  }
  return result;
}
