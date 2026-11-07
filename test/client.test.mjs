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
function context(id, shared, fetch) {
  const window = { localStorage: shared, sessionStorage: storage() };
  const document = { body: null, addEventListener() {}, querySelector() { return { append() {} }; },
    createElement() { return {}; } };
  const ctx = vm.createContext({ window, document, location: { pathname: `/w/${id}/`, origin: 'https://maps.example.com' }, fetch, console: { error() {} }, Blob, Map });
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
  const ctx = context('alice', storage(), async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'm', nodes: {}, rootId: 'r' }), { status: 200, headers: { ETag: '"v1"', 'Content-Type': 'application/json' } });
  });
  const store = ctx.window.MINDSPARK_HOST.store;
  await store.save({ id: 'new' });
  assert.equal(calls.at(-1).options.headers['If-None-Match'], '*');
  await store.get('m');
  await store.save({ id: 'm' });
  assert.equal(calls.at(-1).options.headers['If-Match'], '"v1"');
  assert.ok(calls.every(c => c.options.method !== 'POST'));
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
