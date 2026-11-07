import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const etag = data => '"' + createHash('sha256').update(data).digest('base64url') + '"';
export const validId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
export function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
    fail(400, 'Name must contain 1 to 200 characters.');
  return value.trim();
}

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    if (this.get('PRAGMA user_version').user_version > 1) {
      this.db.close();
      throw new Error('This database needs a newer MindSpark Home version. Refusing to downgrade it.');
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent TEXT REFERENCES folders(id), name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maps (
        owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL,
        title TEXT NOT NULL, color TEXT, data TEXT NOT NULL, updated INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, folder TEXT REFERENCES folders(id),
        PRIMARY KEY(owner,id)
      );
      CREATE TABLE IF NOT EXISTS versions (
        owner TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(owner,id,ts),
        FOREIGN KEY(owner,id) REFERENCES maps(owner,id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS folders_owner ON folders(owner);
      CREATE INDEX IF NOT EXISTS maps_owner ON maps(owner,updated DESC);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
      PRAGMA user_version=1;
    `);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  map(owner, id) {
    if (!validId(id)) fail(400, 'Invalid map ID.');
    const row = this.get('SELECT * FROM maps WHERE owner=? AND id=?', owner, id);
    if (!row) fail(404, 'Map not found.');
    return row;
  }
  folder(owner, id) {
    const row = this.get('SELECT * FROM folders WHERE owner=? AND id=?', owner, id);
    if (!row) fail(404, 'Folder not found.');
    return row;
  }
  save(owner, id, map, expected) {
    if (!validId(id)) fail(400, 'Invalid map ID.');
    if (!map || typeof map !== 'object' || Array.isArray(map) ||
        !map.nodes || typeof map.nodes !== 'object' || Array.isArray(map.nodes) ||
        typeof map.rootId !== 'string' || !Object.hasOwn(map.nodes, map.rootId))
      fail(400, 'A map needs a nodes object and a valid rootId.');
    const title = name(map.title || 'Untitled map');
    const color = typeof map.color === 'string' ? map.color : null;
    return this.transaction(() => {
      const prev = this.get('SELECT * FROM maps WHERE owner=? AND id=?', owner, id);
      if (prev ? expected !== etag(prev.data) : expected !== '*')
        fail(412, 'This map changed in another tab, or was deleted. Export your edits before reloading.');
      const updated = Math.max(Date.now(), (prev?.updated || 0) + 1);
      const data = JSON.stringify({ ...map, id, title, updated });
      if (prev) this.run('UPDATE maps SET title=?,color=?,data=?,updated=?,revision=revision+1 WHERE owner=? AND id=?',
        title, color, data, updated, owner, id);
      else this.run('INSERT INTO maps(owner,id,title,color,data,updated) VALUES(?,?,?,?,?,?)',
        owner, id, title, color, data, updated);
      const last = this.get('SELECT ts FROM versions WHERE owner=? AND id=? ORDER BY ts DESC LIMIT 1', owner, id);
      if (last && updated - last.ts < 60000)
        this.run('UPDATE versions SET data=? WHERE owner=? AND id=? AND ts=?', data, owner, id, last.ts);
      else this.run('INSERT INTO versions(owner,id,ts,data) VALUES(?,?,?,?)', owner, id, updated, data);
      this.run(`DELETE FROM versions WHERE owner=? AND id=? AND ts NOT IN
        (SELECT ts FROM versions WHERE owner=? AND id=? ORDER BY ts DESC LIMIT 50)`, owner, id, owner, id);
      return etag(data);
    });
  }
  folders(owner) {
    return this.all('SELECT id,parent,name FROM folders WHERE owner=? ORDER BY name COLLATE NOCASE,id', owner);
  }
  createFolder(owner, input) {
    const parent = input.parent ?? null;
    if (parent !== null) this.folder(owner, parent);
    const id = randomUUID();
    this.run('INSERT INTO folders(id,owner,parent,name) VALUES(?,?,?,?)', id, owner, parent, name(input.name));
    return { id };
  }
  updateFolder(owner, id, input) {
    return this.transaction(() => {
      const folder = this.folder(owner, id);
      const parent = input.parent === undefined ? folder.parent : input.parent;
      if (parent !== null) {
        let current = this.folder(owner, parent);
        const seen = new Set([id]);
        while (current) {
          if (seen.has(current.id)) fail(400, 'A folder cannot be moved inside itself or its descendants.');
          seen.add(current.id);
          current = current.parent ? this.folder(owner, current.parent) : null;
        }
      }
      this.run('UPDATE folders SET name=?,parent=? WHERE owner=? AND id=?',
        name(input.name === undefined ? folder.name : input.name), parent, owner, id);
    });
  }
  deleteFolder(owner, id) {
    this.folder(owner, id);
    if (this.get('SELECT id FROM folders WHERE owner=? AND parent=?', owner, id) ||
        this.get('SELECT id FROM maps WHERE owner=? AND folder=?', owner, id))
      fail(409, 'Folder is not empty. Move its maps and subfolders before deleting it.');
    this.run('DELETE FROM folders WHERE owner=? AND id=?', owner, id);
  }
}
