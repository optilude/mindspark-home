import { readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Store, validId } from './lib/store.mjs';
import { username, hashPassword } from './lib/auth.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
async function password() {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  process.stdout.write('Password (12+ characters, input hidden): ');
  const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try { return await rl.question(''); }
  finally { rl.close(); process.stdout.write('\n'); }
}

const [command, argument, extra] = process.argv.slice(2);
let store;
try {
  if (!['add', 'reset-password', 'list', 'disable', 'enable', 'delete', 'backup', 'import-sqlite'].includes(command))
    throw new Error('Usage: node admin.mjs add|reset-password|disable|enable USER; list; delete USER --confirm; backup FILE; import-sqlite USER FILE');
  store = new Store(process.env.DB_PATH || join(root, 'data', 'home.db'));
  if (command === 'list') {
    console.table(store.all('SELECT username,id,disabled FROM users ORDER BY username'));
  } else if (command === 'backup') {
    if (!argument) throw new Error('Provide a new backup file path.');
    const target = resolve(argument);
    if (existsSync(target)) throw new Error('Backup destination already exists; choose a new file.');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await backup(store.db, target);
    chmodSync(target, 0o600);
    console.log('Consistent SQLite backup written to', target);
  } else {
    const login = username(argument);
    const user = store.get('SELECT * FROM users WHERE username=?', login);
    if (command === 'add') {
      if (user) throw new Error('Username already exists.');
      const digest = await hashPassword(await password());
      store.run('INSERT INTO users(id,username,password) VALUES(?,?,?)', randomUUID(), login, digest);
    } else {
      if (!user) throw new Error('User does not exist.');
      if (command === 'reset-password') {
        const digest = await hashPassword(await password());
        store.transaction(() => {
          store.run('UPDATE users SET password=? WHERE id=?', digest, user.id);
          store.run('DELETE FROM sessions WHERE user_id=?', user.id);
        });
      } else if (command === 'disable' || command === 'enable') {
        store.transaction(() => {
          store.run('UPDATE users SET disabled=? WHERE id=?', command === 'disable' ? 1 : 0, user.id);
          store.run('DELETE FROM sessions WHERE user_id=?', user.id);
        });
      } else if (command === 'delete') {
        if (extra !== '--confirm') throw new Error('Deletion removes maps and history permanently. Back up first, then add --confirm.');
        store.transaction(() => {
          store.run('UPDATE folders SET parent=NULL WHERE owner=?', user.id);
          store.run('DELETE FROM maps WHERE owner=?', user.id);
          store.run('DELETE FROM folders WHERE owner=?', user.id);
          store.run('DELETE FROM users WHERE id=?', user.id);
        });
      } else if (command === 'import-sqlite') {
        if (!extra) throw new Error('Provide the path to a consistent upstream MindSpark SQLite backup.');
        const source = new DatabaseSync(resolve(extra), { readOnly: true });
        try {
          const maps = source.prepare('SELECT * FROM maps').all();
          const hasVersions = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_versions'").get();
          const versions = hasVersions ? source.prepare('SELECT * FROM map_versions ORDER BY ts DESC').all() : [];
          store.transaction(() => {
            for (const row of maps) {
              const map = JSON.parse(row.data);
              if (!validId(row.id) || !map || !map.nodes || !Object.hasOwn(map.nodes, map.rootId))
                throw new Error('Invalid map in source: ' + row.id);
              if (store.get('SELECT id FROM maps WHERE owner=? AND id=?', user.id, row.id))
                throw new Error('Map already exists; import aborted without changes: ' + row.id);
              store.run('INSERT INTO maps(owner,id,title,color,data,updated) VALUES(?,?,?,?,?,?)',
                user.id, row.id, row.title, row.color, JSON.stringify({ ...map, id: row.id }), row.updated);
            }
            const counts = new Map();
            for (const row of versions) {
              const count = counts.get(row.id) || 0;
              if (count >= 50) continue;
              counts.set(row.id, count + 1);
              if (!maps.some(m => m.id === row.id)) continue;
              store.run('INSERT INTO versions(owner,id,ts,data) VALUES(?,?,?,?)', user.id, row.id, row.ts, row.data);
            }
          });
          console.log(`Imported ${maps.length} maps into ${login}, preserving up to 50 versions per map.`);
        } finally { source.close(); }
      }
    }
    console.log(`${command}: ${login} - done`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.db.close(); }
