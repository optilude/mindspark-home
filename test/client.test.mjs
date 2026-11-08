import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/host-bootstrap.js', import.meta.url), 'utf8');
function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key), key: index => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
function context(id, shared, fetch, extra = {}) {
  const listeners = {};
  const window = { localStorage: shared, sessionStorage: storage(), history: { replaceState() {} },
    addEventListener(type, fn) { listeners[type] = fn; }, listeners };
  const element = () => ({ childNodes: [], style: {}, append(...items) { this.childNodes.push(...items); },
    prepend() {}, replaceChildren(...items) { this.childNodes = items; }, setAttribute() {}, remove() { this.removed = true; } });
  const elements = new Map();
  const document = { body: element(), addEventListener() {}, createElement: element, createTextNode: text => text,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, ...extra.document };
  const ctx = vm.createContext({ window, document, history: [],
    location: { pathname: `/w/${id}/`, search: '', href: `https://maps.example.com/w/${id}/`, origin: 'https://maps.example.com' },
    fetch, console: { error() {} }, Blob, Map, Set, URL, URLSearchParams, AbortSignal, setTimeout: fn => setImmediate(fn) });
  vm.runInContext(readFileSync(new URL('../public/navigation.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(source, ctx);
  return ctx;
}
test('account storage, enumeration and clear cannot accidentally access another account namespace', () => {
  const shared = storage(), alice = context('alice', shared), bob = context('bob', shared);
  vm.runInContext("localStorage.setItem('mindspark:api-key','alice-secret')", alice);
  vm.runInContext("localStorage.setItem('mindspark:api-key','bob-secret')", bob);
  assert.equal(vm.runInContext("localStorage.getItem('mindspark:api-key')", alice), 'alice-secret');
  assert.equal(vm.runInContext("localStorage.length", bob), 1);
  assert.equal(vm.runInContext("localStorage.key(0)", bob), 'mindspark:api-key');
  vm.runInContext('localStorage.clear()', bob);
  assert.equal(vm.runInContext("localStorage.getItem('mindspark:api-key')", alice), 'alice-secret');
});
test('hosted saves retain conditional tokens and never fall back to an unconditional POST', async () => {
  const calls = [];
  let failMove = true;
  const ctx = context('alice', storage(), async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/library/maps/child/folder' && failMove) {
      failMove = false;
      return new Response(JSON.stringify({ error: 'Move failed' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    const data = url === '/api/session' ? { id: 'alice', username: 'alice', csrf: 'token' }
      : url === '/api/library' ? { folders: [{ id: 'f', parent: null, name: 'Plans' }], maps: [{ id: 'm', folder: 'f' }, { id: 'outside', folder: null }] }
      : url === './api/maps' ? [{ id: 'm' }, { id: 'outside' }] : { id: 'm', nodes: {}, rootId: 'r' };
    return new Response(JSON.stringify(data), { status: 200, headers: { ETag: '"v1"', 'Content-Type': 'application/json' } });
  });
  const store = ctx.window.MINDSPARK_HOST.store;
  await ctx.window.MINDSPARK_HOST.ready();
  await store.save({ id: 'new' });
  assert.equal(calls.at(-1).options.headers['If-None-Match'], '*');
  await store.get('m');
  await store.save({ id: 'm' });
  assert.equal(calls.at(-1).options.headers['If-Match'], '"v1"');
  assert.deepEqual(Array.from(await store.list(), m => m.id), ['m']);
  assert.equal(ctx.document.getElementById('home-back').href, '/library?folder=f');
  await assert.rejects(store.save({ id: 'child' }), /Move failed/);
  await store.save({ id: 'child' });
  assert.equal(calls.filter(c => c.url === '/api/library/maps/child/folder').length, 2);
  assert.equal(calls.at(-1).url, '/api/library/maps/child/folder');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { folder: 'f' });
  assert.ok(calls.every(c => c.options.method !== 'POST'));
});
test('folder paths preserve hierarchy and reject missing folders and cycles', () => {
  const ctx = context('alice', storage());
  const folders = [{ id: 'a', parent: null, name: 'Projects' }, { id: 'b', parent: 'a', name: 'Plans' }];
  ctx.folders = folders;
  assert.deepEqual(Array.from(vm.runInContext('HomeNavigation.chain(folders,"b")', ctx), f => f.name), ['My maps', 'Projects', 'Plans']);
  assert.throws(() => vm.runInContext('HomeNavigation.chain(folders,"missing")', ctx), /Folder not found/);
  folders[0].parent = 'b';
  assert.throws(() => vm.runInContext('HomeNavigation.chain(folders,"b")', ctx), /Invalid folder hierarchy/);
});
test('hosted boot and save failures propagate explicitly, including conflicts', async () => {
  const ctx = context('alice', storage(), async () => new Response(JSON.stringify({ error: 'Changed elsewhere' }), { status: 412, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(ctx.window.MINDSPARK_HOST.store.save({ id: 'm' }), error => error.conflict && error.message === 'Changed elsewhere');
  await assert.rejects(ctx.window.MINDSPARK_HOST.ready(), /Changed elsewhere/);
});
test('proxy HTML errors are surfaced as HTTP failures rather than JSON parser errors', async () => {
  const ctx = context('alice', storage(), async () => new Response('<html>Too large</html>', { status: 413 }));
  await assert.rejects(ctx.window.MINDSPARK_HOST.store.save({ id: 'm' }), /HTTP 413/);
});
// A minimal guarded map server; `drop` loses responses after committing, `refuse` fails before.
function mapServer() {
  const server = { data: null, version: 0, drop: 0, refuse: 0, puts: [] };
  const tag = () => `"v${server.version}"`;
  server.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') {
      server.puts.push(options);
      if (server.refuse && server.refuse--) return new Response('<html>Bad gateway</html>', { status: 502 });
      const expected = options.headers['If-Match'] || options.headers['If-None-Match'];
      if (expected !== (server.data ? tag() : '*'))
        return new Response(JSON.stringify({ error: 'Changed elsewhere' }), { status: 412, headers: { 'Content-Type': 'application/json' } });
      server.data = JSON.stringify({ ...JSON.parse(options.body), updated: Date.now() }); server.version++;
      if (server.drop && server.drop--) throw new TypeError('Failed to fetch');
      return new Response('{"ok":true}', { headers: { ETag: tag(), 'Content-Type': 'application/json' } });
    }
    return new Response(server.data, { headers: { ETag: tag(), 'Content-Type': 'application/json' } });
  };
  return server;
}
test('a save whose response was lost is recognised rather than blocking every later save', async () => {
  const server = mapServer(), ctx = context('alice', storage(), server.fetch);
  const store = ctx.window.MINDSPARK_HOST.store;
  server.drop = 1;
  await store.save({ id: 'm', title: 'One', nodes: { r: {} }, rootId: 'r' });
  assert.equal(JSON.parse(server.data).title, 'One');
  server.drop = 1;
  await store.save({ id: 'm', title: 'Two', nodes: { r: {} }, rootId: 'r' });
  await store.save({ id: 'm', title: 'Three', nodes: { r: {} }, rootId: 'r' });
  assert.equal(JSON.parse(server.data).title, 'Three');
  const [banner] = ctx.document.body.childNodes;
  assert.equal(banner.removed, true, 'the connection banner clears and no conflict is reported');
  assert.ok(!banner.childNodes.some(text => /changed in another tab|Changed elsewhere/.test(text)));
  assert.equal(ctx.window.listeners.beforeunload.call(null, { preventDefault() { throw new Error('guarded'); } }), undefined);
});
test('proxy gateway failures are retried and the transient banner clears once saving works', async () => {
  const server = mapServer(), ctx = context('alice', storage(), server.fetch);
  server.refuse = 3;
  await ctx.window.MINDSPARK_HOST.store.save({ id: 'm', nodes: { r: {} }, rootId: 'r' });
  assert.equal(server.puts.length, 4);
  assert.ok(server.data);
});
test('keepalive is used only for a save started while the page is hidden', async () => {
  const visible = mapServer(), hidden = mapServer();
  await context('alice', storage(), visible.fetch).window.MINDSPARK_HOST.store.save({ id: 'm', nodes: { r: {} }, rootId: 'r' });
  await context('alice', storage(), hidden.fetch, { document: { visibilityState: 'hidden' } })
    .window.MINDSPARK_HOST.store.save({ id: 'm', nodes: { r: {} }, rootId: 'r' });
  assert.equal(visible.puts[0].keepalive, false);
  assert.equal(hidden.puts[0].keepalive, true);
});
test('a genuine conflict still refuses to overwrite and guards closing the tab', async () => {
  const server = mapServer(), ctx = context('alice', storage(), server.fetch);
  const store = ctx.window.MINDSPARK_HOST.store;
  await store.save({ id: 'm', title: 'Mine', nodes: { r: {} }, rootId: 'r' });
  server.data = JSON.stringify({ id: 'm', title: 'Other tab', nodes: { r: {} }, rootId: 'r' }); server.version++;
  server.drop = 0;
  await assert.rejects(store.save({ id: 'm', title: 'Mine again', nodes: { r: {} }, rootId: 'r' }), error => error.conflict);
  assert.equal(JSON.parse(server.data).title, 'Other tab');
  let prevented = false;
  ctx.window.listeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
});
test('login form survives the browser clearing event.currentTarget while authentication is awaited', async () => {
  const source = readFileSync(new URL('../public/home.js', import.meta.url), 'utf8');
  const start = source.indexOf("$('login').onsubmit = act(");
  const code = source.slice(start, source.indexOf('\n(async () =>', start));
  let reset = false, signedIn = false;
  const form = { reset() { reset = true; } };
  const event = { currentTarget: form, preventDefault() {} };
  const FormData = class { *[Symbol.iterator]() { yield ['username', 'alice']; yield ['password', 'test-password']; } };
  new Function('$', 'act', 'FormData', 'api', 'signedIn', code)(
    () => form, fn => fn, FormData, async () => { event.currentTarget = null; }, async () => { signedIn = true; });
  await form.onsubmit(event);
  assert.equal(reset, true);
  assert.equal(signedIn, true);
});
