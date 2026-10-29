// 分段控件的"滑块"（ui/core/segment.js）。
//
// 为什么值得一条用例：滑块的位置是**算**出来的（选项相对轨道的偏移 + 轨道内边距），
// 算错的表现是"选中的那一格和滑块对不齐"——在截图里一眼能看出来，但纯读源码看不出来。
// happy-dom 不做布局（offsetLeft/offsetWidth 恒为 0），所以这里手动把几何值 defineProperty
// 上去，专门验算这套算术；真实几何由真机截图那一步兜。
import assert from 'node:assert/strict';
import { test } from 'node:test';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  // 只有"依赖确实没装"才跳过（生产/更新器环境是 npm ci --omit=dev），装了却加载失败必须抛
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const { PILL_CLASS, enhanceSeg, refreshSeg } = await import('../ui/core/segment.js');

/** 造一个三段的分段控件；几何值由调用方指定（happy-dom 不做布局）。 */
function makeSeg(window, { pad = 4, border = 0, widths = [36, 52, 44], selected = 0 } = {}) {
  const doc = window.document;
  doc.body.innerHTML = `<div class="seg" style="padding-left:${pad}px"></div>`;
  const seg = doc.querySelector('.seg');
  Object.defineProperty(seg, 'clientLeft', { value: border, configurable: true });
  widths.forEach((w, i) => {
    const b = doc.createElement('button');
    b.className = 'seg-item' + (i === selected ? ' selected' : '');
    b.dataset.v = `v${i}`;
    seg.appendChild(b);
  });
  // 真实浏览器里第二格从 padding+border+第一格宽 开始，这里照同样的规则造几何
  let x = border + pad;
  [...seg.querySelectorAll('.seg-item')].forEach((el, i) => {
    Object.defineProperty(el, 'offsetLeft', { value: x, configurable: true });
    Object.defineProperty(el, 'offsetWidth', { value: widths[i], configurable: true });
    x += widths[i];
  });
  return seg;
}

test('enhanceSeg：只插一个滑块、放在最前面，重复调用是幂等的', { skip: SKIP }, () => {
  const window = new WindowClass();
  const seg = makeSeg(window);
  enhanceSeg(seg);
  enhanceSeg(seg);
  enhanceSeg(seg);
  const pills = seg.querySelectorAll(':scope > .' + PILL_CLASS);
  assert.equal(pills.length, 1, '反复调用不许插出多个滑块');
  assert.equal(seg.firstElementChild.classList.contains(PILL_CLASS), true, '滑块要在最前面（其它项按序排）');
  assert.equal(pills[0].getAttribute('aria-hidden'), 'true', '滑块是纯装饰，要 aria-hidden');
  assert.equal(seg.classList.contains('seg-enhanced'), true);
  assert.equal(seg.dataset.segPad, '4', '要把轨道内边距（由几何反推）记下来，定位时要用');
});

test('滑块位置 = 选中项偏移 − 轨道边框 − 轨道内边距，宽度取选中项宽度', { skip: SKIP }, () => {
  const window = new WindowClass();
  const seg = makeSeg(window, { pad: 4, border: 0, widths: [36, 52, 44], selected: 0 });
  enhanceSeg(seg);
  const pill = seg.querySelector('.' + PILL_CLASS);
  const items = [...seg.querySelectorAll('.seg-item')];
  const read = () => ({
    x: parseFloat(pill.style.getPropertyValue('--pill-x')),
    w: parseFloat(pill.style.getPropertyValue('--pill-w')),
    opacity: pill.style.opacity
  });
  // 第 0 格：offsetLeft = 0 + 4 = 4，内边距由几何反推 = 4 → 4 − 0 − 4 = 0
  assert.deepEqual(read(), { x: 0, w: 36, opacity: '1' });

  // 换到第 2 格（offsetLeft = 4 + 36 + 52 = 92）→ 92 − 0 − 4 = 88
  items.forEach((el) => el.classList.toggle('selected', el === items[2]));
  refreshSeg(seg);
  assert.deepEqual(read(), { x: 88, w: 44, opacity: '1' });

  // 换到第 1 格 → 40 − 0 − 4 = 36
  items.forEach((el) => el.classList.toggle('selected', el === items[1]));
  refreshSeg(seg);
  assert.deepEqual(read(), { x: 36, w: 52, opacity: '1' });

  // 有边框时也要减掉它（border 会算进 offsetLeft，但滑块是相对 padding box 定位的）
  const seg2 = makeSeg(window, { pad: 4, border: 1, widths: [30, 30, 30], selected: 1 });
  enhanceSeg(seg2);
  const pill2 = seg2.querySelector('.' + PILL_CLASS);
  assert.equal(parseFloat(pill2.style.getPropertyValue('--pill-x')), 30, '第 1 格：offsetLeft 35 − 边框 1 − 内边距 4 = 30');
});

test('没有选中项时滑块收起来（不留一个悬空色块）', { skip: SKIP }, () => {
  const window = new WindowClass();
  const seg = makeSeg(window, { selected: -1 });
  enhanceSeg(seg);
  const pill = seg.querySelector('.' + PILL_CLASS);
  assert.equal(pill.style.opacity, '0');
});

test('也认 aria-checked 形式的选中项（role=radio 的写法）', { skip: SKIP }, () => {
  const window = new WindowClass();
  const seg = makeSeg(window, { selected: -1 });
  const items = [...seg.querySelectorAll('.seg-item')];
  items[1].setAttribute('aria-checked', 'true');
  enhanceSeg(seg);
  const pill = seg.querySelector('.' + PILL_CLASS);
  assert.equal(pill.style.opacity, '1');
  assert.equal(parseFloat(pill.style.getPropertyValue('--pill-w')), 52, '宽度要跟着 aria-checked 的那一项');
});

test('整页扫描：enhanceSeg(document) 处理页面上每一个 .seg', { skip: SKIP }, () => {
  const window = new WindowClass();
  const doc = window.document;
  doc.body.innerHTML = '<div class="seg" style="padding-left:3px"><button class="seg-item selected">a</button></div>'
    + '<div class="wrap"><div class="seg" style="padding-left:3px"><button class="seg-item selected">b</button></div></div>';
  assert.equal(enhanceSeg(doc), 2, '返回值是处理过的分段控件个数');
  assert.equal(doc.querySelectorAll('.seg-pill').length, 2);
  assert.equal(refreshSeg(doc), 2);
});
