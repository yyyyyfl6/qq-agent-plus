// 性格状态与关系记忆：默认关闭，开启后只影响提示词里的一两行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-state-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const {
  computePersonaState, notePersonaInteraction, personaStatePrompt, personaStateSnapshot
} = await import('../src/core/persona-state.js');
const { MemoryStore } = await import('../src/memory/memory.js');

function cfgWithHumanize(over = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.humanize = {
    ...(cfg.humanize || {}),
    enabled: true,
    personaState: { enabled: true, sleepStart: '00:00', sleepEnd: '07:00' },
    relationship: { enabled: true },
    ...over
  };
  setRuntimeConfig(cfg);
  return cfg;
}

it('状态计算：醒着掉精力，睡着回精力，活动随时间段变化', () => {
  cfgWithHumanize();
  const persona = { botName: '小鲸鱼' };
  const at = new Date('2026-10-23T10:00:00+08:00').getTime();
  const prev = { energy: 70, mood: 0, updatedAt: at - 2 * 3600000 };
  const awake = computePersonaState(prev, persona, at);
  assert.equal(awake.sleeping, false);
  assert.ok(awake.energy < 70, '醒着两小时应掉精力');
  assert.match(awake.activity, /忙/);

  const night = new Date('2026-10-23T03:00:00+08:00').getTime();
  const asleep = computePersonaState({ energy: 40, mood: 0, updatedAt: night - 3600000 }, persona, night);
  assert.equal(asleep.sleeping, true);
  assert.ok(asleep.energy > 40, '睡着应回精力');
  assert.match(asleep.activity, /睡/);

  // 0 是合法体力值：不能被 `|| 65` 当成"没设置"
  const zero = computePersonaState({ energy: 0, mood: 0, updatedAt: at }, persona, at);
  assert.equal(zero.energy, 0);
});

it('提示词只输出一句状态，不暴露数值；关闭时返回空串', () => {
  cfgWithHumanize();
  const line = personaStatePrompt({ botName: '小鲸鱼' }, new Date('2026-10-23T10:00:00+08:00').getTime());
  assert.match(line, /^【你现在的状态】/);
  assert.doesNotMatch(line, /energy|mood|精力值|心情值/i);

  const cfg = cfgWithHumanize({ enabled: false });
  setRuntimeConfig(cfg);
  assert.equal(personaStatePrompt({ botName: '小鲸鱼' }), '');

  // 角色卡优先：平台不注入状态行，避免和卡定的语气/情绪打架
  cfgWithHumanize({ respectPersonaCard: true });
  assert.equal(personaStatePrompt({ botName: '小鲸鱼', behaviorProfile: 'card' }), '');
  cfgWithHumanize({ respectPersonaCard: false });
  assert.match(personaStatePrompt({ botName: '小鲸鱼', behaviorProfile: 'card' }), /【你现在的状态】/);
});

it('控制台快照：启用时给出状态，card 档标成不注入', () => {
  cfgWithHumanize();
  const snap = personaStateSnapshot({ botName: '小鲸鱼' });
  assert.equal(snap.enabled, true);
  assert.equal(snap.injected, true);
  assert.ok(typeof snap.energy === 'number');
  assert.ok(snap.activity);

  const card = personaStateSnapshot({ botName: '小鲸鱼', behaviorProfile: 'card' });
  assert.equal(card.enabled, true);
  assert.equal(card.injected, false);
  assert.equal(card.cardFirst, true);
});

it('互动会抬心情、掉精力，并落盘', () => {
  cfgWithHumanize();
  const persona = { botName: '互动测试' };
  const at = Date.now();
  const before = computePersonaState({}, persona, at);
  notePersonaInteraction(persona, { kind: 'incoming', at });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'persona-state.json'), 'utf8'));
  const stored = saved['互动测试'];
  assert.ok(stored, '状态应按人设落盘');
  const after = computePersonaState(stored, persona, at);
  assert.ok(after.mood >= before.mood, '有互动时心情不应下降');
  assert.ok(after.lastInteractionAt >= at);
  assert.ok(fs.existsSync(path.join(dir, 'persona-state.json')));
});

it('关系记忆：只更新已有印象的人，按互动次数分档', () => {
  cfgWithHumanize();
  const memory = new MemoryStore();
  memory.append('group:1', 'memberImpression', '喜欢猫，说话直接', {
    userId: '42',
    target: '阿明'
  });
  for (let i = 0; i < 6; i += 1) memory.noteInteraction('42', { at: Date.now() });
  const member = memory.getMember('group:1', '42');
  assert.equal(member.relationship.interactions, 6);
  assert.match(memory.formatForPrompt('group:1'), /关系：有点熟/);
  assert.match(memory.formatForPrompt('group:1'), /今天聊过/);

  // 记忆整理只改写印象，不能把关系计数清零
  memory.replaceMemberForConsolidation('group:1', '42', '阿明', ['喜欢猫，说话直接']);
  assert.equal(memory.getMember('group:1', '42').relationship.interactions, 6);
  assert.equal(memory.noteInteraction('999', {}), null, '陌生人不建档案');
});

it('关系记忆关闭时，提示词与升级前一致', () => {
  const cfg = cfgWithHumanize({ relationship: { enabled: false } });
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  memory.append('group:1', 'memberImpression', '喜欢猫', { userId: '42', target: '阿明' });
  memory.noteInteraction('42');
  assert.doesNotMatch(memory.formatForPrompt('group:1'), /关系：/);
});

it('角色卡优先时，关系标签也不覆盖卡定的关系', () => {
  const cfg = cfgWithHumanize();
  cfg.personaPerChat = { 'group:1': { behaviorProfile: 'card' } };
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  memory.append('group:1', 'memberImpression', '喜欢猫', { userId: '42', target: '阿明' });
  for (let i = 0; i < 6; i += 1) memory.noteInteraction('42');
  assert.doesNotMatch(memory.formatForPrompt('group:1'), /关系：/);
});
