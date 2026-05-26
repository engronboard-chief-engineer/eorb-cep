// db.src.js
// better-sqlite3 wrapper used as the persistence backend for the localStorage
// shim. The existing 9,263-line eORB UI calls localStorage synchronously on
// startup; this module provides a sync KV store the preload shim can hydrate
// from in one IPC round-trip.
//
// Schema is intentionally minimal -- one key/value table. The UI handles
// whatever JSON shape it stores; SQLite is just the durable backing store.

const path = require('path');
const fs = require('fs');
let _db = null;

function openDb(dataDir) {
  if (_db) return _db;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const Database = require('better-sqlite3');
  const dbPath = path.join(dataDir, 'database.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  return _db;
}

function init(userDataDir) {
  openDb(userDataDir);
}

function getAll(userDataDir) {
  const db = openDb(userDataDir);
  const rows = db.prepare('SELECT k, v FROM kv').all();
  const out = {};
  for (const r of rows) out[r.k] = r.v;
  return out;
}

function set(userDataDir, k, v) {
  const db = openDb(userDataDir);
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(String(k), String(v));
}

function get(userDataDir, k) {
  const db = openDb(userDataDir);
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(String(k));
  return r ? r.v : null;
}

function remove(userDataDir, k) {
  const db = openDb(userDataDir);
  db.prepare('DELETE FROM kv WHERE k = ?').run(String(k));
}

function clear(userDataDir) {
  const db = openDb(userDataDir);
  db.prepare('DELETE FROM kv').run();
}

function close() {
  if (_db) { try { _db.close(); } catch (_) {} _db = null; }
}

module.exports = { init, getAll, set, get, remove, clear, close };
