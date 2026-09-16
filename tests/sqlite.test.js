import { describe, it, expect } from 'vitest';
import Database from '../dist/src/sqlite.js';
import * as sqliteVec from 'sqlite-vec';

describe('built-in SQLite adapter', () => {
  function withDatabase(test) {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value BLOB)');
      test(db);
    } finally {
      db.close();
    }
  }

  it('preserves array/named bindings, row objects, and Buffer values', () => {
    withDatabase(db => {
      const bytes = Buffer.from([0, 1, 255]);
      expect(db.prepare('INSERT INTO items VALUES (?, ?)').run([1, bytes]).changes).toBe(1);
      expect(db.prepare('SELECT * FROM items WHERE id = @id').get({ id: 1 })).toStrictEqual({
        id: 1,
        value: bytes,
      });
      expect(db.prepare('SELECT * FROM items WHERE id = ?').get(2)).toBeUndefined();
    });
  });

  it('rolls back all writes after a constraint failure', () => {
    withDatabase(db => {
      const insert = db.prepare('INSERT INTO items VALUES (?, NULL)');
      expect(() =>
        db.transaction(() => {
          insert.run(1);
          insert.run(1);
        })(),
      ).toThrow();
      expect(db.prepare('SELECT * FROM items').all()).toEqual([]);
      expect(db.inTransaction).toBe(false);
    });
  });

  it('rolls back a failed savepoint without losing the outer transaction', () => {
    withDatabase(db => {
      const insert = db.prepare('INSERT INTO items VALUES (?, NULL)');
      const inner = db.transaction(() => {
        insert.run(2);
        throw new Error('inner');
      });
      db.transaction(() => {
        insert.run(1);
        expect(inner).toThrow('inner');
        expect(db.inTransaction).toBe(true);
        insert.run(3);
      }).immediate();
      expect(db.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([{ id: 1 }, { id: 3 }]);
    });
  });

  it('recognizes explicit transactions and SQLite automatic rollback', () => {
    withDatabase(db => {
      db.exec('BEGIN');
      expect(db.inTransaction).toBe(true);
      db.transaction(() => db.prepare('INSERT INTO items VALUES (1, NULL)').run())();
      db.prepare('ROLLBACK').run();
      expect(db.prepare('SELECT * FROM items').all()).toEqual([]);
      expect(() =>
        db.transaction(() => {
          db.exec('INSERT INTO items VALUES (1, NULL)');
          db.exec('INSERT OR ROLLBACK INTO items VALUES (1, NULL)');
        })(),
      ).toThrow(/UNIQUE/);
      expect(db.inTransaction).toBe(false);
      expect(db.prepare('SELECT * FROM items').all()).toEqual([]);
    });
  });

  it('rejects asynchronous transaction callbacks without committing their writes', () => {
    withDatabase(db => {
      expect(() =>
        db.transaction(() => {
          db.exec('INSERT INTO items VALUES (1, NULL)');
          return Promise.resolve();
        })(),
      ).toThrow(/synchronous/);
      expect(db.prepare('SELECT * FROM items').all()).toEqual([]);
    });
  });

  it('loads sqlite-vec and retains FTS5 support without an addon build', () => {
    withDatabase(db => {
      sqliteVec.load(db);
      db.exec('CREATE VIRTUAL TABLE vectors USING vec0(embedding float[2])');
      db.prepare('INSERT INTO vectors(rowid, embedding) VALUES (?, ?)').run(1, '[1,0]');
      expect(
        db.prepare('SELECT rowid FROM vectors WHERE embedding MATCH ? AND k = 1').get('[1,0]'),
      ).toEqual({ rowid: 1 });
      db.exec('CREATE VIRTUAL TABLE words USING fts5(content)');
      db.prepare('INSERT INTO words VALUES (?)').run('remember this');
      expect(db.prepare("SELECT content FROM words WHERE words MATCH 'remember'").get()).toEqual({
        content: 'remember this',
      });
    });
  });
});
