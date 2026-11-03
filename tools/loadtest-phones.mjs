// Real-browser load test: many headless "phones" open the LIVE app at the
// same moment, each as a runner already set up, and must load, show their
// route and sign in to race control. Each pretend runner ("Load test phone
// NN") is removed from race control at the end. Uses roughly 3-4 MB a phone.
// Usage: node tools/loadtest-phones.mjs [phones=20] [url=https://skyrunzim.github.io/]
import { chromium } from 'playwright';

const PHONES = +process.argv[2] || 20, URL = process.argv[3] || 'https://skyrunzim.github.io/';
const RC = 'https://rmyqovbgcqgcvxwbpwgv.supabase.co', KEY = 'sb_publishable_8BAttBsLnJh--ADME9dMFA_0QHOg4qu';
const RACES = ['the-challenge', 'mutarazi-traverse', 'the-ultra', 'back2back', 'the-epic', 'the-goat'];
const browser = await chromium.launch();
const rpc = (fn, body) => fetch(`${RC}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function phone(n) {
  const race = RACES[n % RACES.length], t0 = performance.now(), out = { n, race, errors: [] };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true,
    permissions: ['geolocation'], geolocation: { latitude: -18.395, longitude: 32.835, accuracy: 8 } });
  await ctx.addInitScript(p => { if (!localStorage.getItem('profile')) localStorage.setItem('profile', p); },
    JSON.stringify({ setupDone: true, raceId: race, name: `Load test phone ${String(n).padStart(2, '0')}`, bib: String(8000 + n) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => out.errors.push(e.message));
  try {
    await page.goto(URL, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 60000 });
    out.appReady = Math.round(performance.now() - t0);
    await page.waitForFunction(id => typeof course !== "undefined" && course && course.info && course.info.id === id, race, { timeout: 60000 });
    out.routeShown = Math.round(performance.now() - t0);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('profile')).syncedSig, null, { timeout: 60000 });
    out.signedIn = Math.round(performance.now() - t0);
    out.deviceId = await page.evaluate(() => JSON.parse(localStorage.getItem('profile')).deviceId);
    out.chip = await page.locator('#raceChip').innerText();
  } catch (err) { out.failed = err.message.split('\n')[0]; out.deviceId ||= await page.evaluate(() => JSON.parse(localStorage.getItem('profile') || '{}').deviceId).catch(() => null); }
  await ctx.close();
  return out;
}

console.log(`${PHONES} phones open ${URL} at the same moment…`);
const t0 = performance.now();
const results = await Promise.all(Array.from({ length: PHONES }, (_, i) => phone(i + 1)));
const secs = ((performance.now() - t0) / 1000).toFixed(1);
await browser.close();

const ok = results.filter(r => r.signedIn && !r.errors.length), times = k => results.filter(r => r[k]).map(r => r[k]).sort((a, b) => a - b);
const span = k => { const t = times(k); return t.length ? `typical ${(t[t.length >> 1] / 1000).toFixed(1)} s, slowest ${(t[t.length - 1] / 1000).toFixed(1)} s` : 'none'; };
console.log(`\nAll done in ${secs} s. Signed in with no errors: ${ok.length} of ${PHONES}`);
console.log(`  app on screen:          ${span('appReady')}`);
console.log(`  their route shown:      ${span('routeShown')}`);
console.log(`  signed in to race control: ${span('signedIn')}`);
results.filter(r => r.failed || r.errors.length).forEach(r => console.log(`  phone ${r.n}: ${r.failed || ''} ${r.errors.join(' | ')}`));

// Tidy up: remove every pretend runner from race control.
const ids = results.map(r => r.deviceId).filter(Boolean);
const removed = await Promise.all(ids.map(id => rpc('forget_runner', { p_device: id }).then(r => r.ok).catch(() => false)));
console.log(`\nRemoved ${removed.filter(Boolean).length} of ${ids.length} pretend runners from race control.`);
