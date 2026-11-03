// Load test of race control (the skyrun-2026 Supabase project): many pretend
// runners doing what the app does, all at once. Every pretend runner is
// named "Load test NNN" and removed again at the end (and on Ctrl+C).
// Nothing is posted as a message, so no real phone is notified.
//
// Usage: node tools/loadtest.mjs [runners=300] [burst=1000] [steadySeconds=180]
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import https from 'node:https';

const URL = 'https://rmyqovbgcqgcvxwbpwgv.supabase.co';
const KEY = 'sb_publishable_8BAttBsLnJh--ADME9dMFA_0QHOg4qu';   // the app's public key
const [RUNNERS = 300, BURST = 1000, STEADY = 180] = process.argv.slice(2).map(Number);
const RACES = ['the-challenge', 'mutarazi-traverse', 'the-ultra', 'back2back', 'the-epic', 'the-goat'];
const LEDGER = 'loadtest-runners.json';   // every pretend runner made, so they can always be removed

const made = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
const remember = id => { made.push(id); if (made.length % 50 === 0) writeFileSync(LEDGER, JSON.stringify(made)); };

// One computer can't open hundreds of secure connections at the same instant
// the way hundreds of phones can (the office line times out), so requests
// share a pool of open connections. Everything is still sent at once; times
// include the wait for a free connection, so they are on the pessimistic side.
const pool = new https.Agent({ keepAlive: true, maxSockets: +process.env.CONNECTIONS || 48 });
function rpc(fn, body) {
  const t = performance.now(), data = JSON.stringify(body);
  return new Promise(resolve => {
    const req = https.request(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', agent: pool, timeout: 30000,
      headers: { apikey: KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      res.resume();
      res.on('end', () => resolve({ fn, ok: res.statusCode < 300, status: res.statusCode, ms: performance.now() - t }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out after 30 s')));
    req.on('error', err => resolve({ fn, ok: false, status: 'network: ' + (err.code || err.message), ms: performance.now() - t }));
    req.end(data);
  });
}

// What a phone does when its runner signs in: details, then messages, route updates, notifications.
function runner(n) {
  const id = randomUUID(), race = RACES[n % RACES.length];
  remember(id);
  return {
    id, race,
    signIn: () => Promise.all([
      rpc('register_runner', { p_device: id, p_name: `Load test ${String(n).padStart(3, '0')}`, p_bib: String(9000 + n), p_race: race,
        p_setup: true, p_map: n % 7 !== 0, p_location: n % 11 !== 0, p_app: 'v17', p_phone: n % 2 ? 'Android' : 'iPhone' }),
      rpc('get_messages', { p_race: race }),
      rpc('get_route_updates', {}),
      rpc('save_push', { p_device: id, p_endpoint: `https://loadtest.invalid/push/${id}`, p_p256dh: 'loadtest', p_auth: 'loadtest', p_race: race }),
    ]),
    check: () => Promise.all([rpc('get_messages', { p_race: race }), rpc('get_route_updates', {})]),
  };
}

function report(title, results, seconds) {
  const ms = results.map(r => r.ms).sort((a, b) => a - b), q = p => Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]);
  const bad = results.filter(r => !r.ok), why = {};
  bad.forEach(r => { why[`${r.fn} ${r.status}`] = (why[`${r.fn} ${r.status}`] || 0) + 1; });
  console.log(`\n${title}\n  ${results.length} requests in ${seconds.toFixed(1)} s (${(results.length / seconds).toFixed(0)} a second)` +
    `\n  answered OK: ${results.length - bad.length}, failed: ${bad.length}${bad.length ? ' ' + JSON.stringify(why) : ''}` +
    `\n  response time: typical ${q(0.5)} ms, 95% within ${q(0.95)} ms, slowest ${Math.round(ms[ms.length - 1])} ms`);
  return { title, requests: results.length, failed: bad.length, why, p50: q(0.5), p95: q(0.95), max: Math.round(ms[ms.length - 1]), perSecond: +(results.length / seconds).toFixed(1) };
}

async function cleanUp() {
  const ids = [...new Set(made)];
  if (!ids.length) return;
  console.log(`\nRemoving ${ids.length} pretend runners…`);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push(...(await Promise.all(ids.slice(i, i + 50).flatMap(id => [rpc('forget_runner', { p_device: id }), rpc('delete_push', { p_device: id })]))));
  }
  const failed = out.filter(r => !r.ok).length;
  console.log(failed ? `  ${failed} removals failed: run this again to finish` : '  all removed');
  if (!failed && existsSync(LEDGER)) unlinkSync(LEDGER);
  made.length = 0;
}
process.on('SIGINT', async () => { await cleanUp(); process.exit(1); });

const summary = [];
if (process.argv[2] === 'cleanup') { await cleanUp(); process.exit(0); }
await cleanUp();   // anything left from an earlier run that was interrupted
// Open the connections first (phones arrive with theirs already open).
await Promise.all(Array.from({ length: +process.env.CONNECTIONS || 48 }, () => rpc('get_route_updates', {})));

// 1. Everyone signs in at the same moment.
let t0 = performance.now();
const field = Array.from({ length: RUNNERS }, (_, i) => runner(i + 1));
summary.push(report(`1. ${RUNNERS} runners sign in at the same moment`, (await Promise.all(field.map(r => r.signIn()))).flat(), (performance.now() - t0) / 1000));
writeFileSync(LEDGER, JSON.stringify(made));

// 2. Everyone changes something (bib, map saved...) at once: the update path.
t0 = performance.now();
summary.push(report(`2. All ${RUNNERS} update their details at once`, await Promise.all(field.map((r, i) => rpc('register_runner', { p_device: r.id, p_name: `Load test ${String(i + 1).padStart(3, '0')}`,
  p_bib: String(9500 + i), p_race: r.race, p_setup: true, p_map: true, p_location: true, p_app: 'v17', p_phone: 'Android' }))), (performance.now() - t0) / 1000));

// 3. A much bigger crowd than the race will have, for headroom.
t0 = performance.now();
const crowd = Array.from({ length: BURST }, (_, i) => runner(RUNNERS + i + 1));
summary.push(report(`3. ${BURST} runners sign in at the same moment (over 3x the field)`, (await Promise.all(crowd.map(r => r.signIn()))).flat(), (performance.now() - t0) / 1000));
writeFileSync(LEDGER, JSON.stringify(made));

// 4. Race-day traffic, sped up: each of the field checks for news every 10 s
// (a real phone checks every 3 minutes, so this is 18x the real load).
t0 = performance.now();
const steady = [];
await Promise.all(field.map(async (r, i) => {
  await new Promise(res => setTimeout(res, (i / RUNNERS) * 10000));   // spread out, as real phones are
  while (performance.now() - t0 < STEADY * 1000) {
    steady.push(...(await r.check()));
    await new Promise(res => setTimeout(res, 10000));
  }
}));
summary.push(report(`4. ${STEADY / 60} minutes of race-day traffic at 18x the real rate`, steady, (performance.now() - t0) / 1000));

await cleanUp();
writeFileSync('loadtest-results.json', JSON.stringify(summary, null, 1));
