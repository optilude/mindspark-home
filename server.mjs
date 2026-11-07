import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError, fail, etag, validId } from './lib/store.mjs';
import { newSession, session, hashToken, hashPassword, verifyPassword, LoginLimiter } from './lib/auth.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json' };
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object.');
  return value;
};
async function body(req, limit = 8 * 1024 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    fail(415, 'Content-Type must be application/json.');
  const bytes = await new Promise((resolveBody, reject) => {
    let size = 0, oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (oversized) return;
      if (size > limit) {
        oversized = true; chunks.length = 0;
        reject(new HttpError(413, `Request exceeds the ${limit} byte limit.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!oversized) resolveBody(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Request was interrupted.')));
  });
  try { return object(JSON.parse(bytes.toString('utf8'))); }
  catch (e) { if (e instanceof HttpError) throw e; fail(400, 'Invalid JSON.'); }
}
function cookie(req, key) {
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1);
}
function send(res, status, value, type = 'application/json', extra = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length, ...extra });
  res.end(bytes);
}

export async function createApp(options = {}) {
  const origin = new URL(options.origin || process.env.APP_ORIGIN || 'http://localhost:3000');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash ||
      origin.username || origin.password) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    throw new Error('HTTPS is required except on localhost.');
  const ttl = 12 * 60 * 60 * 1000;
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-ms-session' : 'ms-session';
  const sessionCookie = (token, maxAge) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const store = new Store(options.dbPath || process.env.DB_PATH || join(root, 'data', 'home.db'));
  const publicDir = resolve(root, 'MindSpark', 'public');
  const shell = readFileSync(join(publicDir, 'index.html'), 'utf8');
  if (!shell.includes('window.MINDSPARK_HOST') || !readFileSync(join(publicDir, 'app.js'), 'utf8').includes('await window.MINDSPARK_HOST.ready()'))
    throw new Error('MindSpark hosted-adapter integration is missing. Check the pinned submodule.');
  const policy = shell.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  if (!policy) throw new Error('MindSpark CSP could not be found.');
  const hostedShell = shell.replace('<meta charset="utf-8" />',
    '<meta charset="utf-8" />\n<link rel="stylesheet" href="/host.css">\n<script src="/navigation.js"></script>\n<script src="./host-bootstrap.js"></script>');
  if (hostedShell === shell) throw new Error('MindSpark HTML integration point changed.');
  const dummyPassword = await hashPassword('dummy password never used for login');
  const limiter = new LoginLimiter();
  let passwordJobs = 0;
  const checkPassword = async (password, digest) => {
    if (passwordJobs >= 4) fail(429, 'Login temporarily busy. Try again shortly.');
    passwordJobs++;
    try { return await verifyPassword(password, digest); }
    finally { passwordJobs--; }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', policy + "; frame-ancestors 'none'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      const method = req.method;
      const mutating = !['GET', 'HEAD'].includes(method);
      if (req.headers.host !== origin.host) fail(421, 'Host does not match APP_ORIGIN.');
      if (mutating && req.headers.origin !== origin.origin) fail(403, 'Request origin is not allowed.');
      const user = session(store, cookie(req, cookieName));
      const requireUser = () => { if (!user) fail(401, 'Please sign in again. Your unsaved edits remain in the editor.'); return user; };
      if (mutating && path !== '/api/login') {
        requireUser();
        if (req.headers['x-csrf-token'] !== user.csrf) fail(403, 'Invalid session token. Reload after saving/exporting your edits.');
      }
      if (path === '/healthz' && method === 'GET') {
        store.get('SELECT 1');
        return send(res, 200, { ok: true });
      }
      if (path === '/api/login' && method === 'POST') {
        const input = await body(req, 16384);
        // The immediate proxy address is deliberately used: forwarded headers
        // are untrusted. The account key also limits distributed guessing.
        limiter.check('ip:' + req.socket.remoteAddress, 100);
        const login = typeof input.username === 'string' ? input.username.slice(0, 100) : '';
        limiter.check('user:' + login);
        const account = store.get('SELECT * FROM users WHERE username=?', login);
        const good = await checkPassword(input.password, account?.password || dummyPassword);
        if (!good || !account || account.disabled) fail(401, 'Incorrect username or password.');
        limiter.entries.delete('user:' + login);
        const old = cookie(req, cookieName);
        if (old) store.run('DELETE FROM sessions WHERE hash=?', hashToken(old));
        const created = newSession(store, account, ttl);
        return send(res, 200, { ok: true }, 'application/json',
          { 'Set-Cookie': sessionCookie(created.token, ttl / 1000) });
      }
      if (path === '/api/session' && method === 'GET')
        return send(res, 200, requireUser());
      if (path === '/api/logout' && method === 'POST') {
        store.run('DELETE FROM sessions WHERE hash=?', hashToken(cookie(req, cookieName)));
        return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': sessionCookie('', 0) });
      }
      if (path === '/api/password' && method === 'POST') {
        const input = await body(req, 16384);
        limiter.check('password:' + user.id);
        const account = store.get('SELECT * FROM users WHERE id=?', user.id);
        if (!await checkPassword(input.current, account.password)) fail(401, 'Current password is incorrect.');
        const password = await hashPassword(input.password);
        store.transaction(() => {
          store.run('UPDATE users SET password=? WHERE id=?', password, user.id);
          store.run('DELETE FROM sessions WHERE user_id=?', user.id);
        });
        return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': sessionCookie('', 0) });
      }
      if (path === '/api/library' && method === 'GET') {
        requireUser();
        if (req.headers['x-workspace-id'] !== user.id) fail(403, 'Account changed. Reload the library.');
        return send(res, 200, { folders: store.folders(user.id),
          maps: store.all('SELECT id,title,color,updated,folder FROM maps WHERE owner=? ORDER BY updated DESC', user.id) });
      }
      if (path === '/api/folders' && method === 'POST')
        return send(res, 201, store.createFolder(user.id, await body(req)));
      const folderMatch = path.match(/^\/api\/folders\/([\w-]+)$/);
      if (folderMatch) {
        requireUser();
        if (method === 'PATCH') { store.updateFolder(user.id, folderMatch[1], await body(req)); return send(res, 200, { ok: true }); }
        if (method === 'DELETE') { store.deleteFolder(user.id, folderMatch[1]); return send(res, 200, { ok: true }); }
      }
      const moveMatch = path.match(/^\/api\/library\/maps\/([\w-]+)\/folder$/);
      if (moveMatch && method === 'PATCH') {
        store.map(user.id, moveMatch[1]);
        const target = (await body(req)).folder;
        if (target !== null) store.folder(user.id, target);
        store.run('UPDATE maps SET folder=? WHERE owner=? AND id=?', target, user.id, moveMatch[1]);
        return send(res, 200, { ok: true });
      }
      const workspace = path.match(/^\/w\/([\w-]+)\/(.*)$/);
      if (workspace) {
        requireUser();
        if (workspace[1] !== user.id) fail(403, 'This workspace belongs to a different account. Return to the library.');
        const relative = workspace[2];
        if (relative === 'healthz' && method === 'GET') return send(res, 200, { ok: true });
        const mapMatch = relative.match(/^api\/maps\/([\w-]+)(?:\/versions(?:\/(\d+))?)?$/);
        if (relative === 'api/maps' && method === 'GET')
          return send(res, 200, store.all('SELECT id,title,color,updated,json_extract(data,\'$.pinned\') AS pinned FROM maps WHERE owner=? ORDER BY updated DESC', user.id));
        if (mapMatch) {
          const id = mapMatch[1];
          if (!validId(id)) fail(400, 'Invalid map ID.');
          if (relative.includes('/versions')) {
            store.map(user.id, id);
            if (method === 'GET') {
              if (!mapMatch[2]) return send(res, 200, store.all('SELECT ts FROM versions WHERE owner=? AND id=? ORDER BY ts DESC LIMIT 50', user.id, id));
              const row = store.get('SELECT data FROM versions WHERE owner=? AND id=? AND ts=?', user.id, id, Number(mapMatch[2]));
              if (!row) fail(404, 'Version not found.');
              return send(res, 200, row.data);
            }
          } else {
            if (method === 'GET') {
              const row = store.map(user.id, id);
              return send(res, 200, row.data, 'application/json', { ETag: etag(row.data) });
            }
            if (method === 'PUT') {
              const expected = req.headers['if-none-match'] === '*' ? '*' : req.headers['if-match'];
              const tag = store.save(user.id, id, await body(req), expected);
              return send(res, 200, { ok: true, id }, 'application/json', { ETag: tag });
            }
            if (method === 'DELETE') {
              store.map(user.id, id);
              store.run('DELETE FROM maps WHERE owner=? AND id=?', user.id, id);
              res.writeHead(204); return res.end();
            }
          }
        }
        if (relative.startsWith('api/')) fail(404, 'Unsupported hosted API endpoint.');
        if (method === 'GET') {
          if (relative === '' || relative === 'index.html') return send(res, 200, hostedShell, mime['.html']);
          if (relative === 'host-bootstrap.js') return send(res, 200, readFileSync(join(root, 'public', 'host-bootstrap.js')), mime['.js']);
          const full = resolve(publicDir, relative);
          if (!full.startsWith(publicDir + '/') || relative === '_headers' || relative === 'oauth-callback.html' || relative === 'sw.js')
            fail(404, 'File not found.');
          let stat;
          try { stat = statSync(full); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
          if (stat?.isFile()) {
            res.setHeader('Cache-Control', 'private, no-cache');
            return send(res, 200, readFileSync(full), mime[extname(full)] || 'application/octet-stream');
          }
        }
      }
      if (method === 'GET' && ['/', '/login', '/library'].includes(path))
        return send(res, 200, readFileSync(join(root, 'public', 'index.html')), mime['.html']);
      if (method === 'GET' && ['/home.js', '/home.css', '/navigation.js', '/host.css'].includes(path))
        return send(res, 200, readFileSync(join(root, 'public', path.slice(1))), mime[extname(path)]);
      fail(404, 'Not found.');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('Request failed:', req.method, req.url, e);
      if (!res.headersSent) send(res, e instanceof HttpError ? e.status : 500,
        { error: e instanceof HttpError ? e.message : 'Server error. Check the container logs.' });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, store } = await createApp();
  server.on('error', e => { console.error('Server failed:', e.message); process.exitCode = 1; });
  server.listen(Number(process.env.PORT || 3000), process.env.BIND_HOST || '0.0.0.0', () => {
    console.log(`MindSpark Home listening; public origin ${process.env.APP_ORIGIN || 'http://localhost:3000'}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { store.db.close(); });
    server.closeIdleConnections();
  });
}
