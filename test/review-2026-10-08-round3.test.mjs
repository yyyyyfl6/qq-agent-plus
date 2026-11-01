// 2026-10-08 二轮（下午）全面审查里修掉的那批**核心层**缺陷的行为用例。
// 只放"能走真链路断言行为"的；纯源码锚点在同日的 ui-review-fixes 文件里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

const { chatAllowed } = await import('../src/core/access.js');

test('名单字段形状坏掉（字符串/对象/数字）时不许抛：抛一次等于机器人从此不吭声', () => {
  // chatAllowed 在每条消息的进路上（canRun → onIncoming/scheduleWake/#wake）。
  // 旧实现直接对 cfg.allow.groups 调 .map()：手改 config.json 或 POST 一个字符串进来，
  // 之后每条消息都在这里 TypeError，机器人静默不回应（2026-10-08 二轮审查）。
  const bad = [
    { allow: { groups: '123' } },
    { allow: { groups: 123 } },
    { allow: { groups: { a: 1 } } },
    { deny: { groups: '123' }, allow: { groups: ['123'] } },
    { deny: { private: true }, allow: { private: ['9'] } }
  ];
  for (const cfg of bad) {
    assert.doesNotThrow(() => chatAllowed('group:123', cfg), `坏形状不该抛：${JSON.stringify(cfg)}`);
    assert.doesNotThrow(() => chatAllowed('private:9', cfg));
  }
  // 坏形状按"空名单"处理：配合 allowAllWhenEmpty 的既有语义
  assert.equal(chatAllowed('group:123', { allow: { groups: '123' }, allowAllWhenEmpty: false }), false,
    '名单坏掉时不能当成"允许一切"');
  // 正常形状照旧
  assert.equal(chatAllowed('group:123', { allow: { groups: ['123'] } }), true);
  assert.equal(chatAllowed('group:124', { allow: { groups: ['123'] } }), false);
  assert.equal(chatAllowed('group:123', { deny: { groups: ['123'] }, allow: { groups: ['123'] } }), false,
    'deny 优先');
});

test('未读扫描窗口与 claimUnread 的领取上限必须同一个数（否则降级时会回没被 @ 的群）', () => {
  // 这条是**跨文件**的不变量：编排器的判定窗口（#unreadScanLimit）与 store 实际能领多少
  // 必须一致。旧实现窗口 = max(100, batchLimit)，而 claimUnread 内部夹在 100 —— batchLimit
  // 手改成 300 时，degrade 闸门能看见第 101 条之后的 @、判"可以回"，而真正领到的 100 条里
  // 没有 @（2026-10-08 二轮审查）。
  //
  // 为什么不用行为用例钉：那条路要"闸门穿过 + 档位决定要回"才会露出差别，而"决定不回"的分支
  // 会把已领的批次还原成未读 —— 试过三种断言（模型调用次数 / 消息是否被读 / 未读条数）在变异
  // （把窗口改回 max）下都依然是绿的，属于"绿得没有信息量"的用例，所以这里退成不变量断言。
  const orch = read('src/core/orchestrator.js');
  const store = read('src/core/store.js');
  const win = /#unreadScanLimit\(\)\s*\{[\s\S]{0,200}?Math\.min\(100,\s*Math\.max\(1,/.exec(orch);
  assert.ok(win, '#unreadScanLimit 要把窗口夹在 100 以内（与 claimUnread 的领取上限同口径）');
  assert.equal(/Math\.max\(100,\s*Number\(getConfig\(\)\.store\?\.batchLimit\)/.test(orch), false,
    '不许再用 max(100, batchLimit)：窗口比实际领取的大，判定就会看见"批外"的消息');
  assert.ok(/peekUnread\(chatKey,\s*Math\.min\(100,\s*Math\.max\(1,\s*limit\)\)\)/.test(store),
    'claimUnread 的领取上限仍是 100（改了这里要同步改窗口）');
});
