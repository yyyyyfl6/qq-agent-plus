// 列表"选中块滑过去"的唯一实现（2026-10-08）。
//
// 为什么抽成模块：这套动作现在有两个使用方 —— 主导航（#tabs 里的 .tab）与设置页左侧的分区菜单
// （.settings-menu 里的 .settings-menu-item）。两处都要"选中块从旧位置滑到新位置 + 左缘强调条"，
// 复制一份必然分叉（本仓的老教训：同一件事写两处，改了这边忘了那边）。
//
// 两个使用方的差异只有三件事，全部参数化：容器、选中项选择器、pixel 级的左右内缩（CSS 变量给）。
// 几何一律用 offsetTop/offsetHeight —— offsetParent 就是那个列表容器（它必须是定位元素），
// 与 .tab / .settings-menu-item 的实际盒模型同源，也不受 --zoom 影响。
//
// 关键细节：调用方可以在重建 DOM 之后把**上一次那个滑块节点**交回来（previous）。
// 这样"换一项"是节点从旧位置滑过去，而不是新节点直接出现在终点 —— 设置页的分区菜单每次点击都会
// 重建整块 DOM，所以这条是它能不能有动画的前提。
'use strict';

// 名字带 NAV_ 前缀：沙箱（test/helpers/ui-module-source.mjs）把 ui/*.js 拍平到同一个全局
// 词法环境，segment.js 已经占了 PILL_CLASS/BAR_CLASS —— 重名会直接 SyntaxError。
const NAV_PILL_CLASS = 'side-pill';
const NAV_PILL_BAR_CLASS = 'side-pill-bar';

/** 造一个滑块（容器里第一个子元素：同级里后面的列表项会画在它上面，不必再定 z-index）。 */
function createNavPill(doc) {
  const pill = doc.createElement('span');
  pill.className = NAV_PILL_CLASS;
  pill.setAttribute('aria-hidden', 'true');
  const bar = doc.createElement('span');
  bar.className = NAV_PILL_BAR_CLASS;
  bar.setAttribute('aria-hidden', 'true');
  pill.appendChild(bar);
  // 首次落位不要从上一个位置滑过来（新开的页面没有"上一个位置"）
  pill.style.transition = 'none';
  pill.dataset.fresh = '1';
  return pill;
}

/**
 * 把滑块摆到当前选中项上。返回滑块节点（下次重建 DOM 时交回给 previous）。
 * 没有选中项时把滑块藏起来（不留一个悬空的色块）——与分段控件同一口径。
 */
function positionNavPill(list, { activeSelector = ':scope > .active', previous = null } = {}) {
  if (!list) return null;
  const doc = list.ownerDocument;
  let pill = previous || list.querySelector(':scope > .' + NAV_PILL_CLASS);
  if (!pill) pill = createNavPill(doc);
  // 新建的、以及调用方交回来的旧节点，都要挂进容器（后者是"重建 DOM 后接回来"的那条路）。
  // 滑块是**装饰性**节点：容器不支持插入时（手写的极简 DOM 桩）直接跳过，绝不让它把整页渲染
  // 带崩 —— 真浏览器里这个方法永远在（render-test 的假 DOM 就只实现了 querySelector）。
  if (pill.parentNode !== list) {
    if (typeof list.insertBefore !== 'function') return pill;
    list.insertBefore(pill, list.firstChild);
  }
  const active = list.querySelector(activeSelector);
  if (!active) {
    pill.style.opacity = '0';
    return pill;
  }
  pill.style.opacity = '1';
  pill.style.setProperty('--side-pill-y', `${active.offsetTop}px`);
  pill.style.setProperty('--side-pill-h', `${active.offsetHeight}px`);
  // 拿到了真实几何再恢复过渡：宽度/高度真为 0（还没布局完）时压住反而会让高亮消失
  if (pill.dataset.fresh === '1' && active.offsetHeight > 0) {
    delete pill.dataset.fresh;
    void pill.offsetWidth;                    // 让这次几何在 transition:none 下定型
    pill.style.removeProperty('transition');  // 之后换项照常平滑滑动
  }
  return pill;
}

export { NAV_PILL_CLASS, positionNavPill };
