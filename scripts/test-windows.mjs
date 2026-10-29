#!/usr/bin/env node
// Windows 单元测试门禁：跑全量 unit，用 spec 报告与基线比对。
//
// 口径（2026-10）：Windows 上只允许**显式 skip**，不允许 fail。跨平台可修的断言已经修掉，
// 真正依赖 POSIX/Linux 的用例用 test/helpers/platform.mjs 带原因跳过。基线文件应当为空；
// 任何失败都会被 baseline-diff 判红，避免"红一片"把真正的回归淹没。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitFiles = fs.readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('test', name));

const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-win-unit-'));
const reportFile = path.join(reportDir, 'spec.txt');
try {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...unitFiles], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  fs.writeFileSync(reportFile, output);
  process.stdout.write(output);

  const diff = spawnSync(process.execPath, [path.join('scripts', 'baseline-diff.mjs'), reportFile], {
    cwd: root,
    stdio: 'inherit'
  });
  let code = diff.status ?? 1;
  // spec 报告没解析出失败（例如进程直接崩了）但测试进程非零退出：不能当绿。
  if (run.status !== 0 && code === 0) {
    console.error('[test:unit:win] 测试进程非零退出，但报告里没有可解析的失败用例；按失败处理。');
    code = 1;
  }
  process.exitCode = code;
} finally {
  fs.rmSync(reportDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
