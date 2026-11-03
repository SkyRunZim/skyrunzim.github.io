// "Venue wifi" test: several phones on ONE internet connection download race
// map pieces from GitHub Pages at the same time, 6 at a time each as the app
// does. Shows whether GitHub slows down or refuses (429) a crowd on one line.
// Usage: node tools/loadtest-tiles.mjs [phones=10] [piecesEach=300]
import https from 'node:https';

const PHONES = +process.argv[2] || 10, EACH = +process.argv[3] || 300, SITE = 'https://skyrunzim.github.io/';
const index = await (await fetch(SITE + 'tiles-turaco26/index.json')).json();
const status = {};
let bytes = 0;
const times = [];

async function phone(n) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });   // each phone: its own 6 connections
  // A different stretch of the map for each phone, as if each were part-way through.
  const pieces = Array.from({ length: EACH }, (_, i) => index.tiles[(n * 977 + i * 7) % index.tiles.length]);
  let next = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const url = `${SITE}tiles-turaco26/${pieces[next++]}.webp`, t = performance.now();
      const code = await new Promise(resolve => https.get(url, { agent, timeout: 30000 }, res => {
        res.on('data', d => (bytes += d.length)); res.on('end', () => resolve(res.statusCode));
      }).on('timeout', function () { this.destroy(new Error('timeout')); }).on('error', e => resolve('network ' + (e.code || e.message))));
      status[code] = (status[code] || 0) + 1;
      times.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  agent.destroy();
}

console.log(`${PHONES} phones each download ${EACH} map pieces at the same time, from one connection…`);
const t0 = performance.now();
await Promise.all(Array.from({ length: PHONES }, (_, i) => phone(i)));
const secs = (performance.now() - t0) / 1000;
times.sort((a, b) => a - b);
const total = PHONES * EACH, mb = bytes / 1e6;
console.log(`\n${total} pieces in ${secs.toFixed(1)} s: ${(total / secs).toFixed(0)} a second, ${(mb * 8 / secs).toFixed(1)} Mbit/s, ${mb.toFixed(1)} MB in all`);
console.log('answers:', JSON.stringify(status));
console.log(`each piece: typical ${Math.round(times[times.length >> 1])} ms, 95% within ${Math.round(times[Math.floor(times.length * 0.95)])} ms`);
// What a whole map (all pieces) would take one phone at this rate, sharing the line with the others.
const perPhone = total / secs / PHONES;
console.log(`at this rate each phone would save the whole race map (${index.tiles.length} pieces) in about ${Math.ceil(index.tiles.length / perPhone / 60)} min, ${PHONES} phones sharing the line`);
