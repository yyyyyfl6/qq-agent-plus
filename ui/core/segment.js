// 分段选择器的"滑块"（2026-10-08）。
//
// 参照控制台的实测做法（2026-10-08）：滑块不是每个选项自己变色，而是一个绝对定位的
// 圆角块在轨道里平移 —— 选中项的标签变白靠滑块**内部再反向位移的一整条文字层**实现，
// 所以滑块滑到哪，哪一格的文字就是白的。我们这里用更省事的等价写法：滑块只负责底色，
// 文本颜色交给 `.seg-item.selected`（结果一样，DOM 少一层）。
//
// 为什么单独成模块：分段控件在控制台里出现了两处（思考档位、外观面板的十来组开关），
// 以前每处各写一套显隐样式，观感不一致。现在统一由 enhanceSeg() 处理，渲染方只需要输出
// `.seg > .seg-item[.selected]` 这套既有结构（老代码与锚点都不用改）。
'use strict';

const PILL_CLASS = 'seg-pill';

/**
 * 把滑块摆到当前选中项的位置；没有选中项时把滑块藏起来（不留一个悬空的色块）。
 *
 * 几何一律用 offsetLeft/offsetWidth（相对 offsetParent = .seg，它有 position:relative）：
 * getBoundingClientRect 会把 zoom 算进去，两者相减反而更容易错。
 * 轨道内边距**从几何反推**（第一格的 offsetLeft 减去边框宽就是 padding），不去读
 * getComputedStyle —— 少一次强制样式计算，而且"padding 是多少"这件事只有几何说了算
 * （改 CSS 不用改这里）。
 */
function positionSegPill(seg) {
  const pill = seg.querySelector(':scope > .' + PILL_CLASS);
  if (!pill) return;
  const active = seg.querySelector(':scope > .seg-item.selected, :scope > .seg-item[aria-checked="true"]');
  if (!active) { pill.style.opacity = '0'; return; }
  const first = seg.querySelector(':scope > .seg-item');
  const pad = first ? Math.max(0, first.offsetLeft - seg.clientLeft) : 0;
  seg.dataset.segPad = String(pad);
  pill.style.opacity = '1';
  // 滑块的 CSS left 由这个变量给（与 padding 同源，不必在 CSS 里再写死一个 3px）
  pill.style.setProperty('--pill-left', `${pad}px`);
  pill.style.setProperty('--pill-x', `${active.offsetLeft - seg.clientLeft - pad}px`);
  pill.style.setProperty('--pill-w', `${active.offsetWidth}px`);
  // 首次定位不要"从 0 宽长出来"：新渲染的面板一出现，滑块就该已经停在正确那一格上。
  // （.seg-pill 的 width 带 transition，起始值 0px → 不压掉的话，每开一次设置页/外观面板，
  //  十几条分段控件的滑块都会当着用户的面从左边鼓出来一下。宽度真为 0 时（还没布局完）
  //  压住反而会让高亮消失，所以只在拿到了真实宽度时才恢复过渡。）
  if (pill.dataset.fresh === '1' && active.offsetWidth > 0) {
    delete pill.dataset.fresh;
    void pill.offsetWidth;                    // 先让这次几何在 transition:none 下定型
    pill.style.removeProperty('transition');  // 之后换档照常有平滑滑动
  }
}

/**
 * 确保 .seg 里有滑块子元素（幂等，可重复调用）。
 * 一律用 `seg.ownerDocument` 造节点 / 取计算样式，而不是模块外的全局 document/window ——
 * 这样它在任何文档里都成立（也才测得了：Node 里加载这个模块时没有全局 document）。
 */
function ensureSegPill(seg) {
  const doc = seg.ownerDocument;
  let pill = seg.querySelector(':scope > .' + PILL_CLASS);
  if (!pill) {
    pill = doc.createElement('span');
    pill.className = PILL_CLASS;
    pill.setAttribute('aria-hidden', 'true');
    // 新建的滑块先关掉过渡（见 positionSegPill 末尾：首次定位完成后再恢复），
    // 这样它一出现就是最终位置，而不是从 0 宽滑过去。
    pill.style.transition = 'none';
    pill.dataset.fresh = '1';
    seg.insertBefore(pill, seg.firstChild);
  }
  seg.classList.add('seg-enhanced');
  return pill;
}

/** 强化一个（或页面上所有）分段控件：插滑块、定位、并在点击/尺寸变化后重新定位。 */
function enhanceSeg(root = document) {
  const segs = root.matches?.('.seg') ? [root] : [...root.querySelectorAll?.('.seg') || []];
  for (const seg of segs) {
    ensureSegPill(seg);
    positionSegPill(seg);
    if (seg.dataset.segBound === '1') continue;
    seg.dataset.segBound = '1';
    // 事件委托：选项是渲染时重建的，绑在容器上就不怕重建
    bindSegResize(seg);
    seg.addEventListener('click', () => requestAnimationFrame(() => positionSegPill(seg)));
    // 键盘：方向键换档（ARIA radiogroup 的常规期望 —— 只挪滑块不改选中，等于"看起来能动、
    // 实际没反应"）。同时把 tabindex 收敛成 roving（只有当前档是 Tab 停靠点），
    // 这样 Tab 进分区、方向键在档位间走，和原生 radio 组的行为一致。
    syncSegTabindex(seg);
    seg.addEventListener('click', () => syncSegTabindex(seg));
    seg.addEventListener('keydown', (e) => {
      const items = [...seg.querySelectorAll(':scope > .seg-item')];
      if (!items.length) return;
      const cur = Math.max(0, items.findIndex((b) => b.classList.contains('selected') || b.getAttribute('aria-checked') === 'true'));
      const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
        : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1
          : (e.key === 'Home') ? -items.length
            : (e.key === 'End') ? items.length : 0;
      if (!step) return;
      e.preventDefault();
      const next = (cur + step + items.length * 2) % items.length;
      items[next].click();          // 复用点击路径：选中态、aria、滑块、回调都在那一条链上
      items[next].focus();
    });
  }
  return segs.length;
}

/**
 * 让分段控件像原生 radio 组那样"只有一个 Tab 停靠点"：
 * 选中的那一档 tabindex=0，其余 -1，方向键在档位之间移动（见 enhanceSeg 的 keydown）。
 */
function syncSegTabindex(seg) {
  const items = [...seg.querySelectorAll(':scope > .seg-item')];
  if (!items.length) return;
  const active = seg.querySelector(':scope > .seg-item.selected, :scope > .seg-item[aria-checked="true"]') || items[0];
  for (const b of items) b.tabIndex = b === active ? 0 : -1;
}

/** 外部改了选中项（如回填配置）后手动同步一次。 */
function refreshSeg(root = document) {
  const segs = root.matches?.('.seg') ? [root] : [...root.querySelectorAll?.('.seg') || []];
  for (const seg of segs) {
    ensureSegPill(seg);
    positionSegPill(seg);
    syncSegTabindex(seg);
  }
  return segs.length;
}

// 窗口尺寸变化会让格子宽度变，滑块要跟着走。
// 这里刻意不碰全局 window：① 仓库的 ui-module-graph 守卫不许任何文件 `window.x = ...`
// （连 `window.addEventListener === 'function'` 这种读法都会被它的正则捞到）；
// ② 从节点自己的 ownerDocument 取窗口，在任意文档里都成立，也才测得了。
// 监听只在第一次遇到 .seg 时挂一次（模块级标记，不占全局名字），并且节流到下一帧。
let resizeBound = false;
let resizePending = false;

function bindSegResize(seg) {
  if (resizeBound) return;
  const view = seg.ownerDocument && seg.ownerDocument.defaultView;
  if (!view || typeof view.addEventListener !== 'function') return;
  resizeBound = true;
  view.addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    const raf = view.requestAnimationFrame || ((fn) => view.setTimeout(fn, 16));
    raf(() => { resizePending = false; refreshSeg(seg.ownerDocument); });
  });
}

export { PILL_CLASS, bindSegResize, enhanceSeg, positionSegPill, refreshSeg, syncSegTabindex };
