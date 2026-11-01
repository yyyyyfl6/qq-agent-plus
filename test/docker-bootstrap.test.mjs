// 容器启动引导：配置生成、令牌、环境变量覆盖、坏配置与不可写目录。
// 这些用例不依赖 Docker：引导脚本本身是纯 Node，先把它能测的边界钉住，
// 真正的镜像行为由 scripts/docker-smoke.sh（需要 Docker）验证。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyBootstrapEnv,
  bootstrap,
  writableError,
  DEFAULT_ONEBOT_HTTP,
  DEFAULT_ONEBOT_WS,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT
} from '../scripts/docker-bootstrap.mjs';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-docker-boot-'));
  tmpDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('空配置：容器默认绑定 0.0.0.0、生成 URL 安全令牌、OneBot 指向 compose 服务名', () => {
  const config = {};
  const result = applyBootstrapEnv(config, {}, { now: 1 });
  assert.equal(result.tokenSource, 'generated');
  assert.match(result.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(config.server.host, DEFAULT_SERVER_HOST);
  assert.equal(config.server.port, DEFAULT_SERVER_PORT);
  assert.equal(config.server.token, result.token);
  assert.equal(config.onebot.wsUrl, DEFAULT_ONEBOT_WS);
  assert.equal(config.onebot.httpUrl, DEFAULT_ONEBOT_HTTP);
  assert.deepEqual(result.warnings, []);
});

test('已有配置：保留用户字段，只覆盖显式提供的环境变量', () => {
  const config = {
    server: { host: '127.0.0.1', port: 4000, token: 'stored-token' },
    onebot: { wsUrl: 'ws://127.0.0.1:3391', httpUrl: 'http://127.0.0.1:3390' },
    persona: { botName: '保留我' },
    api: { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm' }
  };
  const result = applyBootstrapEnv(config, {
    QQ_AGENT_SERVER_PORT: '4321',
    QQ_AGENT_ONEBOT_WS_URL: 'ws://snowluma:3001',
    QQ_AGENT_ONEBOT_HTTP_URL: 'http://snowluma:3000'
  }, { now: 1 });
  assert.equal(result.tokenSource, 'config');
  assert.equal(config.server.token, 'stored-token');
  assert.equal(config.server.host, DEFAULT_SERVER_HOST);
  assert.equal(config.server.port, 4321);
  assert.equal(config.onebot.wsUrl, 'ws://snowluma:3001');
  assert.equal(config.onebot.httpUrl, 'http://snowluma:3000');
  assert.equal(config.persona.botName, '保留我');
  assert.equal(config.api.model, 'm');
});

test('环境变量令牌只在首次播种，不覆盖配置里的已有令牌', () => {
  const config = {};
  const first = applyBootstrapEnv(config, { QQ_AGENT_CONSOLE_TOKEN: 'from-env' });
  assert.equal(first.tokenSource, 'env');
  assert.equal(config.server.token, 'from-env');

  // 模拟用户在控制台轮换了令牌：重启时环境变量不该把它顶回去
  config.server.token = 'rotated-in-console';
  const second = applyBootstrapEnv(config, { QQ_AGENT_CONSOLE_TOKEN: 'from-env' });
  assert.equal(second.tokenSource, 'config');
  assert.equal(config.server.token, 'rotated-in-console');
  assert.ok(second.warnings.some((line) => line.includes('QQ_AGENT_CONSOLE_TOKEN')));

  // 显式强制才覆盖
  const forced = applyBootstrapEnv(config, { QQ_AGENT_CONSOLE_TOKEN: 'forced', QQ_AGENT_FORCE_ENV: '1' });
  assert.equal(forced.tokenSource, 'env');
  assert.equal(config.server.token, 'forced');
});

test('OneBot 地址：裸机回环地址可被容器地址替换，用户自定义地址保留', () => {
  const migrated = {
    onebot: { wsUrl: 'ws://127.0.0.1:3391', httpUrl: 'http://127.0.0.1:3390' }
  };
  applyBootstrapEnv(migrated, {
    QQ_AGENT_ONEBOT_WS_URL: 'ws://snowluma:3001',
    QQ_AGENT_ONEBOT_HTTP_URL: 'http://snowluma:3000'
  });
  assert.equal(migrated.onebot.wsUrl, 'ws://snowluma:3001');
  assert.equal(migrated.onebot.httpUrl, 'http://snowluma:3000');

  const custom = {
    onebot: { wsUrl: 'ws://my-protocol:4001', httpUrl: 'https://my-protocol:4000' }
  };
  applyBootstrapEnv(custom, {
    QQ_AGENT_ONEBOT_WS_URL: 'ws://snowluma:3001',
    QQ_AGENT_ONEBOT_HTTP_URL: 'http://snowluma:3000'
  });
  assert.equal(custom.onebot.wsUrl, 'ws://my-protocol:4001');
  assert.equal(custom.onebot.httpUrl, 'https://my-protocol:4000');
});

test('只读卷错误按 EROFS 分流，不再让用户去 chown', () => {
  const error = writableError('/data', { code: 'EROFS' });
  assert.match(error.message, /只读/);
  assert.doesNotMatch(error.message, /chown/);
  const denied = writableError('/data', { code: 'EACCES' });
  assert.match(denied.message, /chown -R 1000:1000/);
});

test('回环地址绑定给出可操作警告（容器里端口映射进不来）', () => {
  const result = applyBootstrapEnv({}, { QQ_AGENT_SERVER_HOST: '127.0.0.1' }, { now: 1 });
  assert.ok(result.warnings.some((line) => line.includes('端口映射')));
});

test('模型环境变量只在配置为空时播种；FORCE 才覆盖', () => {
  const config = { api: { baseUrl: 'https://old.test', apiKey: 'old-key', model: 'old-model' } };
  const seeded = applyBootstrapEnv(config, {
    QQ_AGENT_API_BASE_URL: 'https://new.test',
    QQ_AGENT_API_KEY: 'new-key',
    QQ_AGENT_API_MODEL: 'new-model'
  });
  assert.equal(config.api.baseUrl, 'https://old.test');
  assert.equal(config.api.apiKey, 'old-key');
  assert.equal(config.api.model, 'old-model');
  assert.ok(seeded.warnings.some((line) => line.includes('QQ_AGENT_API_BASE_URL')));

  applyBootstrapEnv(config, {
    QQ_AGENT_API_BASE_URL: 'https://new.test',
    QQ_AGENT_API_KEY: 'new-key',
    QQ_AGENT_API_MODEL: 'new-model',
    QQ_AGENT_FORCE_ENV: '1'
  });
  assert.deepEqual(
    { baseUrl: config.api.baseUrl, apiKey: config.api.apiKey, model: config.api.model },
    { baseUrl: 'https://new.test', apiKey: 'new-key', model: 'new-model' }
  );

  const empty = {};
  applyBootstrapEnv(empty, {
    QQ_AGENT_API_BASE_URL: 'https://new.test',
    QQ_AGENT_API_KEY: 'new-key',
    QQ_AGENT_API_MODEL: 'new-model'
  });
  assert.deepEqual(
    { baseUrl: empty.api.baseUrl, apiKey: empty.api.apiKey, model: empty.api.model },
    { baseUrl: 'https://new.test', apiKey: 'new-key', model: 'new-model' }
  );
});

test('bootstrap：首次写盘、二次运行不重复生成令牌', () => {
  const dir = tmpDir();
  const first = bootstrap({ dataDir: dir, env: {}, now: 1 });
  assert.equal(first.created, true);
  assert.equal(first.changed, true);
  assert.equal(first.tokenSource, 'generated');
  const configPath = path.join(dir, 'config.json');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.server.token, first.token);
  assert.equal(saved.server.host, DEFAULT_SERVER_HOST);
  // 令牌默认不进日志：访问信息落盘 0600，用户用 docker exec cat 查看
  assert.match(first.accessFile, /console-access\.txt$/);
  const access = fs.readFileSync(first.accessFile, 'utf8');
  assert.match(access, new RegExp(`Token: ${first.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.accessFile).mode & 0o777, 0o600);

  const second = bootstrap({ dataDir: dir, env: {}, now: 2 });
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal(second.tokenSource, 'config');
  assert.equal(second.token, first.token);
});

test('bootstrap：坏 config.json 先备份再按默认启动，不覆盖原件', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{ 这不是 JSON');
  const result = bootstrap({ dataDir: dir, env: {}, now: 123 });
  assert.match(result.brokenBackup, /config\.json\.broken-123$/);
  assert.equal(fs.readFileSync(result.brokenBackup, 'utf8'), '{ 这不是 JSON');
  assert.ok(fs.existsSync(configPath));
});

test('bootstrap：数据目录不可写时给出宿主机修法', () => {
  const dir = tmpDir();
  const fileAsDir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x');
  assert.throws(
    () => bootstrap({ dataDir: path.join(fileAsDir, 'data'), env: {}, now: 1 }),
    /数据目录不可写/
  );
  assert.throws(
    () => bootstrap({ dataDir: path.join(fileAsDir, 'data'), env: {}, now: 1 }),
    /chown -R 1000:1000/
  );
});

test('bootstrap：环境变量只播种一次；FORCE 才覆盖已有值', () => {
  const dir = tmpDir();
  bootstrap({ dataDir: dir, env: { QQ_AGENT_CONSOLE_TOKEN: 'first' }, now: 1 });
  const second = bootstrap({
    dataDir: dir,
    env: { QQ_AGENT_CONSOLE_TOKEN: 'second' },
    now: 2
  });
  assert.equal(second.tokenSource, 'config', '已有令牌时环境变量不应覆盖');
  let saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.server.token, 'first');
  assert.ok(second.warnings.some((line) => line.includes('QQ_AGENT_CONSOLE_TOKEN')));

  const forced = bootstrap({
    dataDir: dir,
    env: { QQ_AGENT_CONSOLE_TOKEN: 'third', QQ_AGENT_FORCE_ENV: '1' },
    now: 3
  });
  assert.equal(forced.tokenSource, 'env');
  saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.server.token, 'third');
});

test('全新 Docker 配置默认 active；显式 observe 才观察', () => {
  const dir = tmpDir();
  const fresh = bootstrap({ dataDir: dir, env: {}, now: 1 });
  let saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.runtime.mode, 'active');
  assert.equal(fresh.runtimeMode, 'active');

  const dir2 = tmpDir();
  bootstrap({ dataDir: dir2, env: { QQ_AGENT_RUNTIME_MODE: 'observe' }, now: 1 });
  saved = JSON.parse(fs.readFileSync(path.join(dir2, 'config.json'), 'utf8'));
  assert.equal(saved.runtime.mode, 'observe');
});

test('已有配置里用户选的 observe 不会被重启覆盖', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ runtime: { mode: 'observe' } }));
  const result = bootstrap({ dataDir: dir, env: {}, now: 1 });
  assert.equal(result.runtimeMode, 'observe');
});

test('从 SnowLuma 配置同步 OneBot 令牌；环境变量优先', () => {
  const root = tmpDir();
  const snowDir = path.join(root, 'snowluma-config');
  fs.mkdirSync(snowDir, { recursive: true });
  fs.writeFileSync(path.join(snowDir, 'onebot.json'), JSON.stringify({
    networks: {
      httpServers: [{ accessToken: 'snow-token' }],
      wsServers: [{ accessToken: 'snow-token' }]
    }
  }));

  const dataDir = path.join(root, 'data');
  const result = bootstrap({
    dataDir,
    env: { QQ_AGENT_SNOWLUMA_CONFIG_DIR: snowDir, QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS: '0' },
    now: 1
  });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.onebot.accessToken, 'snow-token');
  assert.equal(saved.onebot.httpAccessToken, 'snow-token');
  assert.equal(result.onebotTokenSource, 'snowluma');

  // 旧配置里的过期令牌要被 SnowLuma 当前令牌替换
  const dataDir2 = path.join(root, 'data2');
  fs.mkdirSync(dataDir2, { recursive: true });
  fs.writeFileSync(path.join(dataDir2, 'config.json'), JSON.stringify({
    onebot: { accessToken: 'stale-token', httpAccessToken: 'stale-token' }
  }));
  bootstrap({
    dataDir: dataDir2,
    env: { QQ_AGENT_SNOWLUMA_CONFIG_DIR: snowDir, QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS: '0' },
    now: 1
  });
  const saved2 = JSON.parse(fs.readFileSync(path.join(dataDir2, 'config.json'), 'utf8'));
  assert.equal(saved2.onebot.accessToken, 'snow-token');

  // 显式环境变量优先于 SnowLuma
  const dataDir3 = path.join(root, 'data3');
  const result3 = bootstrap({
    dataDir: dataDir3,
    env: {
      QQ_AGENT_SNOWLUMA_CONFIG_DIR: snowDir,
      QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS: '0',
      QQ_AGENT_ONEBOT_ACCESS_TOKEN: 'env-token',
      QQ_AGENT_ONEBOT_HTTP_TOKEN: 'env-token'
    },
    now: 1
  });
  const saved3 = JSON.parse(fs.readFileSync(path.join(dataDir3, 'config.json'), 'utf8'));
  assert.equal(saved3.onebot.accessToken, 'env-token');
  assert.equal(result3.onebotTokenSource, 'env');
});
