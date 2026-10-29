// 内置人设卡切换 × 拟人化状态：正文替换、状态按 templateId 隔离、grounded 保留结构词。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-switch-humanize-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS, resolvePersona } = await import('../src/personas.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const { personaStateSnapshot, personaStatePrompt } = await import('../src/core/persona-state.js');
const { humanizeText } = await import('../src/llm/humanize.js');

function cfgFor(templateId, behaviorProfile) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.humanize = { ...cfg.humanize, enabled: true, personaState: { enabled: true }, respectPersonaCard: true };
  cfg.persona = {
    ...cfg.persona,
    botName: '小鲸鱼',
    templateId,
    roleText: PERSONAS[templateId].text,
    behaviorProfile
  };
  setRuntimeConfig(cfg);
  return cfg;
}

it('每张内置卡：正文进提示词，状态按 templateId 隔离', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    const cfg = cfgFor(id, p.behaviorProfile);
    const persona = resolvePersona(cfg, 'group:1');
    const prompt = buildSystemPrompt({ persona });
    assert.ok(prompt.includes(p.text), `${id} 的正文没有替换进提示词`);
    const snap = personaStateSnapshot(persona);
    assert.equal(snap.key, id, `${id} 的状态 key 应绑定 templateId`);
    assert.equal(snap.injected, true, `${id} 是 legacy/grounded，状态应注入`);
  }
});

it('切换卡片：从一张卡切到另一张，正文与状态 key 都跟着换', () => {
  const cfg = cfgFor('xiaojingyu', 'legacy');
  const first = resolvePersona(cfg, 'group:1');
  assert.equal(first.templateId, 'xiaojingyu');
  cfg.persona = {
    ...cfg.persona,
    templateId: 'maoniang',
    roleText: PERSONAS.maoniang.text,
    behaviorProfile: PERSONAS.maoniang.behaviorProfile
  };
  setRuntimeConfig(cfg);
  const second = resolvePersona(cfg, 'group:1');
  assert.equal(second.templateId, 'maoniang');
  assert.ok(second.roleText.includes('猫娘'));
  const prompt = buildSystemPrompt({ persona: second });
  assert.ok(prompt.includes(PERSONAS.maoniang.text));
  assert.equal(personaStateSnapshot(second).key, 'maoniang');
});

it('按群覆盖卡片：group:1 用猫娘，group:2 仍用全局卡', () => {
  const cfg = cfgFor('xiaojingyu', 'legacy');
  cfg.personaPerChat = { 'group:1': { templateId: 'maoniang' } };
  setRuntimeConfig(cfg);
  const one = resolvePersona(cfg, 'group:1');
  const two = resolvePersona(cfg, 'group:2');
  assert.equal(one.templateId, 'maoniang');
  assert.equal(two.templateId, 'xiaojingyu');
  assert.notEqual(personaStateSnapshot(one).key, personaStateSnapshot(two).key);
});

it('grounded 卡保留“首先/其次”，legacy 卡按助手腔过滤', () => {
  const grounded = humanizeText('首先，我不太想去。其次，外面在下雨。', { soft: false });
  assert.match(grounded.text, /首先/);
  assert.match(grounded.text, /其次/);
  const legacy = humanizeText('首先，我不太想去。其次，外面在下雨。', { soft: true });
  assert.doesNotMatch(legacy.text, /首先/);
  assert.doesNotMatch(legacy.text, /其次/);
});

it('card 档在 respectPersonaCard 下不注入状态', () => {
  const cfg = cfgFor('xiaojingyu', 'card');
  const persona = resolvePersona(cfg, 'group:1');
  assert.equal(personaStatePrompt(persona), '');
  assert.equal(personaStateSnapshot(persona).injected, false);
});
