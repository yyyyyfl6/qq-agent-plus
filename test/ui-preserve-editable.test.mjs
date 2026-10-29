// setHtmlIfChanged 的"重画前后保留输入值"行为（真 DOM 用例，2026-10-03）
//
// 这里**只加载 ui/core/dom-util.js 一个模块**，不启动整个控制台：
// 启动完整控制台会起一条 1.5 秒自我续期的状态轮询（ui/app.js 的 scheduleStatusRefresh）
// 加一个 15 秒 interval；它们在 vm 里用的是 Node 定时器，window.close() 停不掉，
// node --test 的进程会一直等它 settle（实测超时）。只加载这一个模块就没有那些定时器，
// 而它正好是本用例要验的那个函数。整页启动的覆盖由 ui-smoke.test.mjs 负责。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;   // 装了却加载失败必须抛（别让门禁静默消失）
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

function loadDomUtil() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  window.document.write('<html><body><div id="host"></div></body></html>');
  const raw = fs.readFileSync(path.resolve('ui/core/dom-util.js'), 'utf8');
  new vm.Script(toClassicScript(raw, 'ui/core/dom-util.js'), { filename: 'ui/core/dom-util.js' })
    .runInContext(vm.createContext(window));
  return window;
}

test('整块重画不覆盖未保存的输入（好友管理/异常处理/人物印象三页共用这一条）', { skip: SKIP }, async () => {
  const window = loadDomUtil();
  const doc = window.document;
  const box = doc.createElement('div');
  const html = (value, live = 'x') => `<input id="cfg-num" type="number" value="${value}">`
    + '<select id="cfg-sel"><option value="a">A</option><option value="b">B</option></select>'
    + '<input id="cfg-flag" type="checkbox">'
    + `<span id="live">${live}</span>`;

  window.setHtmlIfChanged(box, html('1'));
  assert.equal(box.querySelector('#cfg-num').value, '1', '前提：首轮渲染出服务端值');

  // 用户改了三个控件（好友管理页有二十多个这样的数字框），焦点已经移开
  box.querySelector('#cfg-num').value = '42';
  box.querySelector('#cfg-sel').value = 'b';
  box.querySelector('#cfg-flag').checked = true;

  // 后台刷新：易变片段（真实页面里是时间戳与计数，一直在变）触发整块重写
  const changed = window.setHtmlIfChanged(box, html('1', 'y'));
  assert.equal(changed, true, 'live 片段变了 → 这一轮确实重画了');
  assert.equal(box.querySelector('#cfg-num').value, '42', '未保存的数字输入必须保住');
  assert.equal(box.querySelector('#cfg-sel').value, 'b', '未保存的下拉选择必须保住');
  assert.equal(box.querySelector('#cfg-flag').checked, true, '未保存的勾选必须保住');
  assert.equal(box.querySelector('#live').textContent, 'y', '数据本身仍要刷新（不能因为怕丢输入就整个页面停更）');
  assert.equal(window.setHtmlIfChanged(box, html('1', 'y')), false, '完全没变的一轮照旧跳过');

  // 下拉里那个选项没了 → 不强塞非法值，仍以新 HTML 为准
  const gone = doc.createElement('div');
  window.setHtmlIfChanged(gone, html('1'));
  gone.querySelector('#cfg-sel').value = 'b';
  window.setHtmlIfChanged(gone, '<select id="cfg-sel"><option value="a">A</option></select><span id="live">z</span>');
  assert.equal(gone.querySelector('#cfg-sel').value, 'a', '选项没了就不还原旧值（保持服务端那份合法值）');

  // 用户**没动过**的控件要跟着服务端新值走：否则服务端纠正过的值（越界被夹、别名改名…）
  // 会被上一轮那份旧值永久挡在界面外（2026-10-03 复审指出）
  const corrected = doc.createElement('div');
  window.setHtmlIfChanged(corrected, html('1'));
  assert.equal(corrected.querySelector('#cfg-num').value, '1');
  window.setHtmlIfChanged(corrected, html('7', 'z'));
  assert.equal(corrected.querySelector('#cfg-num').value, '7', '没动过的控件跟服务端纠正后的值走');
  // 同名换类型（checkbox → text）不乱还原
  const retyped = doc.createElement('div');
  window.setHtmlIfChanged(retyped, '<input id="cfg-flag" type="checkbox">');
  retyped.querySelector('#cfg-flag').checked = true;
  window.setHtmlIfChanged(retyped, '<input id="cfg-flag" type="text" value="k">');
  assert.equal(retyped.querySelector('#cfg-flag').value, 'k', '控件换了类型就不还原旧值');

  // 控件被删掉 → 不报错
  const removed = doc.createElement('div');
  window.setHtmlIfChanged(removed, html('1'));
  assert.doesNotThrow(() => window.setHtmlIfChanged(removed, '<span id="live">z</span>'));
  window.close();
});

test('服务端这一轮也改了同一个值时，不回填用户那份（存的值要等于显示的值）', { skip: SKIP }, async () => {
  const window = loadDomUtil();
  const doc = window.document;
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  const html = (value) => `<input id="cfg-friend-skip" type="number" max="365" value="${value}">`;

  // 前提：服务端渲染 7，用户把它改成 99999（超出 max=365）
  window.setHtmlIfChanged(box, html('7'));
  box.querySelector('#cfg-friend-skip').value = '99999';

  // 保存后服务端夹成 365 回传。⚠️ 之前这一轮会判定"用户动过"就把 99999 又填回去 ——
  // 界面上显示 99999、配置里存的是 365（2026-10-04 复审 P2）。
  window.setHtmlIfChanged(box, html('365'));
  assert.equal(box.querySelector('#cfg-friend-skip').value, '365',
    '服务端纠正过的值要显示出来，不能被用户那份旧输入盖掉');

  // 服务端**没**动的字段仍然照旧保留用户未保存的输入（别把上一条修复做过头）
  const other = doc.createElement('div');
  doc.body.appendChild(other);
  window.setHtmlIfChanged(other, html('7'));
  other.querySelector('#cfg-friend-skip').value = '42';
  window.setHtmlIfChanged(other, html('7'));   // 服务端值没变
  assert.equal(other.querySelector('#cfg-friend-skip').value, '42', '服务端没改这个字段 → 用户输入必须保住');
  window.close();
});

test('force：用户自己触发的刷新不会被焦点守卫挡掉，焦点还回原控件', { skip: SKIP }, async () => {
  const window = loadDomUtil();
  const doc = window.document;
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  const html = (rows, sel = 'a') => '<select id="filter"><option value="a">全部</option>'
    + '<option value="b">只看未处理</option></select>'
    + `<span id="rows">${rows}</span><span id="picked">${sel}</span>`;

  // 首轮渲染
  window.setHtmlIfChanged(box, html('R1', 'a'));

  // 用户在筛选下拉上选了 b —— 焦点还在这个 <select> 上（选完选项不会自动失焦）
  const filter = box.querySelector('#filter');
  filter.value = 'b';
  filter.focus();
  assert.equal(doc.activeElement?.id, 'filter', '前提：焦点确实在筛选下拉上');

  // 后台轮询式的重画：守卫照旧拦下（防止打字被打断）—— 这条不能被 force 顺手废掉
  assert.equal(window.setHtmlIfChanged(box, html('R2', 'a')), false,
    '后台刷新时焦点在输入控件上 → 仍然不写（保住正在敲的内容）');

  // 用户自己触发的刷新（改筛选、点搜索）必须立刻生效
  assert.equal(window.setHtmlIfChanged(box, html('R2', 'b'), { force: true }), true,
    'force 时焦点在下拉上也要重画（否则筛选看起来完全没反应）');
  assert.equal(box.querySelector('#rows').textContent, 'R2', '筛选结果要真的刷新');
  assert.equal(doc.activeElement?.id, 'filter', '重画换掉了节点，焦点要还给同一个控件');
  window.close();
});

test('保留未保存输入**要能连续保多轮**：还原后不能把基线污染成用户值（2026-10-04 复审 P1）', { skip: SKIP }, async () => {
  const window = loadDomUtil();
  const doc = window.document;
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  // tick 每轮都变，否则 setHtmlIfChanged 按「HTML 没变」跳过，测不到重画
  const html = (value, tick) => `<input id="cfg-num" type="number" value="${value}">`
    + '<select id="cfg-sel"><option value="a">A</option><option value="b">B</option></select>'
    + `<span id="live">${tick}</span>`;

  window.setHtmlIfChanged(box, html('1', 't1'));
  box.querySelector('#cfg-num').value = '42';     // 用户改了数字框
  box.querySelector('#cfg-sel').value = 'b';      // 和下拉（好友管理页有二十多个这样的控件）

  // 连续三轮「内容确实变了」的重画 —— 服务端值一直是 1/a
  for (const tick of ['t2', 't3', 't4']) {
    const changed = window.setHtmlIfChanged(box, html('1', tick));
    assert.equal(changed, true, `${tick} 这一轮确实重画了`);
  }
  const num = box.querySelector('#cfg-num');
  const sel = box.querySelector('#cfg-sel');
  assert.equal(num.value, '42', '第三轮之后用户输入仍在（只保得住一轮 = 基线被污染）');
  assert.equal(sel.value, 'b', '下拉选择同样要保住');
  // 基线必须始终是「服务端渲染出来的值」，不是还原后的用户值
  assert.equal(num.__renderedValue, '1', '__renderedValue 要记服务端值，不是还原后的用户值');
  window.close();
});
test('同一容器里重复 id 的控件：重画后按出现序号配对、不串（2026-10-04 复审 F8）', { skip: SKIP }, async () => {
  const window = loadDomUtil();
  const doc = window.document;
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  // 两个同名 id 的输入框：还原必须一对一 —— 只按 id 配对会让第二个拿到第一个的值
  const html = (a, b, tick) => `<input id="dup" type="text" value="${a}"><input id="dup" type="text" value="${b}">`
    + `<span id="live">${tick}</span>`;
  window.setHtmlIfChanged(box, html('1', '2', 't1'));
  const inputs = box.querySelectorAll('#dup');
  inputs[0].value = 'A';
  inputs[1].value = 'B';

  window.setHtmlIfChanged(box, html('1', '2', 't2'));
  const after = box.querySelectorAll('#dup');
  assert.equal(after[0].value, 'A', '第一个 dup 保住自己的输入');
  assert.equal(after[1].value, 'B', '第二个 dup 保住自己的输入（不能串到 A）');
  // 唯一 id 的控件不受影响（序号从 0 起，逐个配对）
  const single = doc.createElement('div');
  doc.body.appendChild(single);
  window.setHtmlIfChanged(single, '<input id="only" type="text" value="1"><span id="live">t1</span>');
  single.querySelector('#only').value = 'Z';
  window.setHtmlIfChanged(single, '<input id="only" type="text" value="1"><span id="live">t2</span>');
  assert.equal(single.querySelector('#only').value, 'Z', '唯一 id 的控件照旧保留输入');
  window.close();
});
