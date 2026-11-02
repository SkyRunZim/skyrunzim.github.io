// Builds the race routes the app offers at setup, from the GPX files in races/.
// races/races.json lists each race (id, name, file, version, start time, notes).
// Output: data/races/index.json (the list) and data/races/<id>.json (the route).
// The building itself is in dashboard/route-build.mjs, shared with the
// dashboard's Race settings tab; here missing heights come from the
// Copernicus 30 m elevation data in tools/data/.
// Usage: node tools/build-races.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fromFile } from 'geotiff';
import { addCheckpoints, buildRace, dropRouteExports, heightLookup, readWaypoints } from '../dashboard/route-build.mjs';

const races = JSON.parse(readFileSync('races/races.json', 'utf8'));
mkdirSync('data/races', { recursive: true });

// Elevation lookup (bilinear) from the Copernicus tiles covering Nyanga.
const dem = [];
for (const f of ['tools/data/S19_00_E032_00.tif', 'tools/data/S18_00_E032_00.tif', 'tools/data/S18_00_E031_00.tif']) {
  if (!existsSync(f)) continue;
  const img = await (await fromFile(f)).getImage();
  const [w, s, e, n] = img.getBoundingBox();
  dem.push(heightLookup({ w, s, e, n, W: img.getWidth(), H: img.getHeight() }, (await img.readRasters({ samples: [0] }))[0]));
}
const elevation = (lat, lon) => { for (const look of dem) { const h = look(lat, lon); if (h != null) return h; } return null; };

// Checkpoints from every race file, shared between races. Each file's
// waypoints are also saved for the dashboard (a few KB, not the whole files).
const allCheckpoints = [], waypoints = {};
for (const race of races) {
  waypoints[race.id] = dropRouteExports(readWaypoints(readFileSync(`races/${race.file}`, 'utf8')));
  addCheckpoints(allCheckpoints, waypoints[race.id], race.id);
}
writeFileSync('dashboard/race-waypoints.json', JSON.stringify(waypoints));

const index = [];
for (const race of races) {
  let built;
  try { built = buildRace(race, readFileSync(`races/${race.file}`, 'utf8'), allCheckpoints, elevation); }
  catch (err) { throw new Error(`${race.file}: ${err.message}`); }
  const { route, summary, stages, heightsFilled } = built;
  writeFileSync(`data/races/${race.id}.json`, JSON.stringify(route));
  index.push(summary);
  console.log(`${race.name}: ${summary.distanceKm} km, ${summary.climbM} m climb, ${stages.length} stage(s) ` +
    `[${stages.map(st => `${st.name} ${st.distanceKm} km`).join('; ')}], ${summary.checkpoints} checkpoints${heightsFilled ? ' (heights from elevation data)' : ''}`);
}
writeFileSync('data/races/index.json', JSON.stringify(index, null, 1));
