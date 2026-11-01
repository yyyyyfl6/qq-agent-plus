// 主题切换的圆形波纹（ui/core/theme-transition.js）。
//
// 这段的价值全在"边界"上：动效被关掉时不能白等一次过渡、浏览器不支持时要直切、
// 上一次过渡还在跑时不能把用户的第二次点击吞掉。三条都只有跑起来才看得见，
// 所以这里搭一个最小的 window/document 假环境，把三种情形都过一遍。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applyWithReveal, motionDisabled, revealOrigin } = await import('../ui/core/theme-transition.js');

/** 装一个假的浏览器环境（只提供这段代码真正用到的那几样）。 */
function fakeBrowser({ motion = '', reduceMedia = false, withVT = true, viewport = [1000, 500], skipUpdate = false, deferUpdate = true } = {}) {
  const vars = new Map();
  const calls = [];
  const style = {
    setProperty: (k, v) => vars.set(k, String(v)),
    getPropertyValue: (k) => vars.get(k) || ''
  };
  const dataset = motion ? { motion } : {};
  const document = {
    documentElement: { style, dataset },
    startViewTransition: undefined
  };
  const window = {
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    matchMedia: () => ({ matches: reduceMedia, addEventListener() {} })
  };
  // finished 由测试自己决定何时 settle（要测"上一次还在跑"就得让它挂着）
  const settle = [];
  if (withVT) {
    document.startViewTransition = (cb) => {
      calls.push(cb);
      let done;
      const finished = new Promise((res) => { done = res; });
      settle.push(() => done());
      // skipUpdate 模拟"上一次过渡还没结束就来了新的一次" —— 浏览器会跳过这一次，
      // 此时 updateCallbackDone 是 rejected（而回调有可能一次都不跑）。
      const updateCallbackDone = skipUpdate
        ? Promise.reject(new Error('skipped'))
        : new Promise((res) => { if (!deferUpdate) res(); else settle.push(() => res()); });
      return { finished, ready: Promise.resolve(), updateCallbackDone };
    };
  }
  globalThis.window = window;
  globalThis.document = document;
  return {
    document, window, vars, calls,
    /** 释放"忙"标记：模块是单例状态，开过波纹的用例必须收尾，否则会污染后面几条。 */
    async release() { for (const fn of settle.splice(0)) fn(); await new Promise((r) => setTimeout(r, 0)); },
    restore: () => { delete globalThis.window; delete globalThis.document; }
  };
}

test('revealOrigin：优先用指针落点，半径取到视口四角的最远距离', () => {
  const env = fakeBrowser({ viewport: [1000, 500] });
  try {
    const o = revealOrigin({ clientX: 100, clientY: 200, detail: 1 });
    assert.deepEqual([o.x, o.y], [100, 200]);
    // 远角是 (1000, 500) → dx=900, dy=300 → hypot≈948.68 → ceil 949
    assert.equal(o.r, Math.ceil(Math.hypot(900, 300)));
    // 落点在角上时半径 = 视口对角线
    assert.equal(revealOrigin({ clientX: 0, clientY: 0, detail: 1 }).r, Math.ceil(Math.hypot(1000, 500)));
    assert.equal(revealOrigin({ clientX: 1000, clientY: 500, detail: 1 }).r, Math.ceil(Math.hypot(1000, 500)));
  } finally { env.restore(); }
});

test('revealOrigin：键盘触发的 click（坐标是 0 但不是"落在左上角"）退回元素中心', () => {
  const env = fakeBrowser({ viewport: [1000, 500] });
  try {
    const el = { getBoundingClientRect: () => ({ left: 200, top: 100, width: 80, height: 40 }) };
    // 键盘按 Enter/Space 触发的 click：clientX/clientY 都是 0、detail 是 0
    const kb = revealOrigin({ clientX: 0, clientY: 0, detail: 0, currentTarget: el });
    assert.deepEqual([kb.x, kb.y], [240, 120], 'detail=0 表示"这次交互没有位置"，要用元素中心，不能从屏幕角落扩散');
    // 真实指针点在最左上角（detail=1）：那就是 0,0，不该被当成"没有坐标"
    const corner = revealOrigin({ clientX: 0, clientY: 0, detail: 1, currentTarget: el });
    assert.deepEqual([corner.x, corner.y], [0, 0]);
  } finally { env.restore(); }
});

test('revealOrigin：键盘触发（没坐标）用触发元素的中心；什么都没有就用视口中心', () => {
  const env = fakeBrowser({ viewport: [1000, 500] });
  try {
    const el = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 20 }) };
    assert.deepEqual(
      (() => { const o = revealOrigin({ currentTarget: el }); return [o.x, o.y]; })(),
      [30, 30], '元素中心 = left + width/2, top + height/2'
    );
    const center = revealOrigin(null);
    assert.deepEqual([center.x, center.y], [500, 250], '没坐标没元素就从视口中心扩散');
  } finally { env.restore(); }
});

test('动效被关掉时直切：不设置变量、不调用 View Transition', () => {
  for (const opts of [
    { motion: 'off' }, { motion: 'reduced' }, { reduceMedia: true }
  ]) {
    const env = fakeBrowser(opts);
    try {
      assert.equal(motionDisabled(), true, `${JSON.stringify(opts)} 下应当判定为"不动效"`);
      let applied = 0;
      const used = applyWithReveal(() => { applied++; }, { clientX: 1, clientY: 1, detail: 1 });
      assert.equal(used, false, '被关掉时要返回 false（直切）');
      assert.equal(applied, 1, '切换本身必须照常发生');
      assert.equal(env.calls.length, 0, '不许调用 startViewTransition');
      assert.equal(env.vars.size, 0, '不许写 --vt-* 变量');
    } finally { env.restore(); }
  }
});

test('浏览器不支持 View Transition 时直切（不报错）', () => {
  const env = fakeBrowser({ withVT: false });
  try {
    let applied = 0;
    assert.equal(applyWithReveal(() => { applied++; }, { clientX: 5, clientY: 5, detail: 1 }), false);
    assert.equal(applied, 1);
    assert.equal(env.vars.size, 0);
  } finally { env.restore(); }
});

test('支持且允许动效时：写好 --vt-* 再把它交给 startViewTransition', async () => {
  const env = fakeBrowser({ viewport: [800, 600] });
  try {
    let applied = 0;
    const used = applyWithReveal(() => { applied++; }, { clientX: 800, clientY: 600, detail: 1 });
    assert.equal(used, true);
    assert.equal(env.vars.get('--vt-x'), '800px');
    assert.equal(env.vars.get('--vt-y'), '600px');
    assert.equal(env.vars.get('--vt-r'), `${Math.ceil(Math.hypot(800, 600))}px`);
    assert.equal(env.calls.length, 1, '应当交给 startViewTransition 一次');
    assert.equal(applied, 0, '回调由浏览器在取快照时调用，此刻还没跑');
    env.calls[0]();            // 模拟浏览器调用回调
    assert.equal(applied, 1, '回调里要真正执行外观变更');
  } finally { await env.release(); env.restore(); }
});

test('上一次过渡还没结束时的第二次调用：直切，不把用户的操作吞掉', async () => {
  const env = fakeBrowser();
  try {
    let first = 0;
    assert.equal(applyWithReveal(() => { first++; }, { clientX: 10, clientY: 10, detail: 1 }), true);
    assert.equal(first, 0, '第一次走动画（回调还没被调用）');
    let second = 0;
    assert.equal(applyWithReveal(() => { second++; }, { clientX: 20, clientY: 20, detail: 1 }), false, '第二次不能再开一次过渡');
    assert.equal(second, 1, '但第二次的变更必须立刻生效');
    assert.equal(env.calls.length, 1, 'startViewTransition 只被调用过一次');
    // 收尾：把"忙"标记放掉，否则这条用例会把状态带进后面几条（模块级单例）
    await env.release();
    let third = 0;
    assert.equal(applyWithReveal(() => { third++; }, { clientX: 30, clientY: 30, detail: 1 }), true, '释放之后又能走动画了');
    assert.equal(third, 0);
    assert.equal(env.calls.length, 2);
  } finally { await env.release(); env.restore(); }
});

test('非函数入参不炸：静默返回 false', () => {
  const env = fakeBrowser();
  try {
    assert.equal(applyWithReveal(null, null), false);
    assert.equal(applyWithReveal(undefined), false);
  } finally { env.restore(); }
});

test('过渡被浏览器跳过一次时，外观变更照样落地（不许"点了没反应"）', async () => {
  const env = fakeBrowser({ skipUpdate: true });
  try {
    let applied = 0;
    const used = applyWithReveal(() => { applied++; }, { clientX: 10, clientY: 10, detail: 1 });
    assert.equal(used, true, '仍然是"走了过渡"这条路径');
    // updateCallbackDone 已 rejected → 兜底分支应当立刻补上这次变更
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(applied, 1, '浏览器跳过过渡时必须由兜底补上，否则用户点了没反应');
    // 而且只补一次（applyAppearance 幂等，但重复调用没必要）
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(applied, 1, '兜底不该反复执行');
  } finally { await env.release(); env.restore(); }
});

test('回调没被调用时，兜底计时器最后一定会把变更补上', async () => {
  const env = fakeBrowser({ deferUpdate: false });
  try {
    let applied = 0;
    // 故意让 stub 一次性解析完 updateCallbackDone，但从不调用回调 —— 模拟"回调丢了"
    applyWithReveal(() => { applied++; }, { clientX: 1, clientY: 1, detail: 1 });
    await new Promise((r) => setTimeout(r, 800));   // 越过 BUSY_FALLBACK_MS
    assert.equal(applied, 1, '兜底计时器必须把变更补上');
  } finally { await env.release(); env.restore(); }
});
