// 左侧导航的"参照控制台"效果（2026-10-08）。
//
// 参照实现（SnowLuma WebUI 的打包产物，2026-10-08 逐条实测）的侧栏有两件事最抓人，这里逐条复刻：
//
//   ① **悬停展开的图标条**：aside 宽度 248 ↔ 64，260ms cubic-bezier(.4,0,.1,1)；
//      内层内容**始终 248 宽**、靠 overflow:hidden 裁切 —— 所以标签不是"重排"而是"露出来"，
//      再叠一条 200ms 的 opacity 淡入淡出（否则收起的一瞬间会看到半截字被切掉）。
//      触发条件是"鼠标在侧栏里 / 焦点在侧栏里"，且用户可以把它钉住（外观面板的"固定侧栏"）。
//   ② **会滑动的选中块**：选中态的底块与左缘强调条在参照实现里是两个 Framer Motion 的
//      layoutId 元素（`sidebar-active-pill` / `sidebar-active-bar`），换项时用
//      spring(stiffness 380, damping 32) 从旧位置滑到新位置 —— 不是"旧的消失、新的出现"。
//
// 我们不用动画库：一个绝对定位的 .side-pill 同时承载底块与左缘条，换项时用
// translateY/height 过渡滑过去。曲线取那条 spring 的立方贝塞尔近似
// （ζ = 32 / (2·√380) ≈ 0.82 → 约 4% 过冲、~0.42s 落定），token 见 style.css 的 --ease-side-spring。
//
// 关闭动效（外观面板的"关闭全部动效"/"减少动效"）时，CSS 里那两条过渡会被关掉，滑块直接落位。
'use strict';

// 滑块的位置/动画由 ui/core/nav-pill.js 实现：设置页左侧的分区菜单用的是同一份代码
// （同一套"选中块滑过去 + 左缘强调条"，两处不许各写一份）。
import { NAV_PILL_CLASS, positionNavPill } from './nav-pill.js';
/** 「悬停展开」这个轴落在 <html> 上（由外观的 data-* 属性给出）；悬停/聚焦的瞬时状态只落在 #sidebar 自己身上。 */
const RAIL_ATTR = 'data-side-rail';
const OPEN_ATTR = 'data-side-open';

/** 当前是不是"图标条"模式（外观轴）。属性缺失＝常驻展开。 */
function railMode(doc) {
  return doc.documentElement.getAttribute(RAIL_ATTR) === '1';
}

/** 收起态＝开了图标条、此刻没有悬停/聚焦，且侧栏**真的**是那条窄图标条。
 *  宽/窄屏的判据改为读滑块的计算 display：窄屏那套里滑块是 display:none —— 那是 CSS 自己的
 *  决定，改了断点这里不用跟着改；而"量侧栏宽度"会被 260ms 的宽度过渡骗到（刚取消钉住的那一帧
 *  还是 248px，于是漏挂 title，2026-10-08 审查）。display 不参与过渡，读到的永远是当前状态。 */
function collapsedNow(doc, side) {
  if (!railMode(doc) || side.hasAttribute(OPEN_ATTR)) return false;
  const pill = side.querySelector('.' + NAV_PILL_CLASS);
  if (!pill) return true;
  const view = doc.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return true;
  return view.getComputedStyle(pill).display !== 'none';
}

/**
 * 把主导航的滑块摆到当前选中项上（实现见 ui/core/nav-pill.js）。
 * #tabs 是静态 DOM（index.html 里写死的），滑块节点一直在，所以不像设置页那样需要回传旧节点。
 * 返回是否找到了选中项 —— 调用方（切页签/改外观/窗口变化）据此决定要不要重排别的。
 */
function positionPill(doc = document) {
  const nav = doc.getElementById('tabs');
  if (!nav) return false;
  const active = nav.querySelector(':scope > .tab.active');
  positionNavPill(nav, { activeSelector: ':scope > .tab.active' });
  return Boolean(active);
}


/**
 * 收起时给每一项挂 title（只剩图标时看不出这格是什么）；展开时摘掉（可见文字已经说明了一切，
 * 再来个同义提示只会碍事）。参照实现也是这个口径（`title: collapsed ? label : undefined`）。
 */
function applyTabTitles(doc, collapsed) {
  for (const tab of doc.querySelectorAll('#tabs > .tab')) {
    if (!collapsed) { tab.removeAttribute('title'); continue; }
    const label = tab.querySelector('.tab-label b')?.textContent?.trim() || '';
    const sub = tab.querySelector('.tab-label i')?.textContent?.trim() || '';
    const text = sub ? `${label} — ${sub}` : label;
    if (text) tab.setAttribute('title', text);
  }
}

/**
 * 当前页的无障碍标记：**从 .active 类现推**，保证"高亮在哪、aria-current 就在哪"。
 * 放在这里而不是 switchTab 里，是因为首屏那条路（index.html 里就写着 class="tab active"）
 * 根本不经过 switchTab —— 只在那儿设，首屏就没有 aria-current（生产上验到过）。
 */
function syncAriaCurrent(doc) {
  for (const tab of doc.querySelectorAll('#tabs > .tab')) {
    const want = tab.classList.contains('active') ? 'page' : null;
    if (want) {
      if (tab.getAttribute('aria-current') !== want) tab.setAttribute('aria-current', want);
    } else if (tab.hasAttribute('aria-current')) {
      tab.removeAttribute('aria-current');
    }
  }
}

/** 同步一次（滑块位置 + title + 各种瞬时状态）。切页签、改外观、窗口变化后都要调。 */
function syncSideNav(doc = document) {
  const side = doc.getElementById('sidebar');
  if (!side) return false;
  // 钉住（data-side-rail 不在）时清掉悬停留下的瞬时状态，否则下次打开图标条会停"展开"上
  if (!railMode(doc) && side.hasAttribute(OPEN_ATTR)) side.removeAttribute(OPEN_ATTR);
  // 先把滑块建出来/摆好：collapsedNow 要读它的计算 display（判宽窄屏），得先有节点
  positionPill(doc);
  const collapsed = collapsedNow(doc, side);
  // 只在"收起/展开"真的变了的时候重扫标题：外观面板拖缩放滑条时这个函数会被高频调用
  if (side.dataset.sideTitled !== (collapsed ? '1' : '0')) {
    side.dataset.sideTitled = collapsed ? '1' : '0';
    applyTabTitles(doc, collapsed);
  }
  syncAriaCurrent(doc);
  return true;
}

/** 合并到下一帧再同步：换字体/密度/圆角会改行高（滑块得重新量），拖滑条时这类事件很密。 */
let pendingSync = 0;
function scheduleSideNav(doc) {
  const view = doc.defaultView;
  if (!view || pendingSync) return;
  const raf = view.requestAnimationFrame || ((fn) => view.setTimeout(fn, 16));
  pendingSync = raf(() => { pendingSync = 0; syncSideNav(doc); });
}

/** 悬停/聚焦 → 展开；移开/失焦 → 收起（仅图标条模式下才动）。 */
function setRailOpen(side, open) {
  const doc = side.ownerDocument;
  if (!railMode(doc)) return;
  if (side.hasAttribute(OPEN_ATTR) === open) return;
  if (open) side.setAttribute(OPEN_ATTR, '1');
  else side.removeAttribute(OPEN_ATTR);
  // 宽度/可见范围变了：滑块在"撑满整行"与"42px 方块"之间切换，title 也要跟着挂/摘
  syncSideNav(doc);
}

let globalBound = false;

/** 绑定一次（幂等）。窗口尺寸变化 / 外观变更都要重新量滑块（#tabs 宽度、行高都可能变了）。 */
function initSideNav(doc = document) {
  const side = doc.getElementById('sidebar');
  if (!side) return false;
  if (side.dataset.sideBound !== '1') {
    side.dataset.sideBound = '1';
    side.addEventListener('pointerenter', () => setRailOpen(side, true));
    side.addEventListener('pointerleave', () => setRailOpen(side, false));
    // 键盘也要能读到完整标签：Tab 进侧栏就展开，焦点离开再收起（参照实现的 onFocusCapture/onBlur 同款）
    side.addEventListener('focusin', () => setRailOpen(side, true));
    side.addEventListener('focusout', (ev) => {
      const next = ev.relatedTarget;
      if (next && side.contains(next)) return;
      setRailOpen(side, false);
    });
  }
  if (!globalBound) {
    const view = doc.defaultView;
    if (view && typeof view.addEventListener === 'function') {
      globalBound = true;
      view.addEventListener('resize', () => scheduleSideNav(doc));
      // 外观一变（换字体/密度/圆角 → 行高变了；侧栏轴 → 是否收起的模式变了）就要重新对位
      doc.addEventListener('qqa:appearance', () => scheduleSideNav(doc));
    }
  }
  syncSideNav(doc);
  return true;
}

// 对外只留真正被引用的三个：positionPill 只在本文件内部用（切换页签/改外观时对位），
// 导出它等于给未来留一个"第二个入口"（2026-10-08 审查）
export { initSideNav, scheduleSideNav, syncSideNav };
