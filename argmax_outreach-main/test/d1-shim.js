import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

/** Minimal Cloudflare D1-compatible wrapper over node:sqlite, for local smoke tests only. */
export function makeD1(schemaPath) {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        _params: [],
        bind(...params) { this._params = params; return this; },
        async first() {
          try { return stmt.get(...this._params) ?? null; } catch (cause) { throw new Error(`${cause.message} :: ${sql}`); }
        },
        async all() {
          try { return { results: stmt.all(...this._params) }; } catch (cause) { throw new Error(`${cause.message} :: ${sql}`); }
        },
        async run() {
          try { const info = stmt.run(...this._params); return { meta: { changes: info.changes } }; }
          catch (cause) { throw new Error(`${cause.message} :: ${sql}`); }
        }
      };
    }
  };
}
