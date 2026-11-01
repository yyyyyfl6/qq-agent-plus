// 工作流结构护栏：每个 step 必须有 run: 或 uses:。
//
// 背景（2026-10-01 第六轮审查 P1）：release.yml 里落下一行孤儿的 `- name: Shell 脚本语法检查`
// （只有 name、没有 run），GitHub Actions 判定整份工作流非法 —— 打 tag 时 Release 出不来，
// 而这类问题本地任何门禁都看不见（eslint 不读 YAML，也没人天天 push tag 试）。
//
// 不引 YAML 依赖（本项目零构建工具的约定）：只按缩进找 `steps:` 块里的列表项，
// 逐项确认它自己有 run/uses 或块内有。**检查器本身也被下面的用例验过**（喂一段带孤儿 step
// 的样例，必须报出来），避免"护栏自己空转"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve('.');

/** 返回该份工作流里"既没有 run 也没有 uses"的 step 位置（行号从 1 起）。 */
function orphanSteps(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const problems = [];
  let stepsIndent = null;
  let itemIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const stepsKey = line.match(/^(\s*)steps:\s*(#.*)?$/);
    if (stepsKey) { stepsIndent = stepsKey[1].length; itemIndent = null; continue; }
    if (stepsIndent === null) continue;
    if (indent <= stepsIndent) { stepsIndent = null; itemIndent = null; continue; }
    if (!/^-\s+/.test(line.slice(indent))) continue;
    if (itemIndent === null) itemIndent = indent;
    if (indent !== itemIndent) continue;
    // 一个 step 的块：直到下一个同缩进列表项，或更浅的任何一行
    const block = [line];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) { block.push(next); continue; }
      const nextIndent = next.match(/^\s*/)[0].length;
      if (nextIndent < itemIndent) break;
      if (nextIndent === itemIndent && /^-\s+/.test(next.slice(nextIndent))) break;
      block.push(next);
    }
    const hasKey = /^\s*-\s+(?:run|uses):/m.test(line) || /^\s*(?:run|uses):/m.test(block.slice(1).join('\n'));
    if (!hasKey) problems.push({ line: i + 1, text: line.trim() });
    i = j - 1;
  }
  return problems;
}

test('检查器本身有效：孤儿 step 必须被抓到，正常的不能误报', () => {
  const bad = [
    'jobs:',
    '  verify:',
    '    steps:',
    '      - name: Shell 脚本语法检查',
    '      # 注释而已，没有 run',
    '      - name: 真 step',
    '        run: echo ok'
  ].join('\n');
  assert.deepEqual(orphanSteps(bad).map((p) => p.line), [4]);

  const good = [
    'jobs:',
    '  verify:',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - name: 安装',
    '        run: |',
    '          echo hi',
    '          # run: 只是正文里的字',
    '  release:',
    '    steps:',
    '      - name: 建 Release',
    '        run: gh release create v1',
    ''
  ].join('\n');
  assert.deepEqual(orphanSteps(good), []);
});

test('.github/workflows 下每个 step 都有 run: 或 uses:', () => {
  const dir = path.join(repo, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  assert.ok(files.length >= 2, `应至少有 ci.yml 与 release.yml，实际 ${files.length} 个`);
  const problems = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const p of orphanSteps(text)) problems.push(`${name}:${p.line} ${p.text}`);
  }
  assert.deepEqual(problems, [], `工作流里有 GitHub 会拒载的孤儿 step：\n${problems.join('\n')}`);
});

test('release workflow 会校验 tag 与 package.json 版本一致（打错 tag 会被挡下）', async () => {
  const fs = await import('node:fs');
  const url = new URL('../.github/workflows/release.yml', import.meta.url);
  const src = fs.readFileSync(url, 'utf8');
  assert.ok(/GITHUB_REF_NAME#v/.test(src) && /package\.json/.test(src) && /PKG_VERSION/.test(src),
    'release.yml 里要有 tag↔package.json 版本对账这一步（src/auto-update.js 按 tag 判版本）');
});
