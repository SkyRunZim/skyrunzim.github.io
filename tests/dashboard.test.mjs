// Dashboard checks in a real (headless) browser, with the database faked so
// nothing real is read or changed. Run: npm test (after the app checks).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCheckpoints, buildRace, heightLookup } from '../dashboard/route-build.mjs';

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

  // A wrong file: Back2Back needs one route per day.
  await page.setInputFiles('.racecard[data-race="back2back"] input[type=file]', 'races/the-challenge.gpx');
  await page.waitForTimeout(800);
  check('A file with the wrong number of days is refused before any preview', await page.locator('#routeModal').isHidden());
  check('No page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('Dashboard test run crashed', false, err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} dashboard check(s) failed` : '\nAll dashboard checks passed');
process.exit(failures ? 1 : 0);
