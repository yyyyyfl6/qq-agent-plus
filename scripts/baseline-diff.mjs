#!/usr/bin/env node
// Windows 基线治理：把失败用例名单与入库基线（test/baseline-failures.json）比对，
// 只对**新失败**红 —— 历史环境失败（更新器/部署/Docker/pilot 一片）不再掩盖回归。
// 用法：
//   node scripts/baseline-diff.mjs <spec输出文件>          # 比对并退出 0/1
//   node scripts/baseline-diff.mjs --update <spec输出文件>  # 把当前失败名单写进基线
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'test', 'baseline-failures.json');

const args = process.argv.slice(2);
const update = args[0] === '--update';
const reportFile = update ? args[1] : args[0];
if (!reportFile) {
  console.error('用法: node scripts/baseline-diff.mjs [--update] <spec-report-file>');
  process.exit(2);
}
const report = fs.readFileSync(reportFile, 'utf8');
// spec 报告里失败行形如 “✖ 名称 (123ms)”，去掉时长与前后空白；忽略汇总段的“failing tests:”
const failures = [...report.matchAll(/^✖ (.+?) \([\d.]+m?s\)$/gm)]
  .map((m) => m[1].trim())
  .filter((name) => name && !name.startsWith('failing tests'));
const current = [...new Set(failures)].sort();

const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  : { note: '', failures: [] };
const known = new Set(baseline.failures || []);

if (update) {
  fs.writeFileSync(BASELINE, `${JSON.stringify({ note: '更新：node scripts/baseline-diff.mjs --update <报告>', failures: current }, null, 2)}\n`);
  console.log(`基线已更新：${current.length} 条已知失败`);
  process.exit(0);
}

const fresh = current.filter((name) => !known.has(name));
const fixed = (baseline.failures || []).filter((name) => !current.includes(name));
if (fresh.length) {
  console.error(`新失败 ${fresh.length} 条（基线外）：`);
  for (const name of fresh) console.error(`  + ${name}`);
  process.exit(1);
}
console.log(`失败 ${current.length} 条全部在基线内（基线 ${known.size} 条）`);
if (fixed.length) {
  console.log(`其中 ${fixed.length} 条基线用例这次已经通过，可以 --update 收缩基线：`);
  for (const name of fixed) console.error(`  - ${name}`);
}
