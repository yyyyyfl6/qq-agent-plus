// 按群人设保存语义的行为用例（纯函数，不搭 DOM）。
//
// 换卡时哪些字段该清、哪些该留，靠字符串断言测不出来：上一轮实现就是"看起来删了 roleText"
// 但漏了 templateId，导致选了自定义卡仍用旧内置卡的正文。这里逐序列钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildPerChatPatch, perChatOptions } = await import('../ui/pages/persona-per-chat.js');

const templates = [
  ['xiaojingyu', { name: '小鲸鱼', text: '鲸鱼正文', behaviorProfile: 'legacy', builtin: true }],
  ['maoniang', { name: '猫娘', text: '猫娘正文', behaviorProfile: 'legacy', builtin: true }],
  ['wenrou_peiliao', { name: '温柔陪聊', text: '温柔正文', behaviorProfile: 'grounded', builtin: true }],
  ['custom_0', {
    name: '自定义A', text: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的规则', builtin: false
  }],
  ['custom_1', {
    name: '自定义B', text: '自定义B正文', behaviorProfile: 'legacy', builtin: false
  }]
];

const save = (value, current = {}, key = 'group:123') => buildPerChatPatch([{ key, value }], current, templates);

test('内置卡 → 自定义卡：旧 templateId 必须清掉（否则卡文件正文会盖住自定义正文）', () => {
  const out = save('custom:custom_0', { 'group:123': { templateId: 'maoniang' } });
  assert.deepEqual(out['group:123'], { roleText: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的规则' });
});

test('自定义卡 → 内置卡：正文/档位/卡自带规则都要清掉，档位由新卡决定', () => {
  const out = save('builtin:maoniang', {
    'group:123': { roleText: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的规则' }
  });
  assert.deepEqual(out['group:123'], { templateId: 'maoniang' });
});

test('内置卡 A → 内置卡 B：显式档位/规则随卡切换，实例级偏好（名字/参与度）保留', () => {
  const out = save('builtin:wenrou_peiliao', {
    'group:123': { templateId: 'maoniang', behaviorProfile: 'legacy', customRules: '旧规则', botName: '猫猫', participation: 'high' }
  });
  assert.deepEqual(out['group:123'], { botName: '猫猫', participation: 'high', templateId: 'wenrou_peiliao' });
});

test('改回跟随全局：整条删除', () => {
  assert.deepEqual(save('', { 'group:123': { templateId: 'maoniang' } }), {});
});

test('同卡重复保存：不带旧 changedAt（时间戳由服务端维护）', () => {
  const out = save('builtin:maoniang', { 'group:123': { templateId: 'maoniang', changedAt: 111 } });
  assert.deepEqual(out['group:123'], { templateId: 'maoniang' });
});

test('同一张内置卡重复保存：该群手改的规则与显式档位不能被删掉', () => {
  const old = {
    templateId: 'maoniang',
    behaviorProfile: 'grounded',
    customRules: '这个群人比较正经，少开玩笑',
    botName: '猫猫'
  };
  assert.deepEqual(save('builtin:maoniang', { 'group:123': old }), { 'group:123': old });
});

test('同一张自定义卡重复保存：手改的附加规则保留', () => {
  const old = {
    roleText: '自定义A正文',
    behaviorProfile: 'grounded',
    customRules: '本群只聊技术',
    participation: 'low'
  };
  assert.deepEqual(save('custom:custom_0', { 'group:123': old }), { 'group:123': old });
});

test('换到另一张自定义卡：旧卡的手改规则随旧卡一起清掉', () => {
  const out = save('custom:custom_1', {
    'group:123': { roleText: '自定义A正文', behaviorProfile: 'grounded', customRules: 'A 的旧规则' }
  });
  assert.deepEqual(out['group:123'], { roleText: '自定义B正文', behaviorProfile: 'legacy' });
});

test('只有实例级字段的旧条目：给「保持」项，保存时原样保留', () => {
  const entry = { participation: 'low', botName: '阿猫' };
  const options = perChatOptions(entry, templates);
  assert.match(options, /value="keep" selected/, '界面表达不了就必须提供保持项');
  assert.equal(perChatOptions(undefined, templates).includes('value="keep"'), false, '没有覆盖时不该出现保持项');
  assert.deepEqual(save('keep', { 'group:123': entry }), { 'group:123': entry });
});

test('未知卡 id 与对不上任何卡的自定义正文：给「保持」项，不被静默清掉', () => {
  assert.match(perChatOptions({ templateId: 'gone' }, templates), /value="keep" selected/);
  assert.match(perChatOptions({ roleText: '手写正文' }, templates), /value="keep" selected/);
  assert.deepEqual(save('keep', { 'group:123': { templateId: 'gone' } }), { 'group:123': { templateId: 'gone' } });
});

test('非法 chatKey 不写入；同一个 key 只保留最后一行', () => {
  const out = buildPerChatPatch([
    { key: 'group:abc', value: 'builtin:maoniang' },
    { key: 'group:123', value: 'builtin:maoniang' },
    { key: 'group:123', value: 'builtin:xiaojingyu' }
  ], {}, templates);
  assert.deepEqual(out, { 'group:123': { templateId: 'xiaojingyu' } });
});

test('全局「角色卡优先」时，按群选自定义卡不能把该群退回卡自带档位', () => {
  const out = buildPerChatPatch(
    [{ key: 'group:123', value: 'custom:custom_0' }],
    {},
    templates,
    'card'
  );
  assert.deepEqual(out['group:123'], { roleText: '自定义A正文', customRules: 'A 的规则' },
    '不写 behaviorProfile，交给 resolvePersona 继承全局 card');
  // 全局不是 card 时仍按卡自带档位写入（旧行为不变）
  const out2 = buildPerChatPatch([{ key: 'group:123', value: 'custom:custom_0' }], {}, templates, 'legacy');
  assert.equal(out2['group:123'].behaviorProfile, 'grounded');
});
