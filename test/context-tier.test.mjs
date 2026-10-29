// 响应概率闸门：决定"这批消息要不要回"。
//
// 语义（2026-09-22 起）：**滑条上的数字就是概率**（0~100%）——
//   0%   只回 @ 和关键词（关键词表为空时就只回 @）
//   中间 普通消息按该概率回；被 @ 或命中关键词仍一定回
//   100% 任何消息都回（全响应）
// 概率用注入的 roll 钉死，避免随机导致的假红/假绿。真实回复率做过一次性端到端实测
// （每档位独立进程、40~100 批消息统计模型调用次数；0%→0、25%→23%、50%→57%、100%→100%，
// 老配置迁移后的档位同样符合预期），那个测量脚本没进仓库，结论见对应提交说明。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// 注意 ESM 的静态 import 会先于文件体执行，所以 src 模块必须用动态 import 放在这之后。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-tier-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const { resolveContextTier } = await import('../src/llm/prompt.js');

const BASE = { atCount: 300, keywordCount: 100, randomCount: 60, allCount: 300, keywords: ['救命'] };
const entry = (text, extra = {}) => ({ text, ...extra });

test('100% = 全响应：任何消息都回', () => {
  const r = resolveContextTier({
    triggerEntries: [entry('随便说点什么')],
    cfg: { ...BASE, randomPercent: 100 },
    roll: 99
  });
  assert.equal(r.shouldRespond, true);
  assert.equal(r.reason, '全部响应');
  assert.equal(r.count, 300);
  assert.equal(r.tier, 4, '100% 要标成 4 档（触发方式展示成"全部响应"）');
});

test('0% = 只回 @ 和关键词', () => {
  const plain = resolveContextTier({
    triggerEntries: [entry('随便说点什么')], cfg: { ...BASE, randomPercent: 0 }, roll: 0
  });
  assert.equal(plain.shouldRespond, false, '0% 时普通消息不回');
  assert.equal(plain.reason, '未触发');
  assert.equal(plain.count, 0);
  assert.equal(plain.tier, 0, '未命中不该带档位');

  // 关键词表清空后，0% 就只剩 @ 能唤醒
  const noKeyword = { ...BASE, randomPercent: 0, keywords: [] };
  assert.equal(resolveContextTier({ triggerEntries: [entry('救命啊')], cfg: noKeyword, roll: 0 }).shouldRespond, false);
});

test('中间概率：掷骰子决定，边界由注入的 roll 钉死', () => {
  const cfg = { ...BASE, randomPercent: 24.3 };
  const at = (roll) => resolveContextTier({ triggerEntries: [entry('普通消息')], cfg, roll });
  assert.equal(at(0).shouldRespond, true, 'roll 在概率内 → 回');
  assert.equal(at(0).tier, 3, '按概率响应是 3 档');
  assert.equal(at(24).shouldRespond, true);
  assert.equal(at(25).shouldRespond, false, 'roll 超出概率 → 不回');
  assert.equal(at(99).shouldRespond, false);
  // 概率原样出现在 reason 里，方便排查"我设了多少"
  assert.match(at(0).reason, /24\.3%/);
});

test('拍一拍机器人也是必回（不受概率影响），拍别人不算', () => {
  const cfg = { ...BASE, randomPercent: 0 };
  const poke = { text: '[拍一拍] 你拍了拍（来自 甲）', eventKind: 'poke', targetUserId: '888' };
  const self = resolveContextTier({ triggerEntries: [poke], selfId: '888', cfg, roll: 99 });
  assert.equal(self.shouldRespond, true);
  assert.equal(self.reason, '被拍一拍');
  assert.equal(self.tier, 1);
  const other = resolveContextTier({
    triggerEntries: [{ ...poke, targetUserId: '999' }], selfId: '888', cfg, roll: 99
  });
  assert.equal(other.shouldRespond, false, '群友之间互拍不该触发机器人');
});

test('被 @ 或命中关键词一定回，不受概率影响', () => {
  const cfg = { ...BASE, randomPercent: 0 };
  const names = { selfNickname: '登录昵称', botName: '小鲸鱼', selfId: '888' };
  const at = resolveContextTier({ triggerEntries: [entry('@小鲸鱼 在吗')], ...names, cfg, roll: 100 });
  assert.equal(at.shouldRespond, true);
  assert.equal(at.reason, '被艾特');
  assert.equal(at.tier, 1);
  const kw = resolveContextTier({ triggerEntries: [entry('救命啊')], cfg, roll: 100 });
  assert.equal(kw.shouldRespond, true);
  assert.equal(kw.reason, '关键词命中');
  assert.equal(kw.tier, 2);
});

test('@ 的判定：文本认得出，也认存档里的 mentionsSelf', () => {
  const cfg = { ...BASE, randomPercent: 0 };
  const names = { selfNickname: '登录昵称', botName: '小鲸鱼', selfId: '888' };
  // 群里把名片改过：文本里是群名片，跟名字/昵称都对不上 —— 靠入库时算的 mentionsSelf 也要认
  const byFlag = resolveContextTier({
    triggerEntries: [entry('@群名片甲 在吗', { mentionsSelf: true })], ...names, cfg, roll: 100
  });
  assert.equal(byFlag.shouldRespond, true, '群名片与昵称不一致时不能漏判');
  assert.equal(byFlag.reason, '被艾特');
  // 只是文本里出现名字（没 @）不算
  assert.equal(resolveContextTier({
    triggerEntries: [entry('小鲸鱼今天怎么样')], ...names, cfg, roll: 100
  }).shouldRespond, false);
});

test('读多少条已读：由触发原因决定，各条数互相独立', () => {
  const names = { selfNickname: '小鲸鱼', botName: '小鲸鱼', selfId: '888' };
  const cfg = { ...BASE, randomPercent: 50, atCount: 5, keywordCount: 10, randomCount: 20, allCount: 50 };
  assert.equal(resolveContextTier({ triggerEntries: [entry('@小鲸鱼 在吗')], ...names, cfg, roll: 60 }).count, 5);
  assert.equal(resolveContextTier({ triggerEntries: [entry('救命啊')], cfg, roll: 60 }).count, 10);
  assert.equal(resolveContextTier({ triggerEntries: [entry('普通消息')], cfg, roll: 10 }).count, 20);
  assert.equal(resolveContextTier({ triggerEntries: [entry('普通消息')], cfg: { ...cfg, randomPercent: 100 }, roll: 99 }).count, 50);
});

test('概率没填时按全响应处理（老配置里这字段可能是 0 或缺失）', () => {
  const missing = resolveContextTier({ triggerEntries: [entry('普通消息')], cfg: { ...BASE, randomPercent: undefined }, roll: 99 });
  assert.equal(missing.shouldRespond, true, '缺字段 → 回落到全响应，跟老默认一致');
  const zero = resolveContextTier({ triggerEntries: [entry('普通消息')], cfg: { ...BASE, randomPercent: 0 }, roll: 0 });
  assert.equal(zero.shouldRespond, false, '0 是合法值：不能被当成"没填"');
});

test('conversation.pokeReplyEnabled=false：拍一拍退回普通消息，不再必回', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  updateConfig({ conversation: { pokeReplyEnabled: false } });
  try {
    const cfg = { ...BASE, randomPercent: 0 };
    const r = resolveContextTier({
      triggerEntries: [{ text: '[拍一拍] 你拍了拍', eventKind: 'poke', targetUserId: '888' }],
      selfId: '888', cfg, roll: 99
    });
    assert.equal(r.shouldRespond, false);
  } finally {
    updateConfig({ conversation: { pokeReplyEnabled: true } });
  }
});
