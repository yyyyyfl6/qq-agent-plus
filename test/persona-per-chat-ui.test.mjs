// 按群人设控制台侧的守卫：入口、行结构、保存语义。
// 重点钉两件事：整份替换（才能删行）与"换卡时保留附加规则等非卡字段"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('人设页有「按群人设」区块，行按会话渲染并可选择卡', () => {
  const js = read('ui/pages/persona.js');
  assert.ok(js.includes('id="persona-per-chat"'), '要有区块锚点');
  assert.ok(js.includes('data-per-chat="${esc(key)}"'), '每行带 chatKey');
  assert.ok(js.includes('class="per-chat-select"'), '每行一个选卡下拉');
  assert.ok(js.includes('跟随全局'), '要能改回跟随全局');
  assert.ok(js.includes('聊天白名单'), '没有行时提示先去白名单添加');
});

test('保存按群人设：整份替换 + 装配逻辑走纯函数', () => {
  const save = read('ui/pages/settings-save.js');
  assert.ok(save.includes("buildPerChatPatch(rows, c.personaPerChat || {}, Object.entries(state.personaTemplates || {}), c.persona?.behaviorProfile || '')"),
    '保存要走 persona-per-chat.js 的纯函数（行为用例直接覆盖它）');
  assert.ok(save.includes('patch.personaPerChat = {'), '按群人设要单独成段提交');
  assert.ok(save.includes('__replace__'), '要用 __replace__ 才能把改回跟随全局的行删掉');
  const page = read('ui/pages/persona.js');
  assert.ok(page.includes('perChatOptions(map[key], templates)'), '选项由纯函数生成');
});
