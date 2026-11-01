import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { inspectLegacyLivingMemory, migrateLegacyLivingMemory } from '../src/living-memory/migration.js';
import { LivingMemoryStore } from '../src/living-memory/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-living-memory-migration-'));
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function createLegacyStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL, confidence REAL NOT NULL,
      tags_json TEXT NOT NULL, source_json TEXT NOT NULL, entities_json TEXT NOT NULL, relations_json TEXT NOT NULL,
      search_text TEXT NOT NULL, vector_status TEXT NOT NULL, vector_error TEXT NOT NULL, embedding_model TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, archived_at INTEGER NOT NULL
    );
    CREATE TABLE turns (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, session_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, error TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  db.prepare(`INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('m-legacy', 'group:100', 'project', 'active', 'NAS 向量记忆迁移', '原有卡片应迁入内置 SQLite 并重建向量。', 8, 0.9,
      '["NAS","迁移"]', '{"turnIds":["t-legacy"]}', '["SQLite"]', '[]', 'NAS 向量记忆迁移 SQLite', 'ready', '', 'BAAI/bge-m3',
      1700000000000, 1700001000000, 0, 0);
  db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?)')
    .run('t-legacy', 'group:100', 'session-1', '{"lines":[{"role":"user","text":"迁移记忆"}]}', 1700000000100);
  db.close();
}

test('legacy external memory migration preserves cards, turns, timestamps, and can rebuild local vectors', async () => {
  const sourceFile = path.join(root, `legacy-${Date.now()}.sqlite`);
  const targetFile = path.join(root, `target-${Date.now()}.sqlite`);
  createLegacyStore(sourceFile);
  const inspection = inspectLegacyLivingMemory({ sourceFile });
  assert.deepEqual(inspection.scopes, [{ scopeKey: 'group:100', count: 1 }]);
  assert.equal(inspection.vectorReady, 1);

  const embedder = {
    ready: () => true,
    async embed(input) {
      const values = Array.isArray(input) ? input : [input];
      return values.map(() => [0.1, 0.2, 0.3]);
    }
  };
  const migrated = await migrateLegacyLivingMemory({
    sourceFile,
    targetFile,
    reembed: true,
    embeddingConfig: { enabled: true, model: 'BAAI/bge-m3', dimensions: 3, timeoutMs: 1000, recallTimeoutMs: 500, vectorScanLimit: 100 },
    embedder
  });
  assert.equal(migrated.imported.memories, 1);
  assert.equal(migrated.imported.turns, 1);
  assert.equal(migrated.reindex.ready, 1);

  const store = new LivingMemoryStore({ file: targetFile });
  const memory = store.getMemory('m-legacy');
  assert.equal(memory.createdAt, 1700000000000);
  assert.equal(memory.updatedAt, 1700001000000);
  assert.equal(memory.vectorStatus, 'ready');
  assert.equal(memory.vectorDimensions, 3);
  assert.equal(store.stats().turns, 1);
  store.close();

  const rerun = await migrateLegacyLivingMemory({ sourceFile, targetFile });
  assert.equal(rerun.imported.memories, 0);
  assert.equal(rerun.skipped.existingMemories, 1);
  assert.equal(rerun.imported.turns, 0);
});
