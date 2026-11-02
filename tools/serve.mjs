// Tiny local web server for testing: node tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.bin': 'application/octet-stream', '.css': 'text/css', '.json': 'application/json',
  '.geojson': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.gpx': 'application/gpx+xml' };
const port = +process.argv[2] || 8080;
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '');
  if (p.includes('..')) { res.writeHead(403); return res.end(); }
  if (!p || /[\\/]$/.test(p)) p = join(p, 'index.html');
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`http://localhost:${port}`));
export {};
