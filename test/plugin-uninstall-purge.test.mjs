import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';
import { installPlugin, uninstallPlugin } from '../src/plugins/install.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-uninstall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function pack() {
  return buildTar([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'demo', apiVersion: 1, name: '演示', version: '1.0.0',
        capabilities: ['tools'], tools: [{ name: 'ping', description: 'ping' }]
      })
    },
    { name: 'index.mjs', data: 'process.exit(0)\n' }
  ]);
}

async function install(dir) {
  return installPlugin({ id: 'demo', tarball: pack(), dataDir: dir, log: () => {} });
}

test('卸载默认保留 plugin-data；purgeData 才连数据与凭据一起删', async (t) => {
  const dir = tempDir(t);
  await install(dir);
  const dataDir = path.join(dir, 'plugin-data', 'demo');
  const secretFile = path.join(dir, 'plugin-secrets', 'demo.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, '{}');

  const kept = uninstallPlugin({ id: 'demo', dataDir: dir, now: () => 1000 });
  assert.equal(kept.dataPurged, false);
  assert.equal(fs.existsSync(dataDir), true);
  assert.equal(fs.existsSync(secretFile), true);

  await install(dir);
  const purged = uninstallPlugin({ id: 'demo', dataDir: dir, purgeData: true, now: () => 2000 });
  assert.equal(purged.dataPurged, true);
  assert.equal(purged.dataKept, '');
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(fs.existsSync(secretFile), false);
});

test('反复卸载只保留最近 1 份 .removed-* 残留', async (t) => {
  const dir = tempDir(t);
  for (let i = 0; i < 3; i += 1) {
    await install(dir);
    uninstallPlugin({ id: 'demo', dataDir: dir, now: () => 3000 + i });
  }
  const leftover = fs.readdirSync(path.join(dir, 'plugins'))
    .filter((name) => name.startsWith('.removed-demo.'));
  assert.equal(leftover.length, 1, leftover.join(','));
});
