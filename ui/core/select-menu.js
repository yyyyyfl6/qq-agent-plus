// 原生 <select> 的展开列表是系统控件（Windows 上是灰白方块、macOS 上是系统菜单），
// 跟控制台的玻璃/主题完全两套。这里**不替换 select 本身** —— 值、选项、disabled、
// 键盘焦点都留在原生元素上，只接管"展开"这一步：弹一层自己的 listbox，选中后写回并派发 change。
//
// 为什么用全局委托而不是逐个包装：控制台里的 select 大量是页面渲染时才生成的
// （模型、声音、插件排序、多人设…），逐个绑定必然漏。事件在 document 上按目标现查，
// 新渲染出来的 select 天然生效，也不用 MutationObserver。
//
// 无障碍：焦点始终留在原生 select 上（它仍是 combobox），弹出层是 role=listbox，
// 活动项通过 aria-activedescendant 指过去；Enter/Space/方向键/Home/End/Esc 都能用。
'use strict';

import { iconSvg } from './icons.js';

let menu = null;
let owner = null;
let options = [];
let active = -1;
let seq = 0;
let typeahead = '';
let typeaheadAt = 0;
let bound = false;

const selectOf = (target) => {
  if (!(target instanceof Element)) return null;
  // happy-dom 的 select.closest('select') 不认自己（真实浏览器认），这里显式兜一层
  return target.tagName === 'SELECT' ? target : target.closest('select');
};

const labelOf = (option) => String(option.label || option.textContent || '').replace(/\s+/g, ' ').trim();
const disabledOf = (option) => Boolean(
  option.disabled
  || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled)
);

function close({ focus = false } = {}) {
  const select = owner;
  if (menu) {
    try { if (menu.hasAttribute('popover')) menu.hidePopover(); } catch { /* 已经关了 */ }
    menu.remove();
  }
  menu = null;
  owner = null;
  options = [];
  active = -1;
  if (!select) return;
  select.removeAttribute('aria-controls');
  select.removeAttribute('aria-activedescendant');
  select.removeAttribute('aria-expanded');
  if (focus && select.isConnected) select.focus({ preventScroll: true });
}

function setActive(index) {
  if (!options.length) return;
  active = index;
  options.forEach((entry, i) => entry.el.classList.toggle('is-active', i === index));
  const el = options[index]?.el;
  if (!el) return;
  owner?.setAttribute('aria-activedescendant', el.id);
  try { el.scrollIntoView({ block: 'nearest' }); } catch { /* 老浏览器 */ }
}

function move(step) {
  if (!options.length) return;
  let index = active;
  for (let guard = 0; guard < options.length; guard += 1) {
    index = (index + step + options.length) % options.length;
    if (!disabledOf(options[index].option)) { setActive(index); return; }
  }
}

function choose(entry) {
  if (!entry || disabledOf(entry.option)) return;
  const select = owner;
  close();
  if (!select || !select.isConnected) return;
  if (select.selectedIndex !== entry.index) {
    select.selectedIndex = entry.index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  select.focus({ preventScroll: true });
}

function addOption(box, option, index) {
  if (option.hidden) return;
  const el = document.createElement('div');
  el.className = 'select-option';
  el.id = `${box.id}-o${index}`;
  el.setAttribute('role', 'option');
  el.dataset.index = String(index);
  const disabled = disabledOf(option);
  if (disabled) {
    el.classList.add('is-disabled');
    el.setAttribute('aria-disabled', 'true');
  }
  const selected = index === owner.selectedIndex;
  el.setAttribute('aria-selected', String(selected));
  const text = labelOf(option);
  el.innerHTML = `<span class="select-option-label"></span>${iconSvg('check', { size: 14, cls: 'select-check' })}`;
  el.firstElementChild.textContent = text;
  el.title = text;
  box.appendChild(el);
  options.push({ el, index, option });
}

function open(select) {
  if (menu && owner === select) { close({ focus: true }); return; }
  close();
  const box = document.createElement('div');
  box.className = 'select-menu';
  box.id = `select-menu-${++seq}`;
  box.setAttribute('role', 'listbox');
  owner = select;
  options = [];
  let index = -1;
  for (const node of select.children) {
    if (node.tagName === 'OPTGROUP') {
      const group = document.createElement('div');
      group.className = 'select-group-label';
      group.textContent = node.label || '';
      if (group.textContent) box.appendChild(group);
      for (const option of node.children) {
        index += 1;
        if (option.tagName === 'OPTION') addOption(box, option, index);
      }
    } else if (node.tagName === 'OPTION') {
      index += 1;
      addOption(box, node, index);
    }
  }
  if (!options.length) {
    owner = null;
    options = [];
    return;
  }

  // 原生 <dialog> 的 showModal 在 top layer：追加到 body 的 fixed 菜单会被 dialog 与其
  // ::backdrop 盖住，而且 dialog 外是 inert，选项点不到。优先用 Popover API（同一个
  // top layer）；不支持 Popover 的老浏览器退回"挂进 dialog 内部"。
  const dialog = select.closest('dialog[open]');
  if (typeof box.showPopover === 'function') {
    box.setAttribute('popover', 'manual');
    document.body.appendChild(box);
    try { box.showPopover(); } catch {
      box.removeAttribute('popover');
      (dialog || document.body).appendChild(box);
    }
  } else {
    (dialog || document.body).appendChild(box);
  }
  menu = box;
  select.setAttribute('aria-controls', box.id);
  select.setAttribute('aria-expanded', 'true');
  // 不在菜单上拦 pointerdown：iOS 上它会连带吞掉后面的 click，选项就点不中了。
  // 选项是普通 div，本来也不会抢走 select 的焦点。
  box.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('.select-option') : null;
    if (!el) return;
    choose(options.find((entry) => entry.el === el));
  });
  box.addEventListener('pointermove', (event) => {
    const el = event.target instanceof Element ? event.target.closest('.select-option') : null;
    if (!el) return;
    const at = options.findIndex((entry) => entry.el === el);
    if (at >= 0 && at !== active) setActive(at);
  });

  const rect = select.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  box.style.minWidth = `${Math.max(rect.width, 168)}px`;
  const size = box.getBoundingClientRect();
  const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - margin - size.width));
  let top = rect.bottom + gap;
  if (top + size.height > window.innerHeight - margin && rect.top - gap - size.height >= margin) {
    top = rect.top - gap - size.height;
  }
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;

  const selected = options.findIndex((entry) => entry.index === select.selectedIndex && !disabledOf(entry.option));
  setActive(selected >= 0 ? selected : options.findIndex((entry) => !disabledOf(entry.option)));
}

function bind() {
  if (bound) return;
  bound = true;

  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element)) return;
    const select = selectOf(event.target);
    if (select) {
      if (select.disabled || select.multiple || Number(select.size || 0) > 1) { close(); return; }
      event.preventDefault();
      select.focus({ preventScroll: true });
      open(select);
      return;
    }
    if (menu && !event.target.closest('.select-menu')) close();
  }, true);

  // 拦掉 click，避免部分浏览器在 pointerdown 被取消后仍弹原生列表
  document.addEventListener('click', (event) => {
    if (selectOf(event.target)) event.preventDefault();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!(event.target instanceof Element)) return;
    const select = selectOf(event.target);
    if (!select) return;
    const canOpen = !select.disabled && !select.multiple && Number(select.size || 0) <= 1;
    if (!menu || owner !== select) {
      if (!canOpen || !['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key)) return;
      event.preventDefault();
      open(select);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ focus: true }); return; }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); move(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); move(-1); return; }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'Home' ? 1 : -1;
      for (let i = event.key === 'Home' ? 0 : options.length - 1; i >= 0 && i < options.length; i += step) {
        if (!disabledOf(options[i].option)) { setActive(i); break; }
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      choose(options[active]);
      return;
    }
    if (event.key.length === 1) {
      const now = Date.now();
      typeahead = now - typeaheadAt < 600 ? typeahead + event.key.toLowerCase() : event.key.toLowerCase();
      typeaheadAt = now;
      // 焦点还在原生 select 上：不拦的话浏览器自带的 typeahead 会直接改 value 并触发
      // change，菜单随即被关掉 —— 用户看到的是"输字母没反应、设置却变了"。
      event.preventDefault();
      event.stopPropagation();
      const hit = options.find((entry) =>
        !disabledOf(entry.option) && labelOf(entry.option).toLowerCase().startsWith(typeahead));
      if (hit) setActive(options.indexOf(hit));
    }
  }, true);

  document.addEventListener('change', (event) => {
    if (menu && event.target === owner) close();
  }, true);

  window.addEventListener('resize', () => close());
  window.addEventListener('scroll', (event) => {
    if (menu && event.target instanceof Node && menu.contains(event.target)) return;
    close();
  }, true);
}

/** 幂等：init 里调一次即可；之后再调不会重复绑定。 */
function initSelectMenus() {
  bind();
}

export { close as closeSelectMenu, initSelectMenus, open as openSelectMenu };
