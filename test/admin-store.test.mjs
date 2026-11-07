import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { verifyPassword, newSession, session } from '../lib/auth.mjs';

let directory, file, store, owner;
const map = title => ({ title, rootId: 'r', nodes: { r: { id: 'r', text: 'Root', parent: null } } });
function admin(...args) {
  return adminWithPassword('test-cli-password-123', ...args);
}
function adminWithPassword(password, ...args) {
  const response = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    new URL('../admin.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, DB_PATH: file }, input: password + '\n', encoding: 'utf8',
  });
  return response;
}
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'ms-home-admin-'));
  file = join(directory, 'home.db');
  assert.equal(admin('add', 'alice').status, 0);
  store = new Store(file);
  owner = store.get('SELECT id FROM users WHERE username=?', 'alice').id;
});
after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
test('CLI provisions hashed passwords; duplicate accounts fail and no password appears in output', async () => {
  const user = store.get('SELECT * FROM users WHERE id=?', owner);
  assert.ok(await verifyPassword('test-cli-password-123', user.password));
  assert.match(user.password, /^scrypt:/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const duplicate = admin('add', 'alice');
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists/);
  assert.ok(!duplicate.stdout.includes('test-cli-password-123'));
  assert.equal(admin('list').status, 0);
});
test('CLI passwords accept eight characters and reject seven for creation and resets', async () => {
  const rejected = adminWithPassword('boundar', 'add', 'minimum');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Password must contain 8 to 1024 characters/);
  assert.equal(store.get('SELECT id FROM users WHERE username=?', 'minimum'), undefined);
  const created = adminWithPassword('boundary', 'add', 'minimum');
  assert.equal(created.status, 0, created.stderr);
  const user = store.get('SELECT * FROM users WHERE username=?', 'minimum');
  assert.ok(await verifyPassword('boundary', user.password));
  const token = newSession(store, user, 60000).token;
  const rejectedReset = adminWithPassword('boundar', 'reset-password', 'minimum');
  assert.equal(rejectedReset.status, 1);
  assert.match(rejectedReset.stderr, /Password must contain 8 to 1024 characters/);
  assert.equal(store.get('SELECT password FROM users WHERE id=?', user.id).password, user.password);
  assert.equal(session(store, token).id, user.id);
  const reset = adminWithPassword('updated!', 'reset-password', 'minimum');
  assert.equal(reset.status, 0, reset.stderr);
  assert.ok(await verifyPassword('updated!', store.get('SELECT password FROM users WHERE id=?', user.id).password));
  assert.equal(session(store, token), null);
});
test('version coalescing and retention cover exactly the last 50 minute-separated snapshots', t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let tag = store.save(owner, 'history', map('first'), '*');
  now += 1000;
  tag = store.save(owner, 'history', map('refinement'), tag);
  assert.equal(store.all('SELECT ts FROM versions WHERE owner=? AND id=?', owner, 'history').length, 1);
  for (let i = 0; i < 55; i++) {
    now += 60001;
    tag = store.save(owner, 'history', map('version ' + i), tag);
  }
  const versions = store.all('SELECT ts,data FROM versions WHERE owner=? AND id=? ORDER BY ts DESC', owner, 'history');
  assert.equal(versions.length, 50);
  assert.equal(JSON.parse(versions[0].data).title, 'version 54');
  assert.equal(JSON.parse(versions.at(-1).data).title, 'version 5');
});
test('live SQLite backup is consistent and preserves maps, folders and sessions after reopen', () => {
  const folder = store.createFolder(owner, { name: 'Persistent folder' }).id;
  store.run('UPDATE maps SET folder=? WHERE owner=? AND id=?', folder, owner, 'history');
  const token = newSession(store, { id: owner }, 60000).token;
  const backup = join(directory, 'backup.db');
  const result = admin('backup', backup);
  assert.equal(result.status, 0, result.stderr);
  const snapshot = new Store(backup);
  assert.equal(snapshot.map(owner, 'history').folder, folder);
  assert.equal(snapshot.folders(owner)[0].name, 'Persistent folder');
  assert.equal(session(snapshot, token).id, owner);
  assert.equal(snapshot.get('PRAGMA integrity_check').integrity_check, 'ok');
  snapshot.db.close();
  assert.equal(admin('backup', backup).status, 1, 'never overwrite an existing backup');
});
test('upstream SQLite migration preserves history and aborts duplicate imports atomically', () => {
  const path = join(directory, 'upstream.db');
  const source = new DatabaseSync(path);
  source.exec('CREATE TABLE maps(id TEXT,title TEXT,color TEXT,data TEXT,updated INTEGER); CREATE TABLE map_versions(id TEXT,ts INTEGER,data TEXT);');
  source.prepare('INSERT INTO maps VALUES(?,?,?,?,?)').run('legacy', 'Legacy', null, JSON.stringify(map('Legacy')), 12345);
  source.prepare('INSERT INTO map_versions VALUES(?,?,?)').run('legacy', 12345, JSON.stringify(map('Legacy snapshot')));
  source.close();
  const result = admin('import-sqlite', 'alice', path);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.map(owner, 'legacy').updated, 12345);
  assert.equal(store.get('SELECT ts FROM versions WHERE owner=? AND id=?', owner, 'legacy').ts, 12345);
  const reordered = new DatabaseSync(path);
  reordered.exec('DELETE FROM maps');
  reordered.prepare('INSERT INTO maps VALUES(?,?,?,?,?)').run('fresh', 'Fresh', null, JSON.stringify(map('Fresh')), 12346);
  reordered.prepare('INSERT INTO maps VALUES(?,?,?,?,?)').run('legacy', 'Legacy', null, JSON.stringify(map('Legacy')), 12345);
  reordered.close();
  const duplicate = admin('import-sqlite', 'alice', path);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /aborted without changes/);
  assert.equal(store.get('SELECT id FROM maps WHERE owner=? AND id=?', owner, 'fresh'), undefined);
});
test('administration invalidates sessions and safely deletes an account with nested folders', () => {
  const token = newSession(store, { id: owner }, 60000).token;
  assert.equal(admin('reset-password', 'alice').status, 0);
  assert.equal(session(store, token), null);
  const next = newSession(store, { id: owner }, 60000).token;
  assert.equal(admin('disable', 'alice').status, 0);
  assert.equal(session(store, next), null);
  assert.equal(admin('enable', 'alice').status, 0);
  const parent = store.createFolder(owner, { name: 'Parent' }).id;
  store.createFolder(owner, { name: 'Child', parent });
  assert.equal(admin('delete', 'alice').status, 1);
  assert.equal(admin('delete', 'alice', '--confirm').status, 0);
  assert.equal(store.all('SELECT id FROM maps').length, 0);
  assert.equal(store.all('SELECT id FROM folders').length, 0);
});
test('newer database schemas cannot be silently downgraded', () => {
  const future = join(directory, 'future.db');
  const db = new DatabaseSync(future);
  db.exec('PRAGMA user_version=2'); db.close();
  assert.throws(() => new Store(future), /Refusing to downgrade/);
});
