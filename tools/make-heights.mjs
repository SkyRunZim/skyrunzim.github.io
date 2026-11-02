// Cuts the Nyanga race-map area out of the Copernicus 30 m elevation data, at
// full detail, for the dashboard: route updates from GPX files without heights
// get the same heights tools/build-races.mjs would give them.
// Output: dashboard/nyanga-heights.bin (heights in metres, Float32 as in the source, row by
// row from the north-west) and dashboard/nyanga-heights.json (its grid).
// Only the dashboard loads it; runners' phones never do.
// Usage: node tools/make-heights.mjs
import { writeFileSync } from 'node:fs';
import { fromFile } from 'geotiff';

const BBOX = { west: 32.69659612566003, east: 32.992700072259964, south: -18.523914235060392, north: -18.215629827297686 }; // MAPS.nyanga in app.js
const img = await (await fromFile('tools/data/S19_00_E032_00.tif')).getImage();
const [w, s, e, n] = img.getBoundingBox(), W = img.getWidth(), H = img.getHeight();
if (BBOX.west < w || BBOX.east > e || BBOX.south < s || BBOX.north > n) throw new Error('race map is not inside this elevation tile');
const r = (await img.readRasters({ samples: [0] }))[0];

// Whole pixels covering the map, with a margin so edge lookups match the full tile.
const M = 3, px = lon => (lon - w) / (e - w) * W, py = lat => (n - lat) / (n - s) * H;
const x0 = Math.max(0, Math.floor(px(BBOX.west)) - M), x1 = Math.min(W, Math.ceil(px(BBOX.east)) + M);
const y0 = Math.max(0, Math.floor(py(BBOX.north)) - M), y1 = Math.min(H, Math.ceil(py(BBOX.south)) + M);
const cw = x1 - x0, ch = y1 - y0, out = new Float32Array(cw * ch);
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = r[(y0 + y) * W + x0 + x];

const grid = { w: w + x0 / W * (e - w), e: w + x1 / W * (e - w), n: n - y0 / H * (n - s), s: n - y1 / H * (n - s), W: cw, H: ch };
writeFileSync('dashboard/nyanga-heights.bin', Buffer.from(out.buffer));
writeFileSync('dashboard/nyanga-heights.json', JSON.stringify(grid));
console.log(`${cw} x ${ch} heights, ${(out.byteLength / 1e6).toFixed(1)} MB`);
