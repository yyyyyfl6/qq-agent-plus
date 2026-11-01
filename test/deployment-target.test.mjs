// verify-deployment-target.mjs 测试（改进方案 C7/#3）：
// 每条规则一个用例 —— 全新安装放行、非空无记录拒绝、data/service/repository/branch/host/port
// 各自的比对与豁免、逃生开关双条件、老记录缺字段跳过。
// 变异对照：把脚本里 data 不一致的 reject 改成 ok，"data 不一致拒绝"两条用例必红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/verify-deployment-target.mjs');

function makeTree({ withMeta = false, meta = {}, extraFile = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vdt-'));
  if (withMeta) fs.writeFileSync(path.join(dir, '.deployment.json'), JSON.stringify(meta));
  if (extraFile) fs.writeFileSync(path.join(dir, 'some-file'), 'x');
  return dir;
}

function run(installDir, { meta, extraFile, env = {}, ...flags } = {}) {
  // meta/extraFile 写进 installDir 指向的目录（未传时新建一个），别再另建第二个目录
  const dir = installDir ?? makeTree();
  if (meta !== undefined) fs.writeFileSync(path.join(dir, '.deployment.json'), JSON.stringify(meta));
  else if (extraFile) fs.writeFileSync(path.join(dir, 'some-file'), 'x');
  // camelCase → kebab-case（dataDir → --data-dir；allowPathChange → --allow-path-change）
  const kebab = (k) => (k === 'allowPathChange' ? 'allow-path-change' : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
  const argv = ['--install-dir', dir];
  if (flags.dataDir === undefined) {
    argv.push('--data-dir', meta?.data ?? path.join(os.tmpdir(), `qq-vdt-data-${Math.random().toString(16).slice(2)}`));
  }
  argv.push('--service', 'qq-agent-linux');
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) continue;
    const flag = `--${kebab(k)}`;
    if (v === true) argv.push(flag);        // 布尔开关不带值
    else if (v === false) continue;         // 显式 false＝不启用
    else argv.push(flag, String(v));
  }
  const r = spawnSync(process.execPath, [script, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const RECORD = {
  root: '', // 用例里替换为实际目录
  data: '/data/qq-agent/data',
  service: 'qq-agent-linux',
  repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
  branch: 'main',
  host: '0.0.0.0',
  port: 3210,
};

test('全新安装：目录为空且无记录 → 放行', () => {
  const r = run(undefined, { dataDir: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /全新安装/);
});

test('目录非空但无记录 → 拒绝（不是本工具管理的安装）', () => {
  const r = run(undefined, { extraFile: true, dataDir: undefined });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /不是本工具管理的安装/);
});

test('记录一致（root/data/service/repository/branch/host/port 全对）→ 放行', () => {
  const dir = makeTree();
  const r = run(dir, { meta: { ...RECORD, root: dir }, repository: RECORD.repository, branch: 'main', host: '0.0.0.0', port: 3210 });
  assert.equal(r.code, 0, r.out);
});

test('data 不一致 → 拒绝 exit 2', () => {
  const dir = makeTree();
  const r = run(dir, { meta: { ...RECORD, root: dir, data: '/elsewhere' }, dataDir: '/data/other' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /数据目录与记录不一致/);
});

test('data 不一致 + 只有 --allow-path-change（缺环境变量）→ 仍拒绝', () => {
  const dir = makeTree();
  const r = run(dir, { meta: { ...RECORD, root: dir, data: '/elsewhere' }, dataDir: '/data/other', allowPathChange: true });
  assert.equal(r.code, 2, r.out);
});

test('data 不一致 + --allow-path-change + QQ_AGENT_ALLOW_PATH_CHANGE=1 → 放行并警告', () => {
  const dir = makeTree();
  const r = run(dir, {
    meta: { ...RECORD, root: dir, data: '/elsewhere' },
    dataDir: '/data/other',
    allowPathChange: true,
    env: { QQ_AGENT_ALLOW_PATH_CHANGE: '1' },
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /双条件满足/);
});

test('service 不一致 → 拒绝', () => {
  const dir = makeTree();
  const r = run(dir, { meta: { ...RECORD, root: dir }, service: 'another-agent' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /service 与记录不一致/);
});

test('repository 不一致 → 拒绝（堵"在错误源码树里跑 deploy.sh"）', () => {
  const dir = makeTree();
  const r = run(dir, {
    meta: { ...RECORD, root: dir },
    repository: 'https://github.com/someone/else.git',
    branch: 'main',
  });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /repository 与记录不一致/);
});

test('branch 不一致 → 拒绝', () => {
  const dir = makeTree();
  const r = run(dir, { meta: { ...RECORD, root: dir }, repository: RECORD.repository, branch: 'dev' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /branch 与记录不一致/);
});

test('老记录缺 branch/repository → 跳过比对并放行', () => {
  const dir = makeTree();
  const legacy = { root: dir, data: '/data/qq-agent/data', service: 'qq-agent-linux' };
  const r = run(dir, { meta: legacy, repository: RECORD.repository, branch: 'main' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /记录缺字段/);
});

test('host/port 漂移 → 只警告不拒绝（真相源是 config.json）', () => {
  const dir = makeTree();
  const r = run(dir, { meta: { ...RECORD, root: dir }, repository: RECORD.repository, branch: 'main', host: '127.0.0.1', port: 4000 });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /漂移/);
});

test('记录损坏（非法 JSON）→ 沿用现状口径放行 + 醒目警告', () => {
  const dir = makeTree();
  fs.writeFileSync(path.join(dir, '.deployment.json'), '{broken');
  const r = run(dir, { dataDir: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /无法解析/);
});

// ── 2026-09-30 审查 P0：deploy.sh 在调用本校验**之前**就 `mkdir -p "$INSTALL_DIR" "$DATA_DIR"`
//    （默认 --data-dir 就是 INSTALL_DIR/data），无系统 Node 时还会下到 INSTALL_DIR/.runtime。
//    这些是安装器自己的产物，不能拿它们当"来历不明的代码"把全新安装挡在门外。以下用例锁住修复。
test('全新安装：目录里只有安装器自建的 data/ → 放行（P0）', () => {
  const dir = makeTree();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const r = run(dir, { dataDir: path.join(dir, 'data') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /全新安装/);
});

test('全新安装：目录里只有安装器自建的 .runtime/ → 放行（P0）', () => {
  const dir = makeTree();
  fs.mkdirSync(path.join(dir, '.runtime', 'node-v22.23.2-linux-x64', 'bin'), { recursive: true });
  const r = run(dir, { dataDir: undefined });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /全新安装/);
});

test('data/ 与 .runtime/ 之外还有别的文件 → 仍然拒绝（修复不放宽来历不明的判定）', () => {
  const dir = makeTree();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mystery-notes.txt'), 'x');
  const r = run(dir, { dataDir: path.join(dir, 'data') });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /不是本工具管理的安装/);
});

// 嵌套 --data-dir（如 INSTALL_DIR/var/data）＋安装器下了 .runtime 的组合：
// 下降判定时必须把 .runtime 先滤掉，否则"var 里只有 data"也会被判成有外来文件。
// 单层 data/ 走 early-return 不受影响，所以这条组合当初漏测（2026-09-30 复审实测复现）。
test('全新安装：嵌套 --data-dir 且安装器已下 .runtime → 放行（复审抓出的漏网）', () => {
  const dir = makeTree();
  fs.mkdirSync(path.join(dir, 'var', 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.runtime', 'node-v22.23.2-linux-x64', 'bin'), { recursive: true });
  const r = run(dir, { dataDir: path.join(dir, 'var', 'data') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /全新安装/);
});

test('嵌套 --data-dir 但中间层混了别的东西 → 仍拒绝（沿用严口径）', () => {
  const dir = makeTree();
  fs.mkdirSync(path.join(dir, 'var', 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'var', 'logs'), { recursive: true });
  const r = run(dir, { dataDir: path.join(dir, 'var', 'data') });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /不是本工具管理的安装/);
});

test('就地安装（--source-root 与 --install-dir 同一目录）→ 放行（P0）', () => {
  const dir = makeTree();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const r = run(dir, { dataDir: path.join(dir, 'data'), sourceRoot: dir });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /就地安装/);
});

test('非就地且目录里有非安装器产物 → 仍拒绝（source-root 指向别处不影响原判定）', () => {
  const dir = makeTree();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const r = run(dir, { dataDir: undefined, sourceRoot: path.join(os.tmpdir(), 'some-other-tree') });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /不是本工具管理的安装/);
});

test('数据目录与安装目录相同 → 拒绝（rsync --delete 会删数据）', () => {
  const dir = makeTree();
  const r = run(dir, { dataDir: dir, meta: { ...RECORD, root: dir, data: dir } });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /数据目录不能与安装目录相同/);
});
