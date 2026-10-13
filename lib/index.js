/**
 * dsh-desktop-clock — host half.
 *
 * Resolves the CURRENT Windows desktop wallpaper and serves its bytes over a
 * dedicated HTTP route, so the browser half can paint it as a background layer.
 * The client never touches the filesystem; it only receives bytes.
 *
 * Routes (same-origin, fenced by `ctx.connection.requestRejection`):
 *   GET /dsh-desktop-clock/wallpaper   the image itself (ETag + 304 support)
 *   GET /dsh-desktop-clock/info        JSON: which source won, mtime, size, mime
 *
 * @module
 */
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

const run = promisify(execFile);

export const name = 'dsh-desktop-clock';
export const inject = ['connection', 'webServer'];

const BASE = '/dsh-desktop-clock';
const WALLPAPER_ROUTE = `${BASE}/wallpaper`;
const INFO_ROUTE = `${BASE}/info`;
const DIAG_ROUTE = `${BASE}/diag`;

/** Where the client's diagnostics land. */
const DIAG_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.dsh-desktop-clock');

/** How long a resolved wallpaper path is trusted before the registry is read again. */
const RESOLVE_TTL_MS = 15_000;
/** Image extensions accepted when scanning a Windows theme's background folder. */
const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|webp|tiff?)$/i;

/** The one cached resolution. `at` is a monotonic-ish Date.now() stamp. */
let cache = { at: 0, value: null };

/* ------------------------------------------------------------------ *
 * Wallpaper discovery
 * ------------------------------------------------------------------ */

/** Expand `%VAR%` references the way the shell would; unknown names stay literal. */
function expandEnv(value) {
  return value.replace(/%([^%]+)%/g, (whole, key) => {
    const hit = process.env[key] ?? process.env[key.toUpperCase()];
    return hit === undefined ? whole : hit;
  });
}

/**
 * The wallpaper path as Windows itself records it. Empty (a theme slideshow, or
 * a per-monitor picture) is normal and just means "ask the next candidate".
 */
async function registryWallpaper() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(
      'reg',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
      { windowsHide: true, timeout: 5000 },
    );
    const m = /Wallpaper\s+REG_SZ\s+(.*)/.exec(stdout);
    if (m === null) return null;
    const raw = m[1].trim();
    return raw === '' ? null : expandEnv(raw);
  } catch {
    return null;
  }
}

/** Newest image inside a directory, or null when there is none / no directory. */
async function newestImageIn(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const entry of names) {
    if (!IMAGE_EXT.test(entry)) continue;
    const path = join(dir, entry);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size === 0) continue;
      if (best === null || st.mtimeMs > best.mtimeMs) best = { path, st };
    } catch {
      /* unreadable entry — skip */
    }
  }
  return best;
}

/**
 * Every place Windows keeps the active wallpaper, most authoritative first.
 *
 * `TranscodedWallpaper` is the file Explorer actually paints: it exists even
 * when the registry value is empty (theme slideshows, fit/fill transcoding), so
 * it is the reliable fallback. `CachedFiles` and the theme's own
 * `DesktopBackground` folder cover the remaining slideshow shapes.
 */
async function* wallpaperCandidates() {
  const reg = await registryWallpaper();
  if (reg !== null) yield { path: reg, source: 'registry' };

  const appdata = process.env.APPDATA;
  if (appdata === undefined || appdata === '') return;

  const themes = join(appdata, 'Microsoft', 'Windows', 'Themes');
  yield { path: join(themes, 'TranscodedWallpaper'), source: 'transcoded' };

  const cached = await newestImageIn(join(themes, 'CachedFiles'));
  if (cached !== null) yield { path: cached.path, source: 'cached-files', st: cached.st };

  // Theme slideshow: whichever theme folder holds the current rotation.
  let themeDirs = [];
  try {
    themeDirs = (await readdir(themes, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(themes, e.name));
  } catch {
    return;
  }
  for (const dir of themeDirs) {
    const found = await newestImageIn(join(dir, 'DesktopBackground'));
    if (found !== null) yield { path: found.path, source: 'theme-desktop-background', st: found.st };
  }
}

/** Identify a wallpaper container from its leading bytes (defaults to JPEG). */
function sniffMime(head) {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  if (head.length >= 12 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  if (head.length >= 4 && head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) return 'image/tiff';
  if (head.length >= 4 && head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a) return 'image/tiff';
  return 'image/jpeg';
}

/** Read just enough of a file to sniff its container. */
async function sniffFileMime(path) {
  const handle = await import('node:fs/promises').then((m) => m.open(path, 'r'));
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return sniffMime(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** The first candidate that resolves to a non-empty readable file. */
async function discover() {
  for await (const candidate of wallpaperCandidates()) {
    try {
      const st = candidate.st ?? (await stat(candidate.path));
      if (!st.isFile() || st.size === 0) continue;
      return {
        path: candidate.path,
        source: candidate.source,
        size: st.size,
        mtimeMs: st.mtimeMs,
        mime: await sniffFileMime(candidate.path),
      };
    } catch {
      /* missing / unreadable — try the next candidate */
    }
  }
  return null;
}

/** Cached discovery: the filesystem walk is not free and this runs per request. */
async function resolveWallpaper(force = false) {
  const now = Date.now();
  if (!force && cache.value !== null && now - cache.at < RESOLVE_TTL_MS) return cache.value;
  const value = await discover();
  cache = { at: now, value };
  return value;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function etagOf(found) {
  return `"${Math.round(found.mtimeMs)}-${found.size}"`;
}

async function serveWallpaper(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let found;
  try {
    found = await resolveWallpaper();
  } catch (error) {
    console.error('dsh-desktop-clock: wallpaper discovery failed', error);
    json(res, 500, { ok: false, error: 'discovery failed' });
    return;
  }
  if (found === null) {
    json(res, 404, { ok: false, error: 'no desktop wallpaper found' });
    return;
  }

  const etag = etagOf(found);
  const headers = {
    'Content-Type': found.mime,
    'Content-Length': found.size,
    ETag: etag,
    'Last-Modified': new Date(found.mtimeMs).toUTCString(),
    // Revalidate every time: the user can change their wallpaper at any moment,
    // and a 304 costs nothing compared with serving a stale image.
    'Cache-Control': 'no-cache',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(found.path);
  stream.on('error', (error) => {
    console.error('dsh-desktop-clock: wallpaper stream failed', error);
    res.destroy();
  });
  // A client that navigates away mid-transfer must not leak the file handle.
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function serveInfo(req, res) {
  const found = await resolveWallpaper(true);
  if (found === null) {
    json(res, 200, { ok: false, error: 'no desktop wallpaper found' });
    return;
  }
  json(res, 200, {
    ok: true,
    source: found.source,
    mime: found.mime,
    size: found.size,
    mtimeMs: Math.round(found.mtimeMs),
    path: found.path,
    url: WALLPAPER_ROUTE,
  });
}

/**
 * Append one diagnostic line. Both halves call this: the host records that it
 * mounted at all, and the browser records what it can see that the host cannot.
 */
async function noteDiag(stage, detail) {
  const line = `${new Date().toISOString()}\t${stage}\t${String(detail).replace(/[\r\n\t]/g, ' ')}\n`;
  try {
    await mkdir(DIAG_DIR, { recursive: true });
    await appendFile(join(DIAG_DIR, 'diag.log'), line, 'utf8');
  } catch (error) {
    console.error('dsh-desktop-clock: could not append the diagnostic line', error);
  }
}

/**
 * The client's only way to be heard. Everything interesting about this plugin
 * happens in the browser — whether the wallpaper request was even authorised,
 * which element is painting an opaque backdrop over the layers — and none of it
 * is visible from here. So the browser appends one line per event and this
 * reads it back.
 *
 * Deliberately narrow: two fixed-width fields, same-origin, no arbitrary writes.
 */
async function serveDiag(req, res) {
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const stage = (params.get('stage') ?? '?').slice(0, 40);
  const detail = (params.get('detail') ?? '').slice(0, 900);
  await noteDiag(stage, detail);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

export function apply(ctx) {
  // Proves this half mounted in the live host, not just in the test harness.
  // Without it an empty diag.log is ambiguous: host not mounted, or browser
  // unable to reach the route.
  noteDiag('host-mounted', `pid=${process.pid} routes=${WALLPAPER_ROUTE} ${INFO_ROUTE} ${DIAG_ROUTE}`);

  ctx.inject(['connection', 'webServer'], (webCtx) => {
    /** Same-origin fence; the plugin exposes local paths, so this is not optional. */
    const fence = (handler) => (req, res) => {
      const rejection = webCtx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      Promise.resolve(handler(req, res)).catch((error) => {
        console.error('dsh-desktop-clock: handler failed', error);
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* already sent */
        }
      });
    };

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: WALLPAPER_ROUTE, handler: fence(serveWallpaper) }),
      'dsh-desktop-clock: wallpaper route',
    );
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: INFO_ROUTE, handler: fence(serveInfo) }),
      'dsh-desktop-clock: info route',
    );
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: DIAG_ROUTE, handler: fence(serveDiag) }),
      'dsh-desktop-clock: diag route',
    );
  });
}
