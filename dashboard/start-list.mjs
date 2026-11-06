// The organisers' race sheet (Excel, one tab per race) read into a start
// list, and runners' phones matched to it. Used by the dashboard's Start list
// tab and by tests/start-list.test.mjs. No library: an .xlsx file is a zip of
// XML files, and the browser (or Node 18+) can unzip with DecompressionStream.

// ---- Reading the .xlsx file ----
async function inflate(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}
// The files inside a zip, by name, from its central directory.
async function unzip(buf) {
  const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength), files = {};
  let end = b.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('This is not an Excel (.xlsx) file. In Excel, use File > Save As > Excel Workbook.');
  let p = v.getUint32(end + 16, true);
  const count = v.getUint16(end + 10, true), dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true), name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    files[name] = { method, size, local };
    p += 46 + nameLen + extra + comment;
  }
  return async name => {
    const f = files[name];
    if (!f) return null;
    const start = f.local + 30 + v.getUint16(f.local + 26, true) + v.getUint16(f.local + 28, true);
    const data = b.subarray(start, start + f.size);
    return dec.decode(f.method === 0 ? data : await inflate(data));
  };
}
const unxml = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]
  ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1))));
const textOf = xml => unxml([...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(m => m[1]).join(''));
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
const colNo = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Every tab of the workbook: { name, rows: [[cell text, ...], ...] }.
export async function readXlsx(buf) {
  const get = await unzip(buf);
  const wb = await get('xl/workbook.xml'), rels = await get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('This file has no sheets Excel can read. Save it as an Excel Workbook (.xlsx).');
  const shared = [...((await get('xl/sharedStrings.xml')) || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));
  const targets = Object.fromEntries([...rels.matchAll(/<Relationship\s[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const target = targets[attr(m[0], 'r:id')] || '';
    const xml = await get(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\s[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(' ' + c[1], 't'), body = c[2] || '', v = (body.match(/<v>([^<]*)<\/v>/) || [])[1];
        const val = type === 's' ? shared[+v] : type === 'inlineStr' ? textOf(body) : v != null ? unxml(v) : '';
        row[colNo(attr(' ' + c[1], 'r'))] = String(val ?? '').trim();
      }
      rows.push(Array.from(row, x => x ?? ''));
    }
    sheets.push({ name: unxml(attr(m[0], 'name') || ''), rows });
  }
  return sheets;
}

// ---- Tabs into a start list ----
// Which race a tab is, from its name (e.g. "Challenge Racesheet", "Traverse Race Sheet").
const RACE_WORDS = [[/back\s*2\s*back|back\s*to\s*back/i, 'back2back'], [/challenge/i, 'the-challenge'], [/traverse|mutarazi/i, 'mutarazi-traverse'],
  [/ultra/i, 'the-ultra'], [/epic/i, 'the-epic'], [/goat/i, 'the-goat']];
export const raceOfTab = name => (RACE_WORDS.find(([re]) => re.test(name)) || [])[1] || null;

// { entries: [{ bib, first_name, last_name, race_id, gender, nationality, category }], tabs: [...], warnings: [...] }
export function parseStartList(sheets) {
  const entries = [], tabs = [], warnings = [];
  for (const s of sheets) {
    const race = raceOfTab(s.name);
    if (!race) { warnings.push(`Tab “${s.name}” was left out: its name does not say which race it is.`); continue; }
    const h = s.rows.findIndex(r => r.some(c => /first\s*name/i.test(c)));
    if (h < 0) { warnings.push(`Tab “${s.name}” was left out: no “First name” heading found.`); continue; }
    const head = s.rows[h], col = re => head.findIndex(c => re.test(c));
    const c = { bib: col(/number|bib/i), first: col(/first\s*name/i), last: col(/last\s*name|surname/i), gender: col(/gender|sex/i),
      nat: col(/nationality|country/i), cat: col(/category/i) };
    let n = 0;
    for (const r of s.rows.slice(h + 1)) {
      const cell = i => (i >= 0 ? r[i] || '' : '').trim();
      const first = cell(c.first), last = cell(c.last);
      if (!first && !last) continue;                   // a spare race number with nobody on it yet
      const e = { bib: cell(c.bib) || null, first_name: first, last_name: last, race_id: race,
        gender: cell(c.gender) || null, nationality: cell(c.nat) || null, category: /^#/.test(cell(c.cat)) ? null : cell(c.cat) || null };
      entries.push(e); n++;
      if (/^#/.test(cell(c.cat))) warnings.push(`${first} ${last} (${e.bib || 'no number'}): the category cell shows an Excel error (${cell(c.cat)}).`);
    }
    tabs.push({ name: s.name, race, runners: n });
  }
  const seen = {};
  for (const e of entries) if (e.bib) (seen[e.bib] ||= []).push(e);
  for (const [bib, list] of Object.entries(seen)) if (list.length > 1) warnings.push(`Race number ${bib} is given to ${list.map(e => `${e.first_name} ${e.last_name}`).join(' and ')}.`);
  if (!entries.length) warnings.push('No runners were found in this file.');
  return { entries, tabs, warnings };
}

// ---- Phones matched to the start list ----
export const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const fullName = e => `${e.first_name || ''} ${e.last_name || ''}`.trim();
// How well a name typed in the app fits a start-list entry: 2 exactly, 1 first
// and last word (middle names left out, e.g. "Richard Mukarati"), 0 not at all.
function nameFit(typed, e) {
  const a = plain(typed), b = plain(fullName(e));
  if (!a || !b) return 0;
  if (a === b) return 2;
  const w = a.split(' '), first = plain(e.first_name).split(' ')[0], last = plain(e.last_name);
  return w.length > 1 && w[0] === first && w.slice(1).join(' ').endsWith(last) && last ? 1 : 0;
}
// For each registration (phone): the entry it belongs to, found by race number
// first, then by name (same race preferred). Returns Map(device_id -> { entry, how }).
export function matchRunners(entries, regs) {
  const byBib = new Map(entries.filter(e => e.bib).map(e => [String(e.bib), e])), out = new Map();
  for (const r of regs) {
    const bibHit = r.bib && byBib.get(String(r.bib).trim());
    if (bibHit && nameFit(r.name, bibHit)) { out.set(r.device_id, { entry: bibHit, how: 'number and name' }); continue; }
    let best = null, score = 0;
    for (const e of entries) {
      const s = nameFit(r.name, e) * 2 + (e.race_id === r.race_id ? 1 : 0);
      if (nameFit(r.name, e) && s > score) { best = e; score = s; }
    }
    if (best) out.set(r.device_id, { entry: best, how: 'name' });
    else if (bibHit) out.set(r.device_id, { entry: bibHit, how: 'number only' });
  }
  return out;
}
