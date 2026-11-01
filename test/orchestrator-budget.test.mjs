// A1 是**行为用例**（真 Orchestrator + 打桩 scheduleWake，直接断言排期次数）；
// A2 是**源码锚点**——行为写法在 orchestrator-pacing.test.mjs（走真实派发链），
// 两者验的不一样，见各自用例里的说明（2026-10-04 复审 P3：头注别以偏概全）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-a1a2-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');

/** 组一个能走到预算闸门的 Orchestrator：模型/地址/运行模式都要配上，否则 wake 更早 return。 */
function makeOrch({ onExceed = 'block', usage }) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, port: 39599 };
  cfg.runtime = { ...cfg.runtime, mode: 'active' };
  cfg.api = {
    ...cfg.api, model: 'test-model', baseUrl: 'https://api.example/v1', apiKey: 'k',
    budget: { enabled: true, dailyYuan: 0.01, onExceed }
  };
  updateConfig(cfg);
  const calls = [];
  const scheduled = [];
  const orch = new Orchestrator({
    store: {
      listChats: () => ['group:1'],
      unreadCount: () => 5,
      getChatMeta: () => ({ unread: 5, lastTs: 0 }),
      recoverExpired: () => 0,
      // Orchestrator 的兜底回收/积压排期会先问一句「这个会话是不是已经有活跃租约」
      // （2026-10-09 审查新增的闸门）。这是真 store 接口的一部分，桩也得给一个。
      hasLeasedRun: () => false,
      expireConversationThreads: () => 0
    },
    sessions: { todayUsage: () => usage },
    sender: { sendTextBatch: async () => [] },
    runAgent: async () => { calls.push(1); return { content: 'x' }; }
  });
  orch.scheduleWake = (key) => { scheduled.push(key); };
  return { orch, calls, scheduled };
}

test('A2：预算闸门豁免只给「真正人工」，paced 不是人工', async () => {
  // ⚠️ 源码锚点，不是行为用例。**试过行为写法、确认是空过的**：用一个只桩了
  // store/sessions/sender/runAgent 的 Orchestrator 调 wake()，无论闸门怎么改，
  // runAgent 的调用次数恒为 0 —— wake 在到达预算闸门之前就因为别的条件 return 了。
  // 断言恒真 = 证明不了任何事，所以退回锚点（2026-10-04 全面复审：锚点认证过
  // 「改在了另一个调用点」的假修复，所以这里写明它验的是什么、没验什么）。
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  assert.match(src, /const budgetExempt = manual && !paced;/,
    'paced 必须与 manual 区分开（否则自主节奏唤醒会绕过两道预算闸门）');
  const gates = [...src.matchAll(/budget\.onExceed === '(block|degrade)' && !(\w+)/g)];
  assert.ok(gates.length >= 2, `前置条件：两道预算闸门，实际 ${gates.length}`);
  for (const g of gates) {
    assert.equal(g[2], 'budgetExempt', `预算闸门不能按 ${g[2]} 判`);
  }
});

// A1 这条**是行为用例**：drainBacklogAfterResume 直接调 scheduleWake（已打桩），
// 断言排期次数，能真正咬住「去掉 #budgetWouldDrop 守卫」那个变异。
test('A1（行为）：「今天别再花钱」期间，恢复后排期与兜底回收都不再排唤醒', async () => {
  const { orch, scheduled } = makeOrch({ onExceed: 'block', usage: { runs: 99, estimatedYuan: 99, unpricedRuns: 0 } });
  orch.drainBacklogAfterResume();
  assert.equal(scheduled.length, 0,
    'block 期间 drainBacklogAfterResume 不排唤醒 —— 否则每 tick 建一个会话再中止、runs 计一次，永不停止');

  // 兜底回收循环那一轮（startRecoveryLoop 的 setInterval 体）用同一套判据：
  // 逐会话判「这个唤醒会不会被预算闸门丢掉」（block 全丢；degrade 丢群里没 @ 的）
  const src = fs.readFileSync('src/core/orchestrator.js', 'utf8');
  // 窗口取 1700：它是「定时器回调那一段」的长度上界，不是一条会跟着源码长大的断言。
  // 2026-10-09 给这个循环补 hasLeasedRun 闸门（附带说明注释）后旧窗口 1100 切不到预算那行了 ——
  // 那种情况下继续缩注释去迁就窗口，就是把「断言看得见这段代码」偷换成「代码别写注释」。
  const body = src.slice(src.indexOf('this.retryTimer = setInterval('), src.indexOf('this.retryTimer = setInterval(') + 1700);
  assert.match(body, /if \(this\.#budgetWouldDrop\(key\)\) continue;/,
    '兜底回收循环要逐会话挡（block 与 degrade 的空转都算）；degrade 下提到 @ 的群仍要排');

  // 反向对照：预算没超时必须照排一次 —— 否则把 drainBacklogAfterResume 整体改成 no-op，
  // 上面那条断言照样绿（2026-10-05 全审：只测单侧的用例咬不住这一种变异）。
  const okOrch = makeOrch({ onExceed: 'block', usage: { runs: 0, estimatedYuan: 0, unpricedRuns: 0 } });
  okOrch.orch.drainBacklogAfterResume();
  assert.equal(okOrch.scheduled.length, 1,
    '预算未超时要照常排唤醒（否则这条用例只剩"函数什么都不做"也能过）');
});