// Dashboard checks in a real (headless) browser, with the database faked so
// nothing real is read or changed. Run: npm test (after the app checks).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCheckpoints, buildRace, compactGpx, heightLookup, readWaypoints } from '../dashboard/route-build.mjs';

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
        then: res => Promise.resolve(o.ins && o.one ? { data: { id: 99 }, error: null } : { data: o.one ? null : [], error: null }).then(res) };
      return o;
    };
    Object.defineProperty(db, 'functions', { value: { invoke: async () => ({ data: { sent: 3, failed: 0, phones: 3 }, error: null }) } });
    await loadRaces();
    $('login').hidden = true; $('app').hidden = false; document.querySelector('.tabs').hidden = false;
    runners = []; renderAll(); await loadRoutes(); show('races');
  });
  check('Race settings lists every race', await page.locator('.racecard').count() === 7);

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
  await page.click('[data-cmap="harare"]'); await page.waitForTimeout(500);
  check('The Harare practice map shows Harare Prep', (await page.locator('#cmRaces').innerText()).includes('Harare Prep') && await page.locator('#cmRaces .cmrace').count() === 1 && await lines() === 1);
  check('No page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('Dashboard test run crashed', false, err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} dashboard check(s) failed` : '\nAll dashboard checks passed');
process.exit(failures ? 1 : 0);
