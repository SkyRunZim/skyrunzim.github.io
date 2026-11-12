// Dashboard checks in a real (headless) browser, with the database faked so
// nothing real is read or changed. Run: npm test (after the app checks).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { addCheckpoints, buildRace, compactGpx, heightLookup, readWaypoints } from '../dashboard/route-build.mjs';

// A small Excel workbook, as Excel saves it (zip of XML, compressed), for the start list checks.
function makeXlsx(sheets) {
  const x = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const strings = [], si = s => (strings.includes(s) ? strings : strings.push(s) && strings).indexOf(s);
  const col = i => String.fromCharCode(65 + i);
  const files = { 'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map(([n], i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` };
  sheets.forEach(([, rows], i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, y) => `<row r="${y + 1}">${r.map((v, c) => {
      const ref = col(c) + (y + 1);
      if (v && v.error) return `<c r="${ref}" t="e"><v>${v.error}</v></c>`;
      return /^\d+$/.test(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
    }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  });
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(s => `<si><t>${x(s)}</t></si>`).join('')}</sst>`;
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, n, data); central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const PORT = 8096, URL = `http://localhost:${PORT}/dashboard/`;
const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)]);
await new Promise(r => server.stdout.once('data', r));
const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); if (!ok) failures++; };

try {
  // ------------------------------------------------------------------
  // The dashboard's heights file gives the same routes as the app build.
  {
    const grid = JSON.parse(readFileSync('dashboard/nyanga-heights.json', 'utf8'));
    const bin = readFileSync('dashboard/nyanga-heights.bin');
    const look = heightLookup(grid, new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)));
    const races = JSON.parse(readFileSync('races/races.json', 'utf8'));
    const pool = [];
    for (const r of races) addCheckpoints(pool, readFileSync(`races/${r.file}`, 'utf8'), r.id);
    const differ = races.filter(r => (r.map || 'nyanga') === 'nyanga')
      .filter(r => JSON.stringify(buildRace(r, readFileSync(`races/${r.file}`, 'utf8'), pool, look).route) !== readFileSync(`data/races/${r.id}.json`, 'utf8'));
    check('Dashboard builds every Nyanga route exactly as the app has it', !differ.length, differ.map(r => r.id).join(', '));
    // The compact copy kept of a big file builds the same route again.
    const goat = races.find(r => r.id === 'the-goat'), goatXml = readFileSync('races/the-goat.gpx', 'utf8');
    const { route } = buildRace(goat, goatXml, pool, look);
    const small = compactGpx(route, readWaypoints(goatXml));
    const again = buildRace(goat, small, pool, look).route;
    check('A big GPX is kept in compact form that rebuilds the same route', JSON.stringify(again) === JSON.stringify(route) && small.length < goatXml.length / 3,
      `${(goatXml.length / 1e6).toFixed(1)} MB → ${(small.length / 1e6).toFixed(2)} MB`);
    // The checkpoints file the dashboard loads matches the GPX files.
    const wf = JSON.parse(readFileSync('dashboard/race-waypoints.json', 'utf8')), pool2 = [];
    for (const r of races) addCheckpoints(pool2, wf[r.id], r.id);
    check('The small checkpoints file gives the same checkpoints as the GPX files', JSON.stringify(pool2) === JSON.stringify(pool),
      `${readFileSync('dashboard/race-waypoints.json').length} bytes`);
  }

  // ------------------------------------------------------------------
  // Race settings: drop a GPX file, preview, publish.
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(URL, { waitUntil: 'networkidle' });
  check('Signed out: the organiser sign-in shows', await page.locator('#loginForm').isVisible());
  await page.evaluate(async () => {
    // Fake database: queries answer "nothing yet"; inserts are recorded.
    window.__inserts = [];
    db.from = table => {
      const o = { select: () => o, order: () => o, eq: () => o, in: () => o, single() { o.one = true; return o; },
        insert(row) { window.__inserts.push({ table, row }); o.ins = true; return o; },
        limit: () => o,
        then: res => Promise.resolve(o.ins && o.one ? { data: { id: 99 }, error: null }
          : table === 'start_list' ? { data: window.__startList || [], error: null } : { data: o.one ? null : [], error: null }).then(res) };
      return o;
    };
    Object.defineProperty(db, 'functions', { value: { invoke: async () => ({ data: { sent: 3, failed: 0, phones: 3 }, error: null }) } });
    await loadRaces();
    $('login').hidden = true; $('app').hidden = false; document.querySelector('.tabs').hidden = false;
    phones = []; renderAll(); await loadRoutes(); show('races');
  });
  check('Race settings lists every race', await page.locator('.racecard').count() === 6);

  const fileInput = '.racecard[data-race="the-challenge"] input[type=file]';
  await page.setInputFiles(fileInput, 'races/the-challenge.gpx');
  await page.waitForSelector('#routeModal:not([hidden])', { timeout: 15000 });
  const same = await page.locator('#rmTable').innerText();
  check('The same GPX file previews as no change', /Distance\s+28.6 km\s+28.6 km\s*\n/.test(same) && /Climb\s+1383 m\s+1383 m/.test(same) && /Checkpoints\s+9\s+9/.test(same), same.replace(/\n/g, ' | '));
  await page.click('#rmClose');

  // A shortened route: the last 150 track points cut off.
  const xml = readFileSync('races/the-challenge.gpx', 'utf8'), pts = [...xml.matchAll(/<trkpt[\s\S]*?<\/trkpt>/g)];
  const last = pts[pts.length - 1];
  const short = join(mkdtempSync(join(tmpdir(), 'skyrun-')), 'challenge-short.gpx');
  writeFileSync(short, xml.slice(0, pts[pts.length - 150].index) + xml.slice(last.index + last[0].length));
  await page.setInputFiles(fileInput, short);
  await page.waitForSelector('#routeModal:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(500);
  check('A changed route previews with what changes', (await page.locator('#rmTable').innerText()).includes('-6.7 km') &&
    (await page.locator('#rmWarn').innerText()).includes('more than 15%'), await page.locator('#rmWarn').innerText());
  check('The preview map draws both routes', await page.locator('#rmMap path.leaflet-interactive').count() >= 2);
  await page.click('#rmPublish');
  await page.waitForSelector('#routeModal', { state: 'hidden', timeout: 10000 }).catch(() => {});
  const ins = await page.evaluate(() => window.__inserts.map(i => ({ table: i.table, ...i.row, route: i.row.route && i.row.route.version, gpx: !!i.row.gpx })));
  const pub = ins.find(i => i.table === 'race_routes'), msg = ins.find(i => i.table === 'messages');
  check('Publishing saves version 2 of the route, with its GPX', !!pub && pub.race_id === 'the-challenge' && pub.version === 2 && pub.route === 2 && pub.summary.distanceKm === 21.9 && pub.gpx);
  check('Publishing tells that race\'s runners', !!msg && msg.race_id === 'the-challenge' && msg.body.startsWith('The route for The Challenge has been updated'));
  check('Publishing confirms how many phones were notified', (await page.locator('#toast').innerText()).includes('3 phones notified'));

  // A wrong file: Back2Back needs one route per day. Said on the card.
  await page.setInputFiles('.racecard[data-race="back2back"] input[type=file]', 'races/the-challenge.gpx');
  await page.waitForSelector('.racecard[data-race="back2back"] .cardstatus.bad', { timeout: 10000 }).catch(() => {});
  const refusal = await page.locator('.racecard[data-race="back2back"] .cardstatus').innerText().catch(() => '');
  check('A file with the wrong number of days is refused on the card, before any preview', await page.locator('#routeModal').isHidden() &&
    refusal.includes('1 route') && refusal.includes('2'), refusal);

  // The biggest file (the GOAT, 5 MB): previews without downloading other races' files, kept compact.
  const fetched = [];
  page.on('request', r => fetched.push(r.url()));
  const t0 = Date.now();
  await page.setInputFiles('.racecard[data-race="the-goat"] input[type=file]', 'races/the-goat.gpx');
  const shown = await page.waitForSelector('#routeModal:not([hidden])', { timeout: 20000 }).then(() => true).catch(() => false);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check('The GOAT\'s 5 MB file previews quickly', shown, `${secs} s`);
  check('No other race\'s GPX file or height data is downloaded for a file with heights', !fetched.some(u => /\/races\/.*\.gpx|nyanga-heights/.test(u)),
    fetched.filter(u => /\.gpx|heights/.test(u)).join(' '));
  check('The GOAT previews as no change', /Distance\s+114.9 km\s+114.9 km\s*\n/.test(await page.locator('#rmTable').innerText()));
  check('The GOAT\'s file is kept compact', await page.evaluate(() => pending.gpx.length < 1.5e6), await page.evaluate(() => `${(pending.gpx.length / 1e6).toFixed(2)} MB`));
  await page.click('#rmClose');
  // ------------------------------------------------------------------
  // Course map: every race on the official map, shown or hidden at will.
  await page.evaluate(() => show('course'));
  await page.waitForFunction(() => document.querySelectorAll('#cmMap path.leaflet-interactive').length >= 6, null, { timeout: 15000 }).catch(() => {});
  const lines = () => page.evaluate(() => [...document.querySelectorAll('#cmMap path.leaflet-interactive')].filter(p => p.getAttribute('stroke-width') === '4').length);
  check('Course map lists the six Nyanga races', await page.locator('#cmRaces .cmrace').count() === 6);
  check('Course map draws every race (Back2Back as its two days)', await lines() === 7, `${await lines()} route lines`);
  check('Shared checkpoints are marked once', await page.evaluate(() => {
    const dots = [...document.querySelectorAll('#cmMap path.leaflet-interactive')].filter(p => p.getAttribute('stroke-width') === '1.5');
    return dots.length > 20 && new Set(dots.map(d => d.getAttribute('d'))).size === dots.length;
  }));
  await page.uncheck('[data-cm="the-goat"]');
  await page.waitForTimeout(300);
  check('Unticking a race hides it', await lines() === 6);
  await page.check('#cmKm'); await page.waitForTimeout(300);
  check('Distance markers every 5 km', await page.locator('.kmlbl').count() > 30, `${await page.locator('.kmlbl').count()} markers`);
  await page.click('#cmNone'); await page.waitForTimeout(200);
  await page.check('[data-cm="the-challenge"]'); await page.waitForTimeout(400);
  // Tap the Challenge route: which race, how far along, how high.
  const at = await page.evaluate(() => { const r = courseMap.routes['the-challenge'].stages[0].pts[250]; const pt = courseMap.map.latLngToContainerPoint([r[0], r[1]]); return { x: pt.x, y: pt.y }; });
  const box = await page.locator('#cmMap').boundingBox();
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await page.waitForSelector('.leaflet-popup-content', { timeout: 3000 }).catch(() => {});
  const pop = await page.locator('.leaflet-popup-content').innerText().catch(() => '');
  check('Tapping a route says which race, how far along and how high', pop.includes('The Challenge') && /km \d+\.\d of 28\.\d/.test(pop) && / m high/.test(pop), pop.replace(/\n/g, ' | '));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('[data-gpx="the-challenge"]')]);
  check('A race\'s current route downloads as a GPX file', !!dl && dl.suggestedFilename() === 'the-challenge.gpx', dl ? dl.suggestedFilename() : 'no download');
  check('No Harare Prep on the course map', !(await page.locator('#cmRaces').innerText()).includes('Harare') && !(await page.locator('[data-cmap]').count()));
  // ------------------------------------------------------------------
  // Start list: the race sheet dropped in, checked, saved; phones matched to it.
  {
    const sheet = join(mkdtempSync(join(tmpdir(), 'skyrun-')), 'Race Sheet.xlsx');
    writeFileSync(sheet, makeXlsx([
      ['Challenge Racesheet', [['Challenge Registration'], ['Number', 'First name', 'Last name', 'Gender', 'Nationality', 'Category'],
        ['115', 'Ann', 'Smith', 'Female', 'ZW', 'Open'], ['116', 'Benjamin', 'Jones', 'Male', 'ZA', 'Veteran'],
        ['117', 'Tyla', 'Kennedy', 'Female', 'ZW', { error: '#NUM!' }], ['118'], ['119']]],
      ['GOAT Racesheet', [['GOAT Registration'], ['Race Number', 'First name', 'Last name'], ['2', 'Kwiri', 'Chí & Co']]],
      ['Notes', [['Anything else']]],
    ]));
    await page.evaluate(() => {
      window.__rpc = [];
      db.rpc = async (fn, args) => { window.__rpc.push({ fn, args }); return { data: args.p_rows.length, error: null }; };
      const t0 = new Date(Date.now() - 3600e3).toISOString();
      phones = [
        { device_id: 'd1', name: 'ann smith', bib: '115', race_id: 'the-challenge', setup_done: true, map_saved: true, location_ok: true, indemnity_at: t0, first_seen: t0, last_seen: t0 },
        { device_id: 'd2', name: 'Ben Jones', bib: '116', race_id: 'the-ultra', setup_done: true, map_saved: false, location_ok: true, first_seen: t0, last_seen: t0 },
        { device_id: 'd3', name: 'Someone Else', bib: '', race_id: 'the-epic', setup_done: true, map_saved: true, location_ok: true, indemnity_at: t0, first_seen: t0, last_seen: t0 },
      ];
      show('startlist');
      return loadStartList();
    });
    check('Start list tab asks for the race sheet when there is none', (await page.locator('#slSub').innerText()).includes('No start list yet'));
    await page.setInputFiles('#slDrop input', sheet);
    await page.waitForSelector('#slSave', { timeout: 10000 }).catch(() => {});
    const checkText = await page.locator('#slCheck').innerText().catch(() => '');
    check('The dropped sheet is read: runners per race, spare numbers left out', checkText.includes('Race Sheet.xlsx: 4 runners') && checkText.includes('The Challenge: 3') && checkText.includes('The GOAT: 1'), checkText.replace(/\n/g, ' | '));
    check('Problems in the sheet are pointed out before saving', checkText.includes('Tyla Kennedy (117)') && checkText.includes('#NUM!') && checkText.includes('Tab “Notes” was left out'));
    await page.click('#slSave');
    await page.waitForFunction(() => window.__rpc.length, null, { timeout: 5000 }).catch(() => {});
    const saved = await page.evaluate(() => window.__rpc[0]);
    check('Saving replaces the start list in one go', !!saved && saved.fn === 'replace_start_list' && saved.args.p_file === 'Race Sheet.xlsx' && saved.args.p_rows.length === 4 &&
      saved.args.p_rows[3].last_name === 'Chí & Co' && saved.args.p_rows[2].category === null, JSON.stringify(saved && saved.args.p_rows[3]));
    // The database now holds that list.
    await page.evaluate(rows => { window.__startList = rows; return loadStartList(); }, saved.args.p_rows);
    const body = await page.locator('#slBody').innerText();
    check('Each runner on the list shows whether they are in the app', /115\s+Ann Smith[\s\S]*Race-ready/.test(body) && /116\s+Benjamin Jones[\s\S]*In the app, not ready/.test(body) &&
      /117\s+Tyla Kennedy[\s\S]*Not in the app yet/.test(body), body.replace(/\n/g, ' | '));
    check('A different race or name in the app is pointed out', body.includes('Chose The Ultra in the app') && body.includes('Typed their name as “Ben Jones”'));
    check('Phones not on the start list are listed', (await page.locator('#slExtra').innerText()).includes('Someone Else, The Epic'));
    check('Race totals against the list', (await page.locator('#slRaces').innerText()).includes('3 on the list · 2 in the app (67%) · 1 race-ready'), await page.locator('#slRaces').innerText());
    await page.click('[data-slchip="none"]');
    check('Filter: not in the app yet', (await page.locator('#slBody tr').count()) === 2);
    await page.evaluate(() => { state.chip = 'all'; renderTable(); });
    const rt = await page.locator('#tbody').innerText();
    check('Runners tab flags start-list and indemnity problems', rt.includes('Not on the start list') && rt.includes('Different race on the start list') && rt.includes('Indemnity not accepted'), rt.replace(/\n/g, ' | '));
    check('Overview counts runners against the start list', (await page.locator('#kpis').innerText()).includes('2/4'), await page.locator('#kpis').innerText());
  }

  // ------------------------------------------------------------------
  // The same person signing in several times is shown and counted once.
  {
    const counts = await page.evaluate(() => {
      window.__startList = []; startList = [];
      const t = h => new Date(Date.now() - h * 3600e3).toISOString();
      const reg = (id, name, bib, race, s, m, l, seen, extra = {}) => ({ device_id: id, name, bib, race_id: race, setup_done: s, map_saved: m, location_ok: l,
        app_version: 'v21', phone: 'iPhone', first_seen: t(48), last_seen: t(seen), indemnity_at: s ? t(40) : null, ...extra });
      phones = [
        // Five sign-ins by one runner, as seen on the live dashboard.
        reg('j1', 'Jane Doe', '363', 'harare-prep', true, true, false, 30, { app_version: 'v20' }),
        reg('j2', 'Jane Doe', '363', 'mutarazi-traverse', true, true, false, 20),
        reg('j3', 'Jane Doe', '363', 'mutarazi-traverse', true, true, true, 10),
        reg('j4', 'jane  DOE', '363', 'mutarazi-traverse', true, true, true, 2),
        reg('j5', 'Jane Doe', '363', '', false, false, false, 1),
        // A middle name typed once, and a copy with no race number: still her.
        reg('j6', 'Jane Mary Doe', '363', 'mutarazi-traverse', false, false, false, 5),
        reg('j7', 'Jane Doe', '', '', false, false, false, 6),
        // Someone else who typed her number by mistake: a real problem.
        reg('x1', 'Peter Smith', '363', 'the-challenge', true, true, true, 3),
        // Different numbers are never joined, even with the same name.
        reg('k1', 'Sam Lee', '10', 'the-challenge', true, true, true, 4),
        reg('k2', 'Sam Lee', '11', 'the-ultra', true, true, true, 4),
      ];
      pushIds = new Set(['j1']);
      reads = [{ message_id: 1, device_id: 'j1' }, { message_id: 1, device_id: 'j4' }, { message_id: 1, device_id: 'k1' }];
      messages = [{ id: 1, created_at: t(1), race_id: null, body: 'Briefing at 17:00' }];
      state.q = ''; state.issue = null; state.chip = 'all';
      renderAll(); show('runners');
      return { people: runners.length, jane: runners.filter(r => r.name.toLowerCase().includes('jane')).map(r => ({ id: r.device_id, n: r.others.length + 1, race: r.race_id })) };
    });
    check('Seven sign-ins by one runner become one person', counts.people === 4 && counts.jane.length === 1 && counts.jane[0].n === 7, JSON.stringify(counts));
    check('Her row uses her best-set-up sign-in (most recent if equal)', counts.jane[0].id === 'j4' && counts.jane[0].race === 'mutarazi-traverse', JSON.stringify(counts.jane));
    const kpis = await page.evaluate(() => { show('overview'); return $('kpis').innerText; });
    check('Totals count her once', /Signed in to the app\s*4\b/i.test(kpis) && kpis.includes('4/4'), kpis.replace(/\n/g, ' | '));
    await page.evaluate(() => show('runners'));
    const rows = await page.locator('#tbody tr').count();
    const janeRow = await page.locator('#tbody tr', { hasText: 'Jane' }).first().innerText();
    check('One row for her, tagged with how many times she signed in', rows === 4 && janeRow.includes('7 sign-ins'), janeRow.replace(/\s+/g, ' '));
    const twice = await page.evaluate(() => runners.filter(ISSUES[0][3]).map(r => r.name));
    check('"Bib used twice" now means two different people (her and Peter), not her own sign-ins', twice.length === 2 && twice.includes('Peter Smith'), JSON.stringify(twice));
    check('Notifications on any of her sign-ins count for her', janeRow.includes('✓ Yes') && !janeRow.includes('Notifications off'), janeRow.replace(/\s+/g, ' '));
    const peter = await page.locator('#tbody tr', { hasText: 'Peter Smith' }).innerText();
    check('A different person on the same number is still flagged', peter.includes('Bib used twice'), peter.replace(/\s+/g, ' '));
    check('Different race numbers are not joined', await page.locator('#tbody tr', { hasText: 'Sam Lee' }).count() === 2);
    check('The table says how many extra sign-ins were folded in', (await page.locator('#rcount').innerText()).includes('6 extra sign-ins'), await page.locator('#rcount').innerText());
    await page.click('[data-person="j4"]');
    check('Tapping the tag shows her other sign-ins, marked as not counted', await page.locator('#tbody tr.sub').count() === 6 && (await page.locator('#tbody tr.sub').first().innerText()).includes('Not counted'));
    await page.click('[data-person="j4"]');
    check('Tapping again hides them', await page.locator('#tbody tr.sub').count() === 0);
    await page.fill('#q', 'jane mary');
    check('Search finds her by a name typed on another sign-in', await page.locator('#tbody tr').count() === 1);
    await page.fill('#q', '');
    const msg = await page.evaluate(() => { show('messages'); return $('msgList').innerText; });
    check('A message read on two of her sign-ins counts once', msg.includes('read by 2 of 4'), msg.replace(/\n/g, ' | '));
  }
  check('No page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('Dashboard test run crashed', false, err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} dashboard check(s) failed` : '\nAll dashboard checks passed');
process.exit(failures ? 1 : 0);
