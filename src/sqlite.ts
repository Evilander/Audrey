import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

function normalizeBinding(value: unknown): unknown {
  // node:sqlite binds JS numbers as REAL; sqlite-vec requires INTEGER values
  // for integer keys. Preserve the integer binding used by the former driver.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeBinding(item)]),
    );
  }
  return value;
}

function normalizeRow(row: Record<string, SQLOutputValue>): Record<string, SQLOutputValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? Buffer.from(value) : value,
    ]),
  );
}

// Keep Audrey's synchronous query and transaction interface while using the
// SQLite library shipped with Node. No native-addon installation is required.
export default class Database {
  private connection: DatabaseSync;
  private savepoint = 0;
  readonly name: string;
  readonly readonly: boolean;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.name = path;
    this.readonly = options.readonly ?? false;
    this.connection = new DatabaseSync(path, {
      readOnly: this.readonly,
      allowExtension: true,
      enableForeignKeyConstraints: false,
    });
    this.connection.exec('PRAGMA busy_timeout = 5000');
  }

  get open(): boolean {
    return this.connection.isOpen;
  }

  get inTransaction(): boolean {
    return this.connection.isTransaction;
  }

  close(): void {
    this.connection.close();
  }

  exec(sql: string): this {
    this.connection.exec(sql);
    return this;
  }

  loadExtension(path: string): void {
    this.connection.loadExtension(path);
  }

  prepare(sql: string) {
    const statement = this.connection.prepare(sql);
    statement.setAllowUnknownNamedParameters(true);
    // Existing callers pass positional bindings either as an array or spread.
    const bindings = (args: unknown[]) => args.flat().map(normalizeBinding) as SQLInputValue[];
    return {
      get: (...args: unknown[]): unknown => {
        const row = statement.get(...bindings(args));
        return row === undefined ? undefined : normalizeRow(row);
      },
      all: (...args: unknown[]): unknown[] => statement.all(...bindings(args)).map(normalizeRow),
      run: (...args: unknown[]) => {
        const result = statement.run(...bindings(args));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
    };
  }

  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.connection.prepare(`PRAGMA ${sql}`).all();
    if (options.simple) return rows[0] === undefined ? undefined : Object.values(rows[0])[0];
    return rows.map(normalizeRow);
  }

  transaction<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
    // The returned function preserves the caller's receiver for the callback.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    const wrap = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') =>
      function (this: unknown, ...args: Args): Result {
        const nested = db.inTransaction;
        const name = `audrey_tx_${++db.savepoint}`;
        db.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode}`);
        try {
          const result = callback.apply(this, args);
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new TypeError('SQLite transaction callbacks must be synchronous');
          }
          db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
          return result;
        } catch (error) {
          // SQLite can roll back a transaction itself (for example ON CONFLICT
          // ROLLBACK). Preserve that error instead of attempting a second rollback.
          if (db.inTransaction) {
            if (nested) {
              db.exec(`ROLLBACK TO ${name}`);
              db.exec(`RELEASE ${name}`);
            } else {
              db.exec('ROLLBACK');
            }
          }
          throw error;
        }
      };
    const deferred = wrap('DEFERRED');
    return Object.assign(deferred, {
      deferred,
      immediate: wrap('IMMEDIATE'),
      exclusive: wrap('EXCLUSIVE'),
    });
  }
}
