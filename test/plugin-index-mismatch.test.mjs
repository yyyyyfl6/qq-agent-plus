import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';
import { installPlugin, normalizePluginIndexEntry } from '../src/plugins/install.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-index-mismatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function pack({ capabilities = ['tools'], httpDomains = [] } = {}) {
  return buildTar([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'demo', apiVersion: 2, name: '演示', version: '1.0.0', entry: 'index.mjs',
        capabilities, httpDomains, tools: [{ name: 'ping', description: 'ping' }]
      })
    },
    { name: 'index.mjs', data: 'process.exit(0)\n' }
  ]);
}

test('索引归一化保留权限面字段（域名/写动作/配额/签名）', () => {
  const { ok, entry } = normalizePluginIndexEntry({
    id: 'demo', version: '1.0.0', downloadUrl: 'https://example.com/demo.tar.gz', sha256: 'a'.repeat(64),
    capabilities: ['tools', 'http'], httpDomains: ['api.example.com'],
    approvals: [{ action: 'write', label: '写一条' }], quotas: { write: 10 },
    publisher: 'alice', signature: 'sig'
  });
  assert.equal(ok, true);
  assert.deepEqual(entry.httpDomains, ['api.example.com']);
  assert.equal(entry.approvals[0].action, 'write');
  assert.equal(entry.quotas.write, 10);
  assert.equal(entry.hasWrites, true);
  assert.equal(entry.publisher, 'alice');
});

test('包声明的权限比索引更宽时拒绝安装（可用 allowIndexMismatch 显式放行）', async (t) => {
  const dir = tempDir(t);
  const indexMeta = { capabilities: ['tools'], httpDomains: ['safe.example'] };
  await assert.rejects(
    () => installPlugin({
      id: 'demo', tarball: pack({ capabilities: ['tools', 'http'], httpDomains: ['evil.example'] }),
      dataDir: dir, indexMeta, log: () => {}
    }),
    (error) => error.code === 'E_INDEX_MISMATCH'
  );
  const allowed = await installPlugin({
    id: 'demo', tarball: pack({ capabilities: ['tools', 'http'], httpDomains: ['evil.example'] }),
    dataDir: dir, indexMeta, allowIndexMismatch: true, log: () => {}
  });
  assert.equal(allowed.ok, true);
});

test('索引没写域名/能力时不做事后推断（旧条目仍可安装）', async (t) => {
  const dir = tempDir(t);
  const result = await installPlugin({
    id: 'demo', tarball: pack({ capabilities: ['tools', 'http'], httpDomains: ['x.example'] }),
    dataDir: dir, indexMeta: { capabilities: [] }, log: () => {}
  });
  assert.equal(result.ok, true);
});
