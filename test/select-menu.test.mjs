// 自定义下拉列表（ui/core/select-menu.js）的行为契约：
// 原生 select 保持不动（值/焦点/disabled 语义都在它身上），只把"展开"换成主题内的 listbox。
// 这里在 happy-dom 里走真实事件：pointerdown 开、选项 click 选、键盘开/选、Esc 只关列表。
// 缺 happy-dom 时整体跳过（与 ui-smoke 同一条 --omit=dev 约定）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

let importSeq = 0;

async function withPage(fn) {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  const prev = {};
  for (const key of ['window', 'document', 'Element', 'Node', 'Event']) prev[key] = globalThis[key];
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  try {
    // 每个用例一份模块实例：模块里的 bound/owner 是单例状态，同实例第二次 init 不会再绑定新 document
    const { initSelectMenus } = await import(`../ui/core/select-menu.js?test=${++importSeq}`);
    initSelectMenus();
    return await fn(window);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

function makeSelect(document, { disabledOption = false } = {}) {
  const select = document.createElement('select');
  select.id = 'qa-select';
  select.innerHTML = `
    <optgroup label="常用">
      <option value="a">选项 A</option>
      <option value="b" selected>选项 B</option>
    </optgroup>
    <optgroup label="其他">
      <option value="c">选项 C</option>
      <option value="d" ${disabledOption ? 'disabled' : ''}>禁用项</option>
    </optgroup>`;
  document.body.appendChild(select);
  return select;
}

const fire = (window, el, type, init = {}) => {
  const Ctor = type.startsWith('key') ? window.KeyboardEvent : window.MouseEvent;
  return el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
};

test('点开下拉：渲染分组与选项，选中项带 aria-selected', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = makeSelect(document);
    fire(window, select, 'pointerdown');
    const menu = document.querySelector('.select-menu');
    assert.ok(menu, 'pointerdown 后应出现自定义列表');
    assert.equal(menu.getAttribute('role'), 'listbox');
    assert.equal(select.getAttribute('aria-expanded'), 'true');
    assert.equal(menu.querySelectorAll('.select-group-label').length, 2);
    const options = [...menu.querySelectorAll('.select-option')];
    assert.equal(options.length, 4);
    assert.equal(options[1].getAttribute('aria-selected'), 'true', '选中的是 B');
    assert.equal(options[0].getAttribute('aria-selected'), 'false');
  });
});

test('点选项：写回 select、派发 change、关掉列表', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = makeSelect(document);
    let changes = 0;
    select.addEventListener('change', () => { changes += 1; });
    fire(window, select, 'pointerdown');
    const target = [...document.querySelectorAll('.select-option')][2];
    fire(window, target, 'click');
    assert.equal(select.value, 'c');
    assert.equal(changes, 1);
    assert.equal(document.querySelector('.select-menu'), null);
    assert.equal(select.hasAttribute('aria-expanded'), false);
  });
});

test('键盘：Enter 打开、方向键移动、Enter 选中', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = makeSelect(document);
    select.focus();
    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    select.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true, '打开时要拦默认行为');
    assert.ok(document.querySelector('.select-menu'));
    fire(window, select, 'keydown', { key: 'ArrowDown' });
    fire(window, select, 'keydown', { key: 'Enter' });
    assert.equal(select.value, 'c', 'B 下一项是 C');
  });
});

test('禁用项不可选；Esc 只关列表、不冒泡给页面级弹窗', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = makeSelect(document, { disabledOption: true });
    let pageEscapes = 0;
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') pageEscapes += 1; });
    fire(window, select, 'pointerdown');
    const disabled = [...document.querySelectorAll('.select-option')][3];
    assert.equal(disabled.getAttribute('aria-disabled'), 'true');
    fire(window, disabled, 'click');
    assert.equal(select.value, 'b', '禁用项不写回');
    fire(window, select, 'keydown', { key: 'Escape' });
    assert.equal(document.querySelector('.select-menu'), null);
    assert.equal(pageEscapes, 0, '列表开着时 Esc 先关列表，不能被页面级处理器再拿去关弹窗');
  });
});

test('点外面关闭；select 被 disabled 时不接管', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = makeSelect(document);
    fire(window, select, 'pointerdown');
    assert.ok(document.querySelector('.select-menu'));
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fire(window, outside, 'pointerdown');
    assert.equal(document.querySelector('.select-menu'), null);

    select.disabled = true;
    fire(window, select, 'pointerdown');
    assert.equal(document.querySelector('.select-menu'), null, 'disabled 的 select 不弹自定义列表');
  });
});

test('disabled optgroup 里的选项不可选（样式灰掉之外，写回也要拦住）', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = document.createElement('select');
    select.innerHTML = '<optgroup label="锁定" disabled><option value="x">X</option></optgroup><option value="y" selected>Y</option>';
    document.body.appendChild(select);
    fire(window, select, 'pointerdown');
    const options = [...document.querySelectorAll('.select-option')];
    assert.equal(options[0].getAttribute('aria-disabled'), 'true');
    fire(window, options[0], 'click');
    assert.equal(select.value, 'y', 'disabled optgroup 里的项不能写回');
  });
});

test('首字母跳转只移动高亮，不直接改 select 的值', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const select = document.createElement('select');
    select.innerHTML = '<option value="a">Alpha</option><option value="b" selected>Beta</option><option value="c">Charlie</option>';
    document.body.appendChild(select);
    select.focus();
    fire(window, select, 'keydown', { key: 'Enter' });
    const event = new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, '要拦掉原生 select 的 typeahead');
    assert.equal(select.value, 'b', '输入字母时 value 不能变');
    assert.match(document.querySelector('.select-option.is-active')?.textContent || '', /Charlie/);
    fire(window, select, 'keydown', { key: 'Enter' });
    assert.equal(select.value, 'c', 'Enter 才写回');
  });
});

test('原生 dialog 里的 select 也能打开并选中（菜单不能留在 dialog 后面）', { skip: SKIP }, async () => {
  await withPage((window) => {
    const { document } = window;
    const dialog = document.createElement('dialog');
    const select = document.createElement('select');
    select.innerHTML = '<option value="a">A</option><option value="b" selected>B</option>';
    dialog.appendChild(select);
    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch { /* happy-dom 可能没有实现 top layer */ }
    fire(window, select, 'pointerdown');
    const menu = document.querySelector('.select-menu');
    assert.ok(menu, 'dialog 内也要出现菜单');
    assert.ok(menu.closest('dialog') === dialog || menu.parentElement === document.body,
      '菜单要么挂在 dialog 内，要么用 popover 进 top layer');
    const option = [...menu.querySelectorAll('.select-option')][0];
    fire(window, option, 'click');
    assert.equal(select.value, 'a');
  });
});
