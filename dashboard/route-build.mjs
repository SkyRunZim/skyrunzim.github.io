// Turns a race's GPX file into the route the app uses. Shared by
// tools/build-races.mjs (routes that ship with the app) and the dashboard's
// Race settings tab (route updates published by race control), so both build
// routes exactly the same way.
//
// Clean-up done here so the app gets tidy data:
// - waypoints that are just copies of route points (Garmin exports these, as
//   long numbered series such as "The Epic 2025 001") are dropped; the named
//   ones left are real checkpoints (water, stations, landmarks)
// - checkpoints are shared: a race gets each checkpoint that lies within 100 m
//   of its own route, since routes share sections (a race always keeps the
//   checkpoints from its own file, even off-trail ones)
// - missing heights (or all zero, as in drawn routes) are filled by the
//   elevation lookup passed in, where there is one

export const metres = (a, b) => {
  const R = 6371000, r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : null; };

// Adds the checkpoints in one race's GPX file to the shared list. A numbered
// series with more than 20 members is an export of route points, not checkpoints.
export function addCheckpoints(all, xml, raceId) {
  const w = [...xml.matchAll(/<wpt\s[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/wpt>/g)]
    .map(m => ({ lat: +m[1], lon: +m[2], name: tag(m[3], 'name') || 'Checkpoint' }));
  const series = name => name.replace(/[-\s]\d+$/, '');
  const count = {};
  w.forEach(q => { count[series(q.name)] = (count[series(q.name)] || 0) + 1; });
  for (const q of w.filter(q => count[series(q.name)] <= 20)) {
    if (all.some(c => c.source === q.name && metres([c.lat, c.lon], [q.lat, q.lon]) < 30)) continue;
    const name = q.name.replace(/([A-Za-z])(\d+)$/, '$1 $2');
    const kind = /water/i.test(name) ? 'water' : /station|aid|checkpoint|\bcp\b/i.test(name) ? 'station' : 'point';
    all.push({ lat: +q.lat.toFixed(6), lon: +q.lon.toFixed(6), name, kind, source: q.name, race: raceId });
  }
  return all;
}

// Shortest distance from a point to a route line, in metres.
export function distanceToRoute(pts, lat, lon) {
  const k = 111320 * Math.cos(lat * Math.PI / 180), px = lon * k, py = lat * 110574;
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * k, ay = pts[i][0] * 110574, bx = pts[i + 1][1] * k, by = pts[i + 1][0] * 110574;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

// Height lookup (bilinear) from a grid of heights: the elevation tiles in
// tools/build-races.mjs, or dashboard/nyanga-heights.* (made by tools/make-heights.mjs).
export function heightLookup(grid, values) {
  const { w, s, e, n, W, H, scale = 1 } = grid;
  return (lat, lon) => {
    if (!(lon >= w && lon < e && lat > s && lat <= n)) return null;
    const fx = (lon - w) / (e - w) * W - 0.5, fy = (n - lat) / (n - s) * H - 0.5;
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const ax = fx - x0, ay = fy - y0, i = y0 * W + x0, r = values;
    return ((r[i] * (1 - ax) + r[i + 1] * ax) * (1 - ay) + (r[i + W] * (1 - ax) + r[i + W + 1] * ax) * ay) * scale;
  };
}

// race: { id, name, version, start, map, practice, stages: [{ name, short }] (multi-day only) }
// Returns the route file, its line in the race list, and notes for whoever is building it.
export function buildRace(race, xml, allCheckpoints, elevation = () => null) {
  const read = (s, el) => [...s.matchAll(new RegExp(`<${el}\\s[^>]*?lat="([-\\d.]+)"[^>]*?lon="([-\\d.]+)"[^>]*>([\\s\\S]*?)</${el}>`, 'g'))]
    .map(m => [+m[1], +m[2], tag(m[3], 'ele') !== null ? +tag(m[3], 'ele') : null]);
  // Each <trk> is one stage (a multi-day race has one per day).
  let tracks = [...xml.matchAll(/<trk>[\s\S]*?<\/trk>/g)].map(t => read(t[0], 'trkpt')).filter(p => p.length >= 2);
  if (!tracks.length) tracks = [read(xml, 'rtept')].filter(p => p.length >= 2);
  if (!tracks.length) throw new Error('No route found in this file. Is it a GPX file with a track or route in it?');
  const stageInfo = race.stages || [{ name: race.name, short: '' }];
  if (tracks.length !== stageInfo.length) {
    throw new Error(`This file has ${tracks.length} route${tracks.length === 1 ? '' : 's'} in it, but ${race.name} has ${stageInfo.length} ` +
      `(${stageInfo.length > 1 ? 'one per day' : 'one'}). Check it is the right file.`);
  }

  let heightsFilled = false, heightsMissing = false;
  const stages = tracks.map((raw, s) => {
    let pts = raw;
    if (pts.some(p => p[2] === null) || pts.every(p => p[2] === 0)) { pts = pts.map(([lat, lon]) => [lat, lon, elevation(lat, lon)]); heightsFilled = true; }
    if (pts.some(p => p[2] == null)) heightsMissing = true;
    pts = pts.map(([lat, lon, ele]) => [+lat.toFixed(6), +lon.toFixed(6), ele == null ? null : Math.round(ele)]);
    let dist = 0, climb = 0, ref = pts[0][2];
    for (let i = 1; i < pts.length; i++) {
      dist += metres(pts[i - 1], pts[i]);
      const e = pts[i][2];
      if (e != null && ref != null) { if (e - ref >= 5) { climb += e - ref; ref = e; } else if (e < ref) ref = e; }
    }
    return { name: stageInfo[s].name, short: stageInfo[s].short || '', pts, distanceKm: +(dist / 1000).toFixed(1), climbM: Math.round(climb) };
  });

  const wpts = allCheckpoints.filter(c => c.race === race.id || stages.some(st => distanceToRoute(st.pts, c.lat, c.lon) <= 100))
    .map(({ lat, lon, name, kind }) => ({ lat, lon, name, kind }));

  const route = { id: race.id, name: race.name, version: race.version, stages: stages.map(({ name, short, pts }) => ({ name, short, pts })), wpts };
  const distanceKm = +stages.reduce((s, st) => s + st.distanceKm, 0).toFixed(1), climbM = stages.reduce((s, st) => s + st.climbM, 0);
  const summary = { id: race.id, name: race.name, version: race.version, start: race.start || '', distanceKm, climbM,
    map: race.map || 'nyanga', practice: race.practice || undefined,
    checkpoints: wpts.length, file: `data/races/${race.id}.json`,
    stages: stages.length > 1 ? stages.map(({ name, short, distanceKm, climbM }) => ({ name, short, distanceKm, climbM })) : undefined };
  return { route, summary, stages, heightsFilled, heightsMissing };
}
