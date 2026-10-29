// 引导脚本写出的"最小配置"必须能被真实的 loadConfig 读进来：
// 如果 migrateConfig/deepMerge 依赖某些段落，容器首次启动会在应用层失败，
// 而引导脚本自己的单测仍然全绿。这条用例把两层接起来。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-docker-config-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { bootstrap } = await import('../scripts/docker-bootstrap.mjs');
const { loadConfig } = await import('../src/core/config.js');

test('容器引导写出的最小配置能被真实 loadConfig 合并出完整默认值', () => {
  const result = bootstrap({
    dataDir: dir,
    env: {
      QQ_AGENT_CONSOLE_TOKEN: 'container-token',
      QQ_AGENT_ONEBOT_WS_URL: 'ws://snowluma:3001',
      QQ_AGENT_ONEBOT_HTTP_URL: 'http://snowluma:3000'
    }
  });
  const cfg = loadConfig();
  assert.equal(cfg.server.token, 'container-token');
  assert.equal(cfg.server.host, '0.0.0.0');
  assert.equal(cfg.server.port, 3210);
  assert.equal(cfg.onebot.wsUrl, 'ws://snowluma:3001');
  assert.equal(cfg.onebot.httpUrl, 'http://snowluma:3000');
  // 全新 Docker 部署默认 active（否则配置完白名单也不会回复）
  assert.equal(cfg.runtime.mode, 'active');
  // 默认值仍然被合并进来（最小配置没有写这些段）
  assert.ok(cfg.persona && typeof cfg.persona.botName === 'string' && cfg.persona.botName.length > 0);
  assert.ok(cfg.api && typeof cfg.api === 'object');
  assert.ok(Array.isArray(cfg.allow?.groups));
  assert.equal(result.token, 'container-token');
});
