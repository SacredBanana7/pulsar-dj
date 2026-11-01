// Copies the MIDI controller mappings from a Mixxx checkout into
// app/controllers/mixxx/ and writes index.json (one entry per mapping).
//
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/mixxxdj/mixxx.git
//   git -C mixxx sparse-checkout set res/controllers
//   node tools/sync-mixxx-mappings.mjs path/to/mixxx
//
// The mappings are GPL-2.0-or-later (c) the Mixxx Development Team.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const mixxx = process.argv[2];
if (!mixxx) {
  console.error('usage: node tools/sync-mixxx-mappings.mjs <mixxx checkout>');
  process.exit(1);
}
const src = join(mixxx, 'res', 'controllers');
const dest = fileURLToPath(new URL('../app/controllers/mixxx/', import.meta.url));
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : '';
};
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

const files = readdirSync(src);
const neededJs = new Set(['common-controller-scripts.js']);
const index = [];
for (const f of files.filter((x) => x.endsWith('.midi.xml'))) {
  const xml = readFileSync(join(src, f), 'utf8');
  const scripts = [...xml.matchAll(/<file\s+[^>]*filename="([^"]+)"/g)].map((m) => m[1]);
  scripts.forEach((s) => neededJs.add(s));
  const ctrl = /<controller\s+id="([^"]*)"/.exec(xml);
  const devices = [...xml.matchAll(/<product\s+([^>]*)\/>/g)].map((m) => {
    const attr = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attr[a[1]] = a[2];
    return attr;
  });
  index.push({
    file: f,
    name: decode(tag(xml, 'name')) || f.replace('.midi.xml', ''),
    author: decode(tag(xml, 'author')),
    description: decode(tag(xml, 'description')).slice(0, 300),
    forums: tag(xml, 'forums'),
    manual: tag(xml, 'manual'),
    controllerId: ctrl ? decode(ctrl[1]) : '',
    devices,
    scripts,
  });
  copyFileSync(join(src, f), join(dest, f));
}
// scripts can load helper libraries too (e.g. midi-components, lodash)
for (const js of files.filter((x) => x.endsWith('.js'))) {
  const text = readFileSync(join(src, js), 'utf8');
  if (neededJs.has(js) || /^(lodash|midi-components|common-)/.test(js)) {
    copyFileSync(join(src, js), join(dest, js));
  }
  void text;
}
index.sort((a, b) => a.name.localeCompare(b.name));
let commit = '';
try { commit = execSync('git rev-parse HEAD', { cwd: mixxx }).toString().trim(); } catch {}
writeFileSync(join(dest, 'index.json'), JSON.stringify({ source: 'https://github.com/mixxxdj/mixxx/tree/main/res/controllers', commit, license: 'GPL-2.0-or-later', mappings: index }, null, 1));
writeFileSync(join(dest, 'NOTICE.md'), `# Mixxx controller mappings\n\nThe \`.midi.xml\` and \`.js\` files in this folder are taken unchanged from the\n[Mixxx](https://mixxx.org) project (${index.length} mappings, commit \`${commit || 'unknown'}\`).\n\nCopyright (C) 2001-2026 Mixxx Development Team and the individual mapping authors.\nLicensed under the GNU General Public License, version 2 or (at your option) any later version.\nPulsar DJ runs them through its Mixxx compatibility layer (\`app/js/mixxx/\`).\n\nUpdate with \`node tools/sync-mixxx-mappings.mjs <mixxx checkout>\`.\n`);
console.log(`${index.length} mappings, ${neededJs.size} scripts referenced -> ${dest}`);
