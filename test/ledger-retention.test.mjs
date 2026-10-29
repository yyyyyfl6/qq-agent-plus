// 台账保留期每日调度（src/core/ledger-retention.js）的回归用例。
//
// 这个模块存在的理由：几本台账的保留期 DELETE 原来只在各自构造函数（＝进程启动）里跑一次，
// 服务连续运行 21 天 = 等于没执行（2026-10-09 全项目审查发现）。钉住三件事：
// 同日闸门、跨日执行一次、单台账失败不拖累其余也不在当天重试风暴。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createDailyRetentionScheduler } = await import('../src/core/ledger-retention.js');

const SILENT = { error: () => {} };

test('同日闸门：构造当天不执行，跨日才执行一次，每个 target 各调一次', () => {
  let nowMs = Date.parse('2026-10-09T10:00:00+08:00');
  const calls = [];
  const scheduler = createDailyRetentionScheduler({
    targets: [
      { name: 'A', run: () => calls.push('A') },
      { name: 'B', run: () => calls.push('B') }
    ],
    nowFn: () => nowMs,
    log: SILENT
  });
  assert.equal(scheduler.runDue(), false, '构造那一刻＝启动时各构造函数据清过一轮，当天不再重复执行');
  nowMs += 60 * 60 * 1000;          // 同日 +1 小时
  assert.equal(scheduler.runDue(), false);
  assert.deepEqual(calls, [], '同日不该碰任何台账');
  nowMs += 24 * 60 * 60 * 1000;     // 跨上海日界
  assert.equal(scheduler.runDue(), true);
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(scheduler.runDue(), false, '同一天第二次不再执行（闸门先置位）');
  assert.deepEqual(calls, ['A', 'B']);
});

test('单个台账失败不向上抛、不拖累其余，也不在同日重试风暴，次日再试', () => {
  let nowMs = Date.parse('2026-10-09T10:00:00+08:00');
  const calls = [];
  const errors = [];
  const scheduler = createDailyRetentionScheduler({
    targets: [
      { name: '坏台账', run: () => { throw new Error('disk full'); } },
      { name: '好台账', run: () => calls.push('ok') }
    ],
    nowFn: () => nowMs,
    log: { error: (...args) => errors.push(args.join(' ')) }
  });
  nowMs += 24 * 60 * 60 * 1000;
  assert.equal(scheduler.runDue(), true, '失败也要推进闸门：不能在同一 tick 里重试风暴');
  assert.deepEqual(calls, ['ok'], '一个台账炸了，后面的照跑');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /坏台账/, '失败要记日志（控制器/运维看得见）');
  assert.equal(scheduler.runDue(), false, '同日不再重试');
  nowMs += 24 * 60 * 60 * 1000;
  assert.equal(scheduler.runDue(), true, '下一天继续尝试');
  assert.deepEqual(calls, ['ok', 'ok']);
});

test('start/stop：可重复 start 不叠加、stop 可重入且真的清掉定时器', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let nowMs = Date.parse('2026-10-09T10:00:00+08:00');
  let calls = 0;
  const scheduler = createDailyRetentionScheduler({
    targets: [{ name: 'A', run: () => { calls++; } }],
    intervalMs: 60 * 60 * 1000,
    nowFn: () => nowMs,
    log: SILENT
  });
  scheduler.start();
  scheduler.start();                 // 重复 start 不能叠加第二个 interval
  scheduler.stop();
  scheduler.stop();                  // stop 必须可重入
  nowMs += 24 * 60 * 60 * 1000;
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(calls, 0, 'stop 后不能再有残留定时器触发清理');

  scheduler.start();                 // stop 之后还能重新启动
  nowMs += 24 * 60 * 60 * 1000;
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(calls, 1, '重新 start 后跨日应执行一次');
  scheduler.stop();
});
