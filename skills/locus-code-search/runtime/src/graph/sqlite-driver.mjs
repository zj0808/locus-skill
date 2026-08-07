/**
 * SQLite driver selector for the graph index.
 *
 * Primary engine: better-sqlite3 (native, optionalDependency) — file-backed
 * opens are mmap-instant and queries run at native speed, removing the WASM
 * deserialize + interpret tax that dominated local query latency.
 * Fallback engine: sql.js (WASM) — always installable, keeps the client
 * working on platforms where the native module fails to build/load.
 *
 * The adapter exposes the subset of the sql.js Database/Statement API the
 * provider uses (run / prepare / exec / export / close, stmt step/getAsObject/
 * run/free), so provider code stays engine-agnostic. Set LOCUS_SQLITE=wasm to
 * force the fallback (debug/compat escape hatch).
 */

import { existsSync, readFileSync } from "node:fs";

const FORCE_WASM = ["wasm", "sqljs", "js"].includes(
  String(process.env.LOCUS_SQLITE ?? "").trim().toLowerCase(),
);

let _nativeCtorPromise = null;

function loadNativeCtor() {
  if (_nativeCtorPromise) return _nativeCtorPromise;
  _nativeCtorPromise = (async () => {
    if (FORCE_WASM) return null;
    try {
      const mod = await import("better-sqlite3");
      return mod.default || mod;
    } catch {
      return null;
    }
  })();
  return _nativeCtorPromise;
}

/** sql.js binds true/false transparently; better-sqlite3 rejects booleans. */
function bindable(params) {
  if (!params) return [];
  return params.map((value) => {
    if (value === true) return 1;
    if (value === false) return 0;
    if (value === undefined) return null;
    return value;
  });
}

class NativeStatement {
  constructor(stmt, boundParams) {
    this._stmt = stmt;
    this._bound = boundParams ? bindable(boundParams) : [];
    this._iterator = null;
    this._row = null;
  }

  run(params) {
    this._stmt.run(...bindable(params));
  }

  step() {
    if (!this._iterator) {
      this._iterator = this._stmt.iterate(...this._bound);
    }
    const next = this._iterator.next();
    if (next.done) {
      this._row = null;
      return false;
    }
    this._row = next.value;
    return true;
  }

  getAsObject() {
    return this._row || {};
  }

  free() {
    if (this._iterator) {
      this._iterator.return?.();
      this._iterator = null;
    }
  }
}

class NativeDatabase {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {boolean} fileBacked - writes are already durable in the db file;
   *   persistDatabase() can skip the serialize+write pass.
   */
  constructor(db, fileBacked) {
    this._db = db;
    this.engine = "native";
    this.fileBacked = fileBacked;
  }

  run(sql) {
    this._db.exec(sql);
  }

  prepare(sql, params) {
    return new NativeStatement(this._db.prepare(sql), params);
  }

  exec(sql) {
    const stmt = this._db.prepare(sql);
    const columns = stmt.columns().map((column) => column.name);
    const values = stmt.raw(true).all();
    return values.length ? [{ columns, values }] : [];
  }

  export() {
    return this._db.serialize();
  }

  close() {
    try {
      this._db.close();
    } catch { /* already closed */ }
  }
}

let _sqlJsPromise = null;

async function loadSqlJs() {
  if (!_sqlJsPromise) {
    _sqlJsPromise = import("../../vendor/sql.js/dist/sql-wasm.js")
      .then((mod) => (mod.default || mod)());
  }
  return _sqlJsPromise;
}

class WasmDatabase {
  constructor(db) {
    this._db = db;
    this.engine = "wasm";
    this.fileBacked = false;
  }

  run(sql) { this._db.run(sql); }
  prepare(sql, params) { return this._db.prepare(sql, params); }
  exec(sql) { return this._db.exec(sql); }
  export() { return this._db.export(); }
  close() {
    try { this._db.close(); } catch { /* already closed */ }
  }
}

/**
 * Open the graph database.
 * @param {string|null} dbPath - existing db file to open; null = fresh in-memory
 *   build target (persist later via export()).
 * @returns {Promise<{ db: NativeDatabase|WasmDatabase }>}
 */
export async function openSqlDatabase(dbPath = null) {
  const NativeCtor = await loadNativeCtor();
  if (NativeCtor) {
    try {
      if (dbPath && existsSync(dbPath)) {
        const db = new NativeCtor(dbPath);
        db.pragma("busy_timeout = 3000");
        return { db: new NativeDatabase(db, true) };
      }
      const db = new NativeCtor(":memory:");
      return { db: new NativeDatabase(db, false) };
    } catch {
      // fall through to wasm (e.g. file written by an incompatible engine state)
    }
  }

  const SQL = await loadSqlJs();
  if (dbPath && existsSync(dbPath)) {
    return { db: new WasmDatabase(new SQL.Database(readFileSync(dbPath))) };
  }
  return { db: new WasmDatabase(new SQL.Database()) };
}
