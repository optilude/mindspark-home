import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { hashPassword } from '../lib/auth.mjs';

let app, base, directory, alice, bob;
const password = 'test-only-password-123';
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ms-home-http-'));
  app = await createApp({ dbPath: join(directory, 'home.db'), origin: 'http://localhost:3000' });
  const digest = await hashPassword(password);
  for (const id of ['alice', 'bob'])
    app.store.run('INSERT INTO users(id,username,password) VALUES(?,?,?)', id, id, digest);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  alice = await login('alice'); bob = await login('bob');
});
after(async () => {
  await new Promise(resolve => app.server.close(resolve));
  app.store.db.close();
  rmSync(directory, { recursive: true, force: true });
});
async function request(path, options = {}, account) {
  const headers = {
    Host: 'localhost:3000', Origin: 'http://localhost:3000', 'Content-Type': 'application/json',
    ...(account ? { Cookie: account.cookie, 'X-CSRF-Token': account.csrf, 'X-Workspace-Id': account.id } : {}),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: options.method || 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
async function login(username) {
  const response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const session = await request('/api/session', { headers: { Cookie: cookie } });
  return { ...await session.json(), cookie };
}
const map = (title = 'Map') => ({ title, rootId: 'r', nodes: { r: { id: 'r', text: 'Root', parent: null } }, links: [] });
const json = (method, data, headers = {}) => ({ method, body: JSON.stringify(data), headers });

test('anonymous API and editor access is denied; shell reveals no private data', async () => {
  for (const path of ['/api/library', '/w/alice/', '/w/alice/api/maps', '/w/alice/app.js'])
    assert.equal((await request(path)).status, 401, path);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/healthz')).status, 200);
});

test('origin, host and CSRF are enforced without trusting forwarded headers', async () => {
  assert.equal((await request('/api/login', json('POST', {}, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await request('/', { headers: { Host: 'evil.example', 'X-Forwarded-Host': 'localhost:3000' } })).status, 421);
  assert.equal((await request('/api/folders', json('POST', { name: 'Denied' }, { 'X-CSRF-Token': 'bad' }), alice)).status, 403);
  assert.equal((await request('/api/library', { headers: { 'X-Workspace-Id': 'bob' } }, alice)).status, 403);
});

test('maps and every history endpoint are isolated even when IDs collide', async () => {
  for (const account of [alice, bob]) {
    const response = await request(`/w/${account.id}/api/maps/same`, json('PUT', map(account.id), { 'If-None-Match': '*' }), account);
    assert.equal(response.status, 200);
  }
  for (const account of [alice, bob]) {
    const response = await request(`/w/${account.id}/api/maps/same`, {}, account);
    assert.equal((await response.json()).title, account.id);
  }
  for (const method of ['GET', 'PUT', 'DELETE'])
    assert.equal((await request('/w/alice/api/maps/same', method === 'PUT' ? json(method, map()) : { method }, bob)).status, 403);
  for (const path of ['/w/alice/api/maps/same/versions', '/w/alice/api/maps/same/versions/1', '/w/alice/healthz', '/w/alice/index.html'])
    assert.equal((await request(path, {}, bob)).status, 403, path);
  const versions = await (await request('/w/alice/api/maps/same/versions', {}, alice)).json();
  assert.equal(versions.length, 1);
  const version = await (await request('/w/alice/api/maps/same/versions/' + versions[0].ts, {}, alice)).json();
  assert.equal(version.title, 'alice');
});

test('conditional saves protect stale edits and deleted maps from resurrection', async () => {
  const path = '/w/alice/api/maps/conflict';
  const first = await request(path, json('PUT', map(), { 'If-None-Match': '*' }), alice);
  assert.equal(first.status, 200);
  const tag = first.headers.get('etag');
  assert.ok(tag);
  assert.equal((await request(path, json('PUT', map('Changed'), { 'If-Match': tag }), alice)).status, 200);
  assert.equal((await request(path, json('PUT', map('Stale'), { 'If-Match': tag }), alice)).status, 412);
  assert.equal((await request(path, json('PUT', map('Overwrite'), { 'If-None-Match': '*' }), alice)).status, 412);
  assert.equal((await request(path, json('PUT', map('Unguarded')), alice)).status, 412);
  await request(path, { method: 'DELETE' }, alice);
  assert.equal((await request(path, json('PUT', map('Revive'), { 'If-Match': tag }), alice)).status, 412);
  assert.equal((await request(path + '/versions', {}, alice)).status, 404);
});

test('nested folders reject cycles, cross-account parents, moves and deletion of contents', async () => {
  const create = async (account, name, parent = null) => {
    const response = await request('/api/folders', json('POST', { name, parent }), account);
    assert.equal(response.status, 201);
    return (await response.json()).id;
  };
  const parent = await create(alice, 'Parent'), child = await create(alice, 'Child', parent);
  assert.equal((await request('/api/folders/' + parent, json('PATCH', { parent: child }), alice)).status, 400);
  assert.equal((await request('/api/folders/' + child, json('PATCH', { parent: child }), alice)).status, 400);
  assert.equal((await request('/api/folders', json('POST', { name: 'Bad', parent }), bob)).status, 404);
  assert.equal((await request('/api/folders/' + parent, json('PATCH', { name: 'Steal' }), bob)).status, 404);
  assert.equal((await request('/api/folders/' + parent, { method: 'DELETE' }, alice)).status, 409);
  assert.equal((await request('/api/library/maps/same/folder', json('PATCH', { folder: child }), alice)).status, 200);
  assert.equal((await request('/api/library/maps/same/folder', json('PATCH', { folder: child }), bob)).status, 404);
  assert.equal((await request('/api/folders/' + child, { method: 'DELETE' }, alice)).status, 409);
  const library = await (await request('/api/library', {}, alice)).json();
  assert.equal(library.maps.find(m => m.id === 'same').folder, child);
  // Autosaves do not discard wrapper-managed folder membership.
  const got = await request('/w/alice/api/maps/same', {}, alice);
  assert.equal((await request('/w/alice/api/maps/same', json('PUT', map('Renamed'), { 'If-Match': got.headers.get('etag') }), alice)).status, 200);
  assert.equal((await (await request('/api/library', {}, alice)).json()).maps.find(m => m.id === 'same').folder, child);
  await request('/api/library/maps/same/folder', json('PATCH', { folder: null }), alice);
  assert.equal((await request('/api/folders/' + child, { method: 'DELETE' }, alice)).status, 200);
  assert.equal((await request('/api/folders/' + parent, { method: 'DELETE' }, alice)).status, 200);
});

test('invalid bodies, IDs and oversized requests return explicit errors without writing maps', async () => {
  assert.equal((await request('/w/alice/api/maps/bad', json('PUT', null, { 'If-None-Match': '*' }), alice)).status, 400);
  assert.equal((await request('/w/alice/api/maps/bad', json('PUT', { title: 'Missing tree' }, { 'If-None-Match': '*' }), alice)).status, 400);
  assert.equal((await request('/w/alice/api/maps/' + 'a'.repeat(101), json('PUT', map(), { 'If-None-Match': '*' }), alice)).status, 400);
  assert.equal((await request('/api/folders', { method: 'POST', body: '{broken' }, alice)).status, 400);
  assert.equal((await request('/api/login', json('POST', { username: 'a', password: 'x'.repeat(20000) }))).status, 413);
  const oversized = { ...map(), title: 'Large', notes: 'x'.repeat(8 * 1024 * 1024) };
  assert.equal((await request('/w/alice/api/maps/oversized', json('PUT', oversized, { 'If-None-Match': '*' }), alice)).status, 413);
  assert.equal((await request('/w/alice/api/maps/oversized', {}, alice)).status, 404);
});

test('editor shell boots storage scoping before inline scripts and never registers offline caching', async () => {
  const response = await request('/w/alice/', {}, alice);
  const html = await response.text();
  assert.ok(html.indexOf('host-bootstrap.js') < html.indexOf('var _s=parseFloat'));
  assert.match(html, /!window\.MINDSPARK_HOST && 'serviceWorker'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/w/alice/sw.js', {}, alice)).status, 404);
  assert.equal((await request('/w/alice/host-bootstrap.js', {}, alice)).status, 200);
  assert.equal((await request('/w/alice/%2e%2e/%2e%2e/server.mjs', {}, alice)).status, 404);
  assert.equal((await request('/w/alice/api/import', json('POST', map()), alice)).status, 404);
});

test('changing passwords invalidates every session; disabled accounts cannot log in', async () => {
  const second = await login('bob');
  const rejected = await request('/api/password', json('POST', { current: password, password: '1234567' }), bob);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Password must contain 8 to 1024 characters/);
  assert.equal((await request('/api/session', {}, second)).status, 200);
  assert.equal((await request('/api/password', json('POST', { current: password, password: 'new-test' }), bob)).status, 200);
  assert.equal((await request('/api/session', {}, second)).status, 401);
  assert.equal((await request('/api/login', json('POST', { username: 'bob', password: 'new-test' }))).status, 200);
  app.store.run('UPDATE users SET disabled=1 WHERE id=?', 'alice');
  assert.equal((await request('/api/session', {}, alice)).status, 401);
  assert.equal((await request('/api/login', json('POST', { username: 'alice', password }))).status, 401);
});
test('username login throttling rejects the eleventh failed attempt', async () => {
  for (let i = 0; i < 10; i++)
    assert.equal((await request('/api/login', json('POST', { username: 'unknown', password }))).status, 401);
  assert.equal((await request('/api/login', json('POST', { username: 'unknown', password }))).status, 429);
});
test('HTTPS configuration issues a host-only secure session cookie through an HTTP reverse proxy', async () => {
  const secureApp = await createApp({ dbPath: join(directory, 'secure.db'), origin: 'https://maps.example.com' });
  secureApp.store.run('INSERT INTO users(id,username,password) VALUES(?,?,?)', 'secure', 'secure', await hashPassword(password));
  await new Promise(resolve => secureApp.server.listen(0, '127.0.0.1', resolve));
  const original = base;
  base = `http://127.0.0.1:${secureApp.server.address().port}`;
  try {
    const response = await request('/api/login', json('POST', { username: 'secure', password },
      { Host: 'maps.example.com', Origin: 'https://maps.example.com' }));
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-ms-session=/);
    for (const value of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=43200']) assert.ok(cookie.includes(value));
    assert.ok(!cookie.includes('Domain='));
  } finally {
    base = original;
    await new Promise(resolve => secureApp.server.close(resolve));
    secureApp.store.db.close();
  }
});
