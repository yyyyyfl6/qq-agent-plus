// 主题切换的"从点击处扩散"过渡（2026-10-08）。
//
// 参照控制台的做法（2026-10-08 实测）：换明暗/换配色时不靠 CSS transition 硬切颜色，
// 而是把整页交给 View Transitions API，再给 ::view-transition-new(root) 挂一条
//   @keyframes 从 clip-path: circle(0px at var(--vt-x) var(--vt-y))
//              到 clip-path: circle(var(--vt-r) at var(--vt-x) var(--vt-y))
// 关键帧时长 0.5s、曲线 cubic-bezier(.16,1,.3,1)（ease-out-expo）。观感是"新主题从你
// 点的地方像水波一样铺开"，比整页颜色渐变高级得多，代价只有一条 keyframes + 一行 API 调用。
//
// 这里只做三件事：算圆心与半径（--vt-x/--vt-y/--vt-r）、在动效关闭时退化成直切、
// 以及在浏览器不支持 / 上一次过渡还在跑时不把主题切换搞丢（切换本身必须成功，动画只是装饰）。
'use strict';

/** 上一次过渡是否还在跑：在跑的期间再开一次会被浏览器忽略，这时直接直切，别把用户的操作吞掉。 */
let busy = false;
/** 波纹时长（与 CSS 里 vt-reveal 的 0.5s 一致）+ 余量，作为"忙"标记的兜底解除时间。 */
const REVEAL_MS = 500;
const BUSY_FALLBACK_MS = REVEAL_MS + 200;

/** 动效是否被关掉（用户设置优先，其次跟随系统 prefers-reduced-motion）。 */
function motionDisabled() {
  const mode = document.documentElement.dataset.motion || '';
  if (mode === 'off' || mode === 'reduced') return true;
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch { return false; }
}

/**
 * 扩散的圆心与半径。
 * 圆心：优先用指针落点（clientX/Y），否则用触发元素（currentTarget）的中心 ——
 * 键盘触发时没有坐标，元素中心是唯一合理的起点。半径取视口四角到圆心的最远距离，
 * 保证波纹一定能铺满整屏，不留角落。
 */
function revealOrigin(ev) {
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  let x = w / 2;
  let y = h / 2;
  const el = ev && ev.currentTarget;
  if (el && typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  // 两个坑叠在一起：
  //   ① 点在视口左上角时 clientX/clientY 都是 0，用真值判断会当成"没有坐标"；
  //   ② 键盘触发的 click（以及 element.click()）坐标也全是 0 —— 那不是"左上角"，
  //      而是"这次交互根本没有位置"，该退回元素中心，否则波纹从屏幕角落冒出来。
  // detail > 0 恰好区分这两者：真实指针点击 detail 为 1，键盘/脚本触发的 click 为 0。
  if (ev && ev.detail > 0 && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
    x = ev.clientX;
    y = ev.clientY;
  }
  const dx = Math.max(x, w - x);
  const dy = Math.max(y, h - y);
  const radius = Math.ceil(Math.sqrt(dx * dx + dy * dy));
  return { x: Math.round(x), y: Math.round(y), r: radius };
}

/** 把圆心与半径写进 <html> 的内联变量（给 keyframes 用）。 */
function setRevealVars(origin) {
  const style = document.documentElement.style;
  style.setProperty('--vt-x', `${origin.x}px`);
  style.setProperty('--vt-y', `${origin.y}px`);
  style.setProperty('--vt-r', `${origin.r}px`);
}

/**
 * 执行一次"带波纹的"外观变更。
 * `apply` 里必须同步改完所有主题相关的属性/变量（View Transitions 会在回调返回后立刻取快照）。
 * 返回 true 表示走了动画，false 表示直切。
 */
function applyWithReveal(apply, ev) {
  if (typeof apply !== 'function') return false;
  if (busy || motionDisabled() || typeof document.startViewTransition !== 'function') {
    apply();
    return false;
  }
  setRevealVars(revealOrigin(ev));
  busy = true;
  // 回调只会跑一次；applyAppearance 本身是幂等的，所以"多补一次"是安全的，
  // 而"漏掉一次"就会让用户点了没反应 —— 所以下面挂了两层兜底。
  let applied = false;
  const once = () => { if (applied) return; applied = true; apply(); };
  try {
    const t = document.startViewTransition(once);
    // ① 浏览器跳过一次过渡时（连续操作、上一次还没结束）回调可能不被调用：
    //    updateCallbackDone 会 reject —— 那里补上，保证变更一定发生。
    if (t && typeof t.updateCallbackDone?.then === 'function') t.updateCallbackDone.then(() => {}, once);
    // ② 再兜一层计时器：实现差异 / 页面被挂起时不至于卡死在这里。
    setTimeout(once, BUSY_FALLBACK_MS);
    // finished 在过渡被跳过时也会 resolve；catch 兜住浏览器取消过渡的 rejection。
    // 另外挂一条兜底计时器：万一 finished 一直不 settle（实现差异 / 页面被挂起），
    // 也不至于把波纹功能永久关掉 —— 那种失败模式极难发现（只是"以后换主题都不动了"）。
    const release = () => { busy = false; };
    const timer = setTimeout(release, BUSY_FALLBACK_MS);
    const done = () => { clearTimeout(timer); release(); };
    if (t && typeof t.finished?.then === 'function') t.finished.then(done, done);
    else done();
    return true;
  } catch {
    busy = false;
    apply();
    return false;
  }
}

export { applyWithReveal, motionDisabled, revealOrigin };
