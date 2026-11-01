import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { checkSkillMarket } from '../scripts/skill-market-check.mjs';

test('official skill index is valid and local file hashes match', () => {
  const result = checkSkillMarket();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.count >= 2);
});

test('skill-pack emits an index entry with matching hashes', () => {
  const output = execFileSync(process.execPath, [
    'scripts/skill-pack.mjs', 'examples/skills/trip-planner',
    '--base-url', 'https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plus/main/examples/skills/trip-planner',
    '--author', 'qq-agent-plus', '--category', '生活', '--json'
  ], { encoding: 'utf8' });
  const entry = JSON.parse(output);
  assert.equal(entry.id, 'trip-planner');
  assert.equal(entry.files['skill.json'].sha256.length, 64);
  assert.match(entry.files['SKILL.md'].url, /trip-planner\/SKILL\.md$/);
  assert.ok(entry.preview.length > 0);
});
