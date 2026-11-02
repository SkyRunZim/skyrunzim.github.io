// End-to-end checks in a real (headless) browser.
// Run: npm test   (optional: node tests/app.test.mjs <folder for screenshots>)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const OUT = process.argv[2] || null;
const PORT = 8093, URL = `http://localhost:${PORT}/`;
const EDDY = { latitude: -18.395, longitude: 32.835 };     // on the race map
const HARARE = { latitude: -17.83, longitude: 31.05 };      // far outside
// A runner who has already been through setup (used unless a test wants a fresh phone).
const SET_UP = { setupDone: true, raceId: 'the-challenge', name: 'Test Runner', raceVersion: 1 };

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT)]);
await new Promise(r => server.stdout.once('data', r));
const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); if (!ok) failures++; };
const shot = async (page, name) => { if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` }); };

async function newPage({ fresh = false, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...opts });
  if (!fresh) await ctx.addInitScript(p => { if (!localStorage.getItem('profile')) localStorage.setItem('profile', p); }, JSON.stringify(SET_UP));
  // Race control: never touch the real database from tests; record what the app sends.
  // page.messages = what race control "has posted" for get_messages.
  const calls = [];
  let page;
  await ctx.route('**/*.supabase.co/**', route => {
    const req = route.request(), fn = req.url().split('/rpc/')[1];
    calls.push({ fn, body: JSON.parse(req.postData() || '{}') });
    if (fn === 'get_messages') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page.messages) });
    return route.fulfill({ status: 204, body: '' });
  });
  page = await ctx.newPage();
  page.calls = calls; page.messages = [];
  const errors = [];
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  return { ctx, page, errors };
}
const text = (page, sel) => page.locator(sel).innerText();
// Picks a race in the change-race list. If that race's map is not saved on
// the phone, the app asks to download it; tests that don't need it skip.
const pickRace = async (page, id) => {
  await page.click(`.racecard[data-id="${id}"]`);
  await page.click('#suConfirm');
  await page.waitForTimeout(250);
  if (await page.locator('#suSkip').isVisible().catch(() => false)) await page.click('#suSkip');
};
const fakeFix = (page, f) => page.evaluate(f => onFix({ coords: { accuracy: 6, altitude: 1200, altitudeAccuracy: 8, heading: null, speed: null, ...f }, timestamp: f.t || Date.now() }), f);

try {
  // ------------------------------------------------------------------
  // Permission denied
  {
    const { ctx, page } = await newPage({ permissions: [] });
    await page.goto(URL);
    await page.click('#locateBtn');
    await page.waitForFunction(() => document.getElementById('gpsBadges').textContent.includes('blocked'), null, { timeout: 10000 }).catch(() => {});
    check('Permission denied shows "Location blocked" with instructions', (await text(page, '#gpsBadges')).includes('Location blocked') && (await text(page, '#gpsHint')).includes('Settings'), await text(page, '#gpsBadges'));
    await ctx.close();
  }

  // ------------------------------------------------------------------
  // Start-up screen: says "Loading" at once; after 5 s of a stuck load, says what to do
  {
    const { ctx, page } = await newPage();
    await ctx.route('**/app.js', r => r.abort());       // a load that never finishes
    await page.goto(URL);
    check('Start-up screen says Loading straight away', (await text(page, '#boot')).includes('Loading SkyRunZim') && !(await page.locator('#bootSlow').isVisible()));
    await page.waitForTimeout(5500);
    check('After 5 s it says to turn off wifi and mobile data and reopen', await page.locator('#bootSlow').isVisible() &&
      (await text(page, '#bootSlow')).includes('wifi and mobile data'), await text(page, '#bootSlow'));
    await ctx.close();
  }

  // ------------------------------------------------------------------
  // Notifications: a runner already set up is offered them once; turning
  // them on saves this phone's push address with its race.
  {
    const { ctx, page } = await newPage({ permissions: ['notifications'] });
    // Headless browsers have no push service: stand in a fake one.
    await ctx.addInitScript(() => {
      const fake = { endpoint: 'https://push.example.com/send/abc123', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'pk', auth: 'au' } }; } };
      let subscribed = null;
      PushManager.prototype.getSubscription = async () => subscribed;
      PushManager.prototype.subscribe = async () => (subscribed = fake);
    });
    await ctx.addInitScript(() => { Object.defineProperty(Notification, 'permission', { get: () => window.__perm || 'default' }); Notification.requestPermission = async () => (window.__perm = 'granted'); });
    await page.goto(URL);
    await page.waitForFunction(() => course && course.info);
    check('Runners already set up are offered notifications once', await page.locator('#pushBanner').isVisible());
    await page.click('#pushYes');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('profile')).pushSig, null, { timeout: 5000 }).catch(() => {});
    const sp = page.calls.filter(c => c.fn === 'save_push').pop();
    check('Turning on notifications saves the phone\'s push address with its race', !!sp && sp.body.p_endpoint === 'https://push.example.com/send/abc123' &&
      sp.body.p_race === 'the-challenge' && sp.body.p_p256dh === 'pk', JSON.stringify(sp && sp.body));
    check('Notification offer goes away once answered', !(await page.locator('#pushBanner').isVisible()));
    await page.evaluate(() => openSheet()); await page.waitForTimeout(300);
    check('Menu says notifications are on', (await text(page, '#pushText')).includes('Notifications are on') && !(await page.locator('#pushBtn').isVisible()),
      `${await text(page, '#pushText')} | button visible: ${await page.locator('#pushBtn').isVisible()}`);
    const cfg = await page.evaluate(async () => (await (await caches.open('rc-config')).match('config')).json());
    check('The offline worker is given what it needs to collect messages', cfg.url.includes('supabase.co') && cfg.race === 'the-challenge');
    const n = page.calls.length;
    await page.evaluate(() => push.refresh());
    check('The push address is not re-sent when nothing changed', page.calls.filter((c, i) => i >= n && c.fn === 'save_push').length === 0);
    await ctx.close();
  }

  // ------------------------------------------------------------------
  // First-time setup: name, race, map, location
  {
    const { ctx, page, errors } = await newPage({ fresh: true, permissions: ['geolocation'], geolocation: { ...EDDY, accuracy: 8 } });
    // Like a new phone: notifications not asked yet (test browsers block them by default).
    await ctx.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }));
    await page.goto(URL);
    check('Fresh install opens setup', await page.locator('#setup').isVisible() && (await text(page, '#setupStep')).includes('Step 1'));
    await page.click('#setupBody [data-go]');
    check('Name is required', await page.locator('#suNext').isDisabled());
    await page.fill('#suName', 'Tendai Moyo');
    await page.fill('#suBib', '142');
    const detailsText = await text(page, '#setupBody');
    check('Details screen says what goes to the organisers, and that location never does', detailsText.includes('sent to the race organisers') &&
      detailsText.includes('Your location is never shared') && !(await page.locator('#setupBody input[type="checkbox"]').count()));
    await page.click('#suNext');
    await page.waitForSelector('.racecard');
    const ready0 = await text(page, '#raceCards');
    await shot(page, '8-setup-race');
    check('Race list shows The Challenge', (await text(page, '#raceCards')).includes('The Challenge') && (await text(page, '#raceCards')).includes('28.6 km'), await text(page, '#raceCards'));
    check('Race list offers the six races plus Harare Prep', await page.locator('.racecard').count() === 7 && ['The Mutarazi Traverse', 'The Ultra', 'Back2Back', 'The Epic', 'The GOAT', 'Harare Prep'].every(n => ready0.includes(n)), ready0);
    check('Harare Prep is marked as a practice run', (await text(page, '.racecard[data-id="harare-prep"]')).includes('Practice run · Harare'));
    check('Back2Back card lists both days', ready0.includes('2 days') && ready0.includes('Day 1: The Mutarazi Traverse: 29.6 km') && ready0.includes('Day 2: The Challenge: 28.6 km'));
    check('Cannot continue before choosing a race', await page.locator('#suConfirm').isDisabled());
    await page.click('.racecard[data-id="the-challenge"]');
    check('Confirm button names the chosen race', (await text(page, '#suConfirm')).includes('I am running The Challenge'));
    await page.click('#suConfirm');
    await page.click('#suSkip');
    await page.click('#suGpsBtn');
    await page.waitForFunction(() => document.getElementById('suGps').textContent.includes('Location found'));
    await page.click('#suNext');
    const alertsStep = await text(page, '#setupBody');
    check('Setup offers notifications for race control messages', alertsStep.includes('Messages from race control') &&
      await page.locator('#suPushBtn').isVisible() && (await text(page, '#suNext')) === 'Not now', alertsStep);
    await page.click('#suNext');
    const ready = await text(page, '#setupBody');
    check('Ready screen says notifications are off', ready.includes('Notifications off'));
    check('Ready screen summarises name, bib, race, map and location',
      ready.includes('Tendai Moyo, bib 142') && ready.includes('Race: The Challenge') && ready.includes('Map NOT saved') && ready.includes('Location working'));
    await shot(page, '9-setup-ready');
    await page.click('#suDone');
    await page.waitForFunction(() => course && course.info && course.info.id === 'the-challenge');
    check('After setup: only the chosen route is shown, with its name at the top',
      !(await page.locator('#setup').isVisible()) && (await text(page, '#raceChip')) === 'The Challenge · 28.6 km');
    check('Route has direction arrows and km markers', await page.evaluate(() => {
      const els = [...document.querySelectorAll('.lbl')];
      return els.filter(e => e.classList.contains('arrow')).length > 20 && els.filter(e => e.classList.contains('km')).length === 28;
    }));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('profile')));
    check('Details saved on the phone', saved.name === 'Tendai Moyo' && saved.bib === '142' && saved.raceId === 'the-challenge');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('profile')).syncedSig, null, { timeout: 8000 }).catch(() => {});
    const reg = page.calls.filter(c => c.fn === 'register_runner').pop();
    check('Race control gets name, bib, race and readiness (no position)', !!reg && reg.body.p_name === 'Tendai Moyo' && reg.body.p_bib === '142' &&
      reg.body.p_race === 'the-challenge' && reg.body.p_setup === true && reg.body.p_map === false && reg.body.p_location === true &&
      /^v\d+$/.test(reg.body.p_app) && !JSON.stringify(reg.body).match(/lat|lon|-18\./), JSON.stringify(reg && reg.body));
    await page.reload();
    await page.waitForFunction(() => course && course.info);
    check('After restart: no setup, same race', !(await page.locator('#setup').isVisible()) && (await text(page, '#raceChip')).startsWith('The Challenge'));
    await page.click('#menuBtn'); await page.waitForTimeout(300);
    await page.click('#editDetailsBtn');
    await page.fill('#suBib', '143');
    await page.click('#suNext');
    await page.click('#menuBtn'); await page.waitForTimeout(300);
    check('Edit details from the menu', (await text(page, '#raceText')).includes('143'), await text(page, '#raceText'));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('profile')).syncedSig.includes('"143"'), null, { timeout: 5000 }).catch(() => {});
    check('A changed bib is sent to race control', page.calls.filter(c => c.fn === 'register_runner').pop().body.p_bib === '143');
    const before = page.calls.length;
    await page.evaluate(() => sync.send());
    check('Nothing is re-sent when nothing changed', page.calls.length === before);
    await page.click('#changeRaceBtn');
    await page.waitForSelector('.racecard');
    check('Change race opens the race list', (await text(page, '#setupBody')).includes('Choose your race'));
    await pickRace(page, 'the-challenge');
    await page.waitForFunction(() => !document.getElementById('setup').classList.contains('open') && !document.querySelector('#raceChip .spin'));
    check('Change race confirms and returns to the map', (await text(page, '#raceChip')).startsWith('The Challenge'));
    // Switch to the Ultra: its checkpoints show, and the next one is named.
    await page.click('#menuBtn'); await page.waitForTimeout(300);
    await page.click('#changeRaceBtn');
    await page.waitForSelector('.racecard');
    await pickRace(page, 'the-ultra');
    await page.waitForFunction(() => course && course.info && course.info.id === 'the-ultra');
    check('Switched to The Ultra', (await text(page, '#raceChip')) === 'The Ultra · 52.5 km', await text(page, '#raceChip'));
    check('Ultra checkpoints on the map (water and stations)', await page.evaluate(() =>
      document.querySelectorAll('.lbl.cp-water').length >= 17 && document.querySelectorAll('.lbl.cp-station').length === 2));
    const start = await page.evaluate(() => course.pts[5]);
    await fakeFix(page, { latitude: start[0], longitude: start[1] });
    check('Next checkpoint is named with its symbol', (await text(page, '#courseNext')).startsWith('Next: 💧 Water'), await text(page, '#courseNext'));
    await page.evaluate(() => fitArea(L.latLngBounds(course.pts.map(p => [p[0], p[1]]))));
    await page.waitForTimeout(1200);
    await shot(page, '10-ultra');
    // Back2Back: two days, drawn separately (no line joining them), and the panel says which day.
    await page.click('#menuBtn'); await page.waitForTimeout(300);
    await page.click('#changeRaceBtn');
    await page.waitForSelector('.racecard');
    await pickRace(page, 'back2back');
    await page.waitForFunction(() => course && course.info && course.info.id === 'back2back');
    const b2b = await page.evaluate(() => ({
      stages: course.stages.length,
      lines: courseLayer.getLayers().filter(l => l instanceof L.Polyline).length,
      labels: [...document.querySelectorAll('.lbl.wpt')].map(e => e.textContent).filter(t => /START|FINISH/.test(t)),
    }));
    check('Back2Back: two days drawn as separate lines', b2b.stages === 2 && b2b.lines === 4, JSON.stringify(b2b));
    check('Back2Back: day labels (Day 1 loop, Day 2 start and finish)',
      b2b.labels.includes('Day 1 START / FINISH') && b2b.labels.includes('Day 2 START') && b2b.labels.includes('Day 2 FINISH'), b2b.labels.join(', '));
    const d2 = await page.evaluate(() => course.stages[1].pts[100]);
    await fakeFix(page, { latitude: d2[0], longitude: d2[1] });
    check('Back2Back: on Day 2 the panel says so', (await text(page, '#courseDone')).startsWith('Day 2:') && (await text(page, '#courseStatus')).includes('On your route'), await text(page, '#courseDone'));
    const d1 = await page.evaluate(() => course.stages[0].pts[300]);
    await fakeFix(page, { latitude: d1[0], longitude: d1[1] });
    check('Back2Back: on Day 1 the panel says so', (await text(page, '#courseDone')).startsWith('Day 1:'), await text(page, '#courseDone'));
    await page.evaluate(() => fitArea(L.latLngBounds(course.pts.map(p => [p[0], p[1]]))));
    await page.waitForTimeout(1200);
    await shot(page, '11-back2back');
    // The GOAT uses some stretches twice (around km 52 and km 89): the app must report the pass the runner is on,
    // and remember it after a restart.
    await page.click('#menuBtn'); await page.waitForTimeout(300);
    await page.click('#changeRaceBtn');
    await page.waitForSelector('.racecard');
    await pickRace(page, 'the-goat');
    await page.waitForFunction(() => course && course.info && course.info.id === 'the-goat' && !document.querySelector('#raceChip .spin'));
    check('Switched to The GOAT', (await text(page, '#raceChip')) === 'The GOAT · 114.9 km', await text(page, '#raceChip'));
    const spot = await page.evaluate(() => { const st = course.stages[0]; const i = st.cum.findIndex(c => c > 52500); return st.pts[i]; });
    const doneKm = async () => parseFloat((await text(page, '#courseDone')).replace(/[^\d.]/g, ''));
    await page.evaluate(() => { lastAlong = { s: 0, along: 50000 }; });
    await fakeFix(page, { latitude: spot[0], longitude: spot[1] });
    const first = await doneKm();
    await page.evaluate(() => { lastAlong = { s: 0, along: 87500 }; });
    await fakeFix(page, { latitude: spot[0], longitude: spot[1] });
    const second = await doneKm();
    check('GOAT repeated stretch: first pass reads ~52 km, second pass ~89 km', first > 51 && first < 55 && second > 87 && second < 92, `${first} / ${second}`);
    await page.reload();
    await page.waitForFunction(() => course && course.info && course.info.id === 'the-goat');
    await fakeFix(page, { latitude: spot[0], longitude: spot[1] });
    check('GOAT: progress remembered after a restart (still the second pass)', (await doneKm()) > 87, await text(page, '#courseDone'));
    // While GPS is still searching, a spinner and a running count show it is working.
    await page.evaluate(() => { gps.fix = null; gps.state = 'searching'; gps.searchSince = Date.now() - 7000; renderGps(); });
    check('Searching for GPS shows a spinner and seconds', await page.locator('#gpsBadges .spin').count() === 1 && (await text(page, '#gpsBadges')).includes('7 s'), await text(page, '#gpsBadges'));
    check('Setup: no console errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  const { ctx, page, errors } = await newPage({ permissions: ['geolocation'], geolocation: { ...EDDY, accuracy: 8 } });
  await page.goto(URL);
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready);

  // ------------------------------------------------------------------
  // GPS states
  await page.click('#locateBtn');
  await page.waitForFunction(() => document.getElementById('gpsBadges').textContent.includes('GPS live'));
  check('Current GPS: live badge, raw coordinates shown', (await text(page, '#gpsCoords')).includes('-18.395000, 32.835000'), `${await text(page, '#gpsBadges')} | ${await text(page, '#gpsCoords')}`);
  check('Map follows and is inside race map', await page.evaluate(() => gps.follow && raceBounds.contains(map.getCenter())));
  await shot(page, '1-live');

  await ctx.setGeolocation({ ...EDDY, accuracy: 120 });
  await page.waitForFunction(() => document.getElementById('gpsBadges').textContent.includes('Poor accuracy'));
  const tag = await page.evaluate(() => meMarker.getElement().querySelector('.me-tag').textContent);
  check('Poor accuracy: warning badge + text tag on marker', tag.includes('±120'), `${await text(page, '#gpsBadges')} | tag "${tag}"`);
  await shot(page, '2-poor');

  await page.evaluate(() => { CONFIG.currentMaxAgeSec = 1; CONFIG.delayedMaxAgeSec = 2; });
  await page.waitForFunction(() => document.getElementById('gpsBadges').textContent.includes('OLD POSITION'), null, { timeout: 8000 }).catch(() => {});
  const cls = await page.evaluate(() => meMarker.getElement().firstChild.className);
  check('Stale reading: "OLD POSITION" badge, grey marker with OLD tag', (await text(page, '#gpsBadges')).includes('OLD POSITION') && cls.includes('stale'), `${await text(page, '#gpsBadges')} | ${cls}`);
  await shot(page, '3-stale');
  await page.evaluate(() => { CONFIG.currentMaxAgeSec = 10; CONFIG.delayedMaxAgeSec = 30; });

  await fakeFix(page, { latitude: EDDY.latitude, longitude: EDDY.longitude, heading: 90, speed: 3 });
  const hd = await text(page, '#stHeading');
  const hasArrow = await page.evaluate(() => meMarker.getElement().firstChild.classList.contains('has-heading'));
  check('Heading while moving: 90° E and arrow shown', hd.includes('90° E') && hasArrow, `${hd} arrow=${hasArrow}`);
  await fakeFix(page, { latitude: EDDY.latitude, longitude: EDDY.longitude, heading: null, speed: 0 });
  const noArrow = await page.evaluate(() => !meMarker.getElement().firstChild.classList.contains('has-heading'));
  check('Missing heading: "n/a" and no arrow', (await text(page, '#stHeading')) === 'n/a' && noArrow);

  await ctx.setGeolocation({ ...HARARE, accuracy: 10 });
  await page.waitForFunction(() => document.getElementById('gpsBadges').textContent.includes('Outside map'));
  const pos = await page.evaluate(() => meMarker.getLatLng());
  check('Outside map: badge shown, marker NOT moved onto the map', Math.abs(pos.lat - HARARE.latitude) < 1e-6 && Math.abs(pos.lng - HARARE.longitude) < 1e-6, await text(page, '#gpsBadges'));
  await page.click('#locateBtn');
  check('Centre-on-me refuses when far away', (await text(page, '#toast')).includes('km from the map area'), await text(page, '#toast'));
  await ctx.setGeolocation({ ...EDDY, accuracy: 8 });
  await page.waitForFunction(() => document.getElementById('gpsBadges').textContent.includes('GPS live'));

  await page.click('#detailsBtn');
  const det = await text(page, '#gpsDetails');
  check('Details: permission, reading time, age, speed, accuracy', ['Permission', 'Reading time', 'Reading age', 'Speed', 'Accuracy'].every(k => det.includes(k)));
  await page.click('#detailsBtn');

  // Map buttons
  const z0 = await page.evaluate(() => map.getZoom());
  await page.click('#zoomOutBtn'); await page.waitForTimeout(400);
  check('Zoom out button', (await page.evaluate(() => map.getZoom())) === z0 - 1);
  await page.click('#fitBtn'); await page.waitForTimeout(400);
  check('Fit-map button shows the whole race map', await page.evaluate(() => map.getBounds().pad(0.05).contains(raceBounds) && !gps.follow));

  // ------------------------------------------------------------------
  // Recording, with a GPS glitch and a poor reading mixed in
  await page.click('#recBtn');
  await page.waitForFunction(() => recorder.status === 'recording' && recorder.track && recorder.track.id);
  const t0 = Date.now() + 1000;
  for (let i = 0; i < 10; i++) {
    await fakeFix(page, { latitude: EDDY.latitude + i * 0.00027, longitude: EDDY.longitude, t: t0 + i * 10000, speed: 3, heading: 0 });
    if (i === 4) await fakeFix(page, { latitude: EDDY.latitude + 0.05, longitude: EDDY.longitude, t: t0 + i * 10000 + 1000 }); // 5 km jump in 1 s
    if (i === 6) await fakeFix(page, { latitude: EDDY.latitude + i * 0.00027 + 0.0001, longitude: EDDY.longitude, accuracy: 200, t: t0 + i * 10000 + 2000 });
  }
  const rec1 = await page.evaluate(async () => { await recorder.chain; return { pts: recorder.track.points, d: recorder.track.distanceM, jump: recorder.skippedJump, poor: recorder.skippedPoor }; });
  check('Recording keeps 10 good points, ~270 m', rec1.pts === 10 && Math.abs(rec1.d - 269) < 10, JSON.stringify(rec1));
  check('Glitch and poor reading filtered out', rec1.jump === 1 && rec1.poor === 1);
  check('Breadcrumb line drawn', await page.evaluate(() => map.hasLayer(crumbLayer) && crumbLayer.getLatLngs().flat().length === 10));
  await shot(page, '4-recording');

  // Simulate the app being closed mid-run
  await page.reload();
  await page.waitForFunction(() => recorder.status === 'paused', null, { timeout: 10000 }).catch(() => {});
  const banner = await page.locator('#resumeBanner').isVisible();
  check('After restart: recording recovered (paused, 10 points, banner shown)',
    banner && (await page.evaluate(() => recorder.status === 'paused' && recorder.track.points === 10)), await text(page, '#resumeText').catch(() => ''));
  await shot(page, '5-recovered');
  await page.click('#resumeBtn');
  const t1 = Date.now() + 200000;
  for (let i = 0; i < 2; i++) await fakeFix(page, { latitude: EDDY.latitude + 0.003 + i * 0.0003, longitude: EDDY.longitude, t: t1 + i * 10000 });
  await page.click('#stopBtn');
  await page.waitForFunction(() => recorder.status === 'idle');

  const exp = await page.evaluate(async () => {
    const t = (await getTracks()).find(x => x.status === 'done'), pts = await getPoints(t.id);
    const gpx = buildGpx(t, pts), gj = buildGeoJson(t, pts);
    const doc = new DOMParser().parseFromString(gpx, 'application/xml');
    return {
      valid: !doc.querySelector('parsererror'), trkpt: doc.getElementsByTagName('trkpt').length, segs: doc.getElementsByTagName('trkseg').length,
      ele: doc.getElementsByTagName('ele').length, acc: gpx.includes('<tm:accuracy>'), time: doc.getElementsByTagName('time').length,
      first: gj.features[0].geometry.coordinates[0][0], parts: gj.features[0].geometry.coordinates.length,
    };
  });
  check('GPX export: valid, 12 points, 2 segments (paused gap), heights, times, accuracy', exp.valid && exp.trkpt === 12 && exp.segs === 2 && exp.ele === 12 && exp.acc && exp.time === 13, JSON.stringify(exp));
  check('GeoJSON export: [longitude, latitude, altitude] order', Math.abs(exp.first[0] - 32.835) < 1e-6 && Math.abs(exp.first[1] - -18.395) < 1e-6 && exp.parts === 2, JSON.stringify(exp.first));

  await page.click('#menuBtn'); await page.waitForTimeout(400);
  check('Recording listed in menu with export buttons', (await text(page, '#trackList')).includes('Export GPX'));

  // ------------------------------------------------------------------
  // Emergency and medical guide
  await page.click('#medBtn');
  await page.waitForFunction(() => document.getElementById('medContent').textContent.includes('DRSABC'));
  const med = await page.evaluate(() => ({
    tel: [...document.querySelectorAll('#medContent a[href^="tel:"]')].map(a => a.getAttribute('href')),
    nested: document.querySelectorAll('#medContent a a').length,
    sections: document.querySelectorAll('#medContent h1').length,
  }));
  check('Medical guide opens from the menu with all sections', med.sections >= 20, `${med.sections} sections`);
  check('Medical guide: call links for race medics and ACE ambulance, none broken',
    med.tel.includes('tel:+263780661516') && med.tel.includes('tel:+263782999901') && med.nested === 0, `${med.tel.length} call links`);
  await page.click('#medContent a[href="#med-heatstroke"]');
  await page.waitForTimeout(300);
  const jumped = await page.evaluate(() => { const r = document.getElementById('med-heatstroke').getBoundingClientRect(); return r.top >= 0 && r.top < 300; });
  check('Medical guide: quick-reference button jumps to the right section', jumped);
  await shot(page, '7-medical');
  await page.click('#medClose');

  // ------------------------------------------------------------------
  // Start-up screen and messages from race control
  check('Start-up screen is gone once the app is running', await page.locator('#boot').count() === 0);
  page.messages = [
    { id: 7, created_at: '2026-11-20T15:00:00Z', race_id: null, body: 'Race briefing moved to 17:00.' },
    { id: 8, created_at: '2026-11-20T16:00:00Z', race_id: 'the-challenge', body: 'Challenge start moved to 06:30.' },
  ];
  await page.evaluate(() => inbox.check(true));
  await page.waitForSelector('#msgPop.open', { timeout: 5000 }).catch(() => {});
  const pop = await text(page, '#msgPop');
  check('New messages from race control pop up', pop.includes('Race briefing moved to 17:00.') && pop.includes('Challenge start moved to 06:30.') &&
    pop.includes('All runners') && pop.includes('Your race'), pop);
  await shot(page, '10-message');
  await page.click('#msgPopOk');
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('msgReadUnsent')).length, null, { timeout: 5000 }).catch(() => {});
  const mr = page.calls.filter(c => c.fn === 'mark_read').pop();
  check('Read messages are reported back to race control', !!mr && mr.body.p_ids.join() === '7,8', JSON.stringify(mr && mr.body));
  await page.evaluate(() => inbox.check(true)); await page.waitForTimeout(300);
  check('A message pops up only once', !(await page.locator('#msgPop').evaluate(e => e.classList.contains('open'))));
  check('Messages stay in the menu to read offline', (await page.locator('#msgList').textContent()).includes('Race briefing moved to 17:00.'));
  const gm = page.calls.filter(c => c.fn === 'get_messages').pop();
  check('Messages are asked for by the runner\'s race', gm.body.p_race === await page.evaluate(() => profile.raceId), JSON.stringify(gm.body));

  // ------------------------------------------------------------------
  // The runner's route
  const onRoute = await page.evaluate(() => course.pts[150]);
  await fakeFix(page, { latitude: onRoute[0], longitude: onRoute[1] });
  const done = await text(page, '#courseDone');
  check('Route: on your route, distance done and to go', (await text(page, '#courseStatus')).includes('On your route') && /\d/.test(done) && (await text(page, '#courseLeft')).includes('to go'),
    `${done} | ${await text(page, '#courseLeft')}`);
  await fakeFix(page, { latitude: onRoute[0] + 0.01, longitude: onRoute[1] });
  check('Route: off-route warning with direction', (await text(page, '#courseStatus')).includes('off your route') && (await text(page, '#courseDir')).includes('of you'),
    `${await text(page, '#courseStatus')} | ${await text(page, '#courseDir')}`);
  await fakeFix(page, { latitude: onRoute[0] + 0.2, longitude: onRoute[1] });
  check('Far from the route the distance is in km', /⚠ \d+ km off your route/.test(await text(page, '#courseStatus')), await text(page, '#courseStatus'));
  await fakeFix(page, { latitude: EDDY.latitude, longitude: EDDY.longitude });

  // ------------------------------------------------------------------
  // Offline download, then full reload with the internet off
  await ctx.setGeolocation({ ...EDDY, accuracy: 8 });
  // A phone that still holds pieces of the removed contour map has them cleared at startup.
  const cleared = await page.evaluate(async () => {
    const c = await caches.open(TILE_CACHE);
    await c.put('tiles/16/2/2.webp', new Response('old contour'));
    localStorage.removeItem('tilesCleaned');
    await removeOldTiles();
    return !(await c.match('tiles/16/2/2.webp'));
  });
  check('Old contour map pieces removed from the phone', cleared);
  const sets = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map(e => (e.name.match(/\/(tiles[\w-]*)\//) || [])[1]).filter(Boolean))]);
  check('Only the 2026 race map is loaded', sets.length === 1 && sets[0] === 'tiles-turaco26', sets.join(', '));
  // Pretend this phone still has a piece of an older race map saved.
  await page.evaluate(async () => (await caches.open(TILE_CACHE)).put('tiles-turaco/16/1/1.webp', new Response('old')));
  await page.evaluate(() => openSheet()); await page.waitForTimeout(300);
  await page.click('#dlBtn');
  await page.waitForFunction(() => /saved on this phone|missing|failed/.test(document.getElementById('dlText').textContent), null, { timeout: 180000 });
  check('Map download verified', (await text(page, '#dlText')).includes('saved on this phone'), await text(page, '#dlText'));
  check('Old race map pieces removed after download', await page.evaluate(async () => !(await (await caches.open(TILE_CACHE)).match('tiles-turaco/16/1/1.webp'))));
  check('Race map is the 2026 version', await page.evaluate(() => raceLayer._url.includes('turaco26') && raceBounds.contains([-18.50, 32.72])));
  await page.click('#closeSheet'); await page.waitForTimeout(300);

  await ctx.setOffline(true);
  await page.reload();
  await page.waitForTimeout(2500);
  await page.evaluate(() => { map.setView([-18.395, 32.835], 16); });
  await page.waitForTimeout(1500);
  const tiles = await page.evaluate(() => [...document.querySelectorAll('.leaflet-tile')].map(i => ({ ok: i.complete && i.naturalWidth > 0, race: i.src.includes('turaco') })));
  check('Offline: race map pieces load', tiles.filter(t => t.race && t.ok).length > 4 && !tiles.some(t => t.race && !t.ok), `${tiles.filter(t => t.race && t.ok).length} race pieces`);
  await page.evaluate(() => { map.setView([-18.45, 32.75], 15); });
  await page.waitForTimeout(1500);
  const broken = await page.evaluate(() => [...document.querySelectorAll('.leaflet-tile')].filter(i => i.complete && i.naturalWidth === 0).length);
  check('Offline: map pieces load in the south-west of the 2026 map', broken === 0, `${broken} missing`);
  check('Offline: recordings still there', await page.evaluate(async () => (await getTracks()).length === 1));
  await page.waitForFunction(() => course && course.info, null, { timeout: 8000 }).catch(() => {});
  check('Offline: your race route still shown', await page.evaluate(() => !!(course && course.info && course.info.id === 'the-challenge' && map.hasLayer(courseLayer))));
  await page.evaluate(() => openMedical());
  await page.waitForFunction(() => document.getElementById('medContent').textContent.includes('DRSABC'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const medOff = await page.evaluate(() => ({ ok: document.getElementById('medContent').textContent.includes('Snakebite'),
    imgs: [...document.querySelectorAll('#medContent img')].map(i => i.complete && i.naturalWidth > 0) }));
  check('Offline: medical guide opens with all diagrams', medOff.ok && medOff.imgs.length === 7 && medOff.imgs.every(Boolean), JSON.stringify(medOff));
  await page.click('#medClose');
  await page.evaluate(() => { map.setView([-18.395, 32.835], 15); });
  await page.waitForTimeout(800);
  await shot(page, '6-offline');
  await ctx.setOffline(false);

  // ------------------------------------------------------------------
  // Harare Prep: its own map, downloaded alongside the Nyanga map (both kept)
  await page.evaluate(() => openSheet()); await page.waitForTimeout(300);
  await page.click('#changeRaceBtn');
  await page.waitForSelector('.racecard');
  await page.click('.racecard[data-id="harare-prep"]');
  await page.click('#suConfirm');
  await page.waitForSelector('#suDl');
  check('Changing to Harare Prep asks to save the Harare map', (await text(page, '#setupBody')).includes('Harare practice map'));
  await page.click('#suDl');
  await page.waitForFunction(() => document.getElementById('suNext') && !document.getElementById('suNext').hidden, null, { timeout: 180000 });
  await page.click('#suNext');
  await page.waitForFunction(() => course && course.info && course.info.id === 'harare-prep' && !document.querySelector('#raceChip .spin'));
  check('Harare Prep shown on the Harare map', (await text(page, '#raceChip')) === 'Harare Prep · 10.8 km' &&
    await page.evaluate(() => activeMap === 'harare' && raceLayer._url.includes('tiles-harare')), await text(page, '#raceChip'));
  const both = await page.evaluate(async () => {
    const c = await caches.open(TILE_CACHE), keys = (await c.keys()).map(r => r.url);
    return { nyanga: mapSaved('nyanga'), harare: mapSaved('harare'),
      nyangaPieces: keys.filter(k => k.includes('/tiles-turaco26/')).length, hararePieces: keys.filter(k => k.includes('/tiles-harare/')).length };
  });
  check('Both maps saved: downloading Harare kept every Nyanga piece', both.nyanga && both.harare && both.nyangaPieces === 4481 && both.hararePieces === 6623, JSON.stringify(both));
  const hp = await page.evaluate(() => course.pts[3]);
  await fakeFix(page, { latitude: hp[0], longitude: hp[1] });
  check('Harare Prep: on your route, next practice checkpoint named', (await text(page, '#courseStatus')).includes('On your route') && (await text(page, '#courseNext')).includes('Practice water 1'),
    `${await text(page, '#courseStatus')} | ${await text(page, '#courseNext')}`);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => course && course.info && course.info.id === 'harare-prep', null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { map.setView([-17.805, 31.105], 16); });
  await page.waitForTimeout(1500);
  const ht = await page.evaluate(() => [...document.querySelectorAll('.leaflet-tile')].map(i => ({ ok: i.complete && i.naturalWidth > 0, h: i.src.includes('tiles-harare') })));
  check('Offline: Harare map loads (most detailed zoom)', ht.filter(x => x.h && x.ok).length > 4 && !ht.some(x => x.h && !x.ok), `${ht.filter(x => x.h && x.ok).length} pieces`);
  await page.evaluate(() => { map.setView([-17.62, 30.90], 15); });
  await page.waitForTimeout(1500);
  const outer = await page.evaluate(() => [...document.querySelectorAll('.leaflet-tile')].filter(i => i.complete && i.naturalWidth === 0).length);
  check('Offline: outer Harare (beyond 15 km) loads too', outer === 0, `${outer} missing`);
  await page.evaluate(() => fitArea(L.latLngBounds(course.pts.map(p => [p[0], p[1]]))));
  await page.waitForTimeout(1500);
  await shot(page, '12-harare-prep');
  await ctx.setOffline(false);

  await page.evaluate(() => openSheet()); await page.waitForTimeout(300);
  await page.click('#dlDelete');
  await page.waitForFunction(() => document.getElementById('offlineChip').textContent.includes('not saved'));
  check('Delete offline map', true);

  check('No console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (err) {
  check('Test run crashed', false, err.stack);
} finally {
  await browser.close(); server.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
