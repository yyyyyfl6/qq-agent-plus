// 真实端到端：起真服务，**不 mock 任何接口**，
// 用 vm 加载 ui/app.js，走完整的 switchTab('usage') → loadUsageView 流程，
// 验证页面真的有内容。这是最接近用户实际操作的验证。
//
// ⚠️ 必须先把数据目录重定向到临时目录，再加载 src：这个用例会 createApp() + start()，
//    默认打开的是仓库里的 data/（真实聊天库、含 Key 的真实 config.json，
//    而且任意一次 getConfig() 的防抖保存都可能按稳定策略把它重写掉）。
//    环境变量必须在 src 模块求值**之前**生效：DATA_DIR 是模块级常量
//    （src/core/config-legacy.js:20），而 ESM 的静态 import 会先于文件体执行，
//    所以 createApp 只能用动态 import 放在设置之后。
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toClassicScript } from './helpers/ui-module-source.mjs';
import http from 'node:http';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-e2e-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
// 隔离端口：app.start() 不接收参数（下面的 PORT 形参从未生效），实际绑定的是
// config.server.port（默认 3210）。宿主机上跑着生产实例时（服务器上就是常态），
// 整条 npm test 会被 EADDRINUSE 打断 —— 把隔离端口显式写进临时配置，让本测试
// 真正自包含。端口用 listen(0) 现拿（2026-10-10 审查：原来写死 40995，同机两个安装
// 并发跑更新门禁、或恰好有进程占用它时，整条门禁被 EADDRINUSE 拦死——
// strictPort 不会回退端口）。它本测试自占一次后立刻释放，竞态窗口可忽略。
// 种子配置用应用自己的 DEFAULT_CONFIG **整份**写盘（2026-10-01 审查）：原来只写 server 一节，
// 剩下全靠"缺省合并"兜住 —— 那样测不到真实配置形态下的读取路径（少一个键就少一段覆盖）。
const freeListenPort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const { DEFAULT_CONFIG } = await import('../src/core/config.js');
const seededConfig = structuredClone(DEFAULT_CONFIG);
const PORT = await freeListenPort();
seededConfig.server = { ...seededConfig.server, port: PORT, host: '127.0.0.1' };
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(seededConfig));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });
const { createApp } = await import('../src/console/app.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); } };

// ── 起真服务 ──
const app = createApp({ log: () => {} });
const port = await app.start(PORT);
console.log('=== 真实服务已启动 :' + port + '（接口全部真实，无 mock）===\n');

// ── DOM 桩（尽量接近真实）──
function makeEl(id = '') {
  const el = {
    id, dataset: {}, _cls: new Set(), _q: {},
    style: { setProperty() {}, removeProperty() {} },
    textContent: '', innerHTML: '', value: '', checked: false, children: [],
    scrollTop: 0, scrollHeight: 1000, clientHeight: 500,
    classList: null,
    addEventListener(ev, fn) { (el._ev ||= {}); (el._ev[ev] ||= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    appendChild(c) { el.children.push(c); return c; },
    // 侧栏（ui/core/side-nav.js）会读 data-side-* 开关、往列表首位插滑块；
    // 桩缺这两个方法时整页渲染会抛（2026-10-08 踩到）
    insertBefore(c) { el.children.unshift(c); return c; },
    remove() {}, closest: () => null, setAttribute() {}, getAttribute: () => null,
    hasAttribute: () => false, removeAttribute() {},
    focus() {}, scrollIntoView() {}
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}
const byId = new Map();
// 页签与视图桩：让 app.js 加载时能真实绑定点击事件。
// 曾经点击处理器漏了 usage 分支，而旧桩 querySelectorAll 恒返 []，
// 测试里根本没绑过点击事件 —— 于是"点页签空白"这个 bug 测试完全覆盖不到。
const TAB_NAMES = ['control', 'sessions', 'chats', 'memory', 'assets', 'usage', 'settings'];
const tabStubs = TAB_NAMES.map((n) => { const el = makeEl(); el.dataset.tab = n; return el; });
const viewStubs = TAB_NAMES.map((n) => makeEl('view-' + n));
const document = {
  documentElement: makeEl(), body: makeEl(), head: makeEl(),
  querySelector(sel) { return sel.startsWith('#') ? document.getElementById(sel.slice(1)) : (byId.get(sel) || (byId.set(sel, makeEl()), byId.get(sel))); },
  querySelectorAll(sel) {
    if (sel === '.tab') return tabStubs;
    if (sel === '.view') return viewStubs;
    return [];
  },
  getElementById(id) { if (!byId.has('#' + id)) byId.set('#' + id, makeEl(id)); return byId.get('#' + id); },
  createElement: () => makeEl(), addEventListener() {}
};

// 真实 fetch（打到真服务）
const realFetch = async (url, opt = {}) => {
  const u = new URL(url, 'http://127.0.0.1:' + port);
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: opt.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console', ...(opt.headers || {}) } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ ok: r.statusCode < 400, status: r.statusCode, json: async () => JSON.parse(d || '{}') })); });
    rq.on('error', rej);
    if (opt.body) rq.write(opt.body);
    rq.end();
  });
};

const sandbox = {
  document, window: null,
  localStorage: { getItem: () => null, setItem() {} },
  location: { href: 'http://127.0.0.1:' + port + '/' },
  fetch: realFetch,
  EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  alert: () => {}, confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: 'node' }, requestAnimationFrame: (f) => setTimeout(f, 0),
  URL, Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
// 按 index.html 的 script 清单、按序加载（唯一真相源；写死文件名会在拆模块后静默缺文件）。
// 沙箱只铺到 app.js 为止 —— 8 个外挂插件要 NodeFilter 等真实 DOM 能力，由 ui-smoke 覆盖。
const allScripts = [...fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8')
  .matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
for (const srcFile of allScripts.slice(0, allScripts.indexOf('app.js') + 1)) {
  const raw = fs.readFileSync(path.join(ROOT, 'ui', srcFile), 'utf8');
  new vm.Script(toClassicScript(raw, srcFile), { filename: `ui/${srcFile}` }).runInContext(ctx);
}

// ── 真实加载配置与价格（模拟启动流程）──
console.log('=== 模拟启动：拉配置与价格 ===');
const cfg = await realFetch('/api/config').then((r) => r.json());
const priceData = await realFetch('/api/model-prices').then((r) => r.json()).catch(() => ({ prices: [], current: null }));
vm.runInContext('state.config = ' + JSON.stringify(cfg) + ';', ctx);
vm.runInContext('state.modelPrices = ' + JSON.stringify(priceData) + ';', ctx);
check('配置已加载', !!cfg, '');
check('价格已加载（prices=' + (priceData.prices || []).length + '）', !!priceData);

// ⚠️ 等启动流程 settle：app.js 加载后会跑一段初始化（拉配置、渲染设置页等），
//    期间它会把 state.tab 改成 settings。不等它跑完就开始测，
//    loadUsageView 的竞态检查会直接 return，页面停在骨架屏。
await new Promise((r) => setTimeout(r, 500));

// ── 切到用量页（完整走 switchTab）──
console.log('\n=== switchTab("usage") 完整流程 ===');
const usageBox = document.getElementById('usage-page');
// ⚠️ 每次调用前都要重设 tab：app.js 的启动流程会在 await 期间把 state.tab
//    改成 settings。loadUsageView 里有 `if (state.tab !== 'usage') return` 的
//    竞态防护（这是对的），只设一次的话数据会被白拉、页面停在骨架屏。
const setUsageTab = () => vm.runInContext("state.tab = 'usage';", ctx);
setUsageTab();
await (ctx.loadUsageView || sandbox.loadUsageView)({ force: true });

const html = String(usageBox.innerHTML || '');
console.log('  页面长度: ' + html.length + ' 字符');
check('页面有实质内容（>1000 字符）', html.length > 1000, String(html.length));
check('包含「用量与成本」标题', html.includes('用量与成本'));
check('包含「估算成本」卡片', html.includes('估算成本'));
check('包含「搜索次数」卡片', html.includes('搜索次数'));
check('包含「调用次数」卡片', html.includes('调用次数'));
check('不是错误提示', !html.includes('加载失败'), html.slice(0, 120));
check('不是空页面', html.trim().length > 0);
// 五张统计卡固定一行：无跨列（wide），卡片数恰好 5
check('统计卡共 5 张', (html.match(/class="usage-card[ "]/g) || []).length === 5,
  String((html.match(/class="usage-card[ "]/g) || []).length));
check('卡片无跨列布局（单行五列）', !html.includes(' wide"') && !html.includes(' wide '), '');

// ── 数值是否真的填了 ──
console.log('\n=== 数值填充（真实数据）===');
// DOM 桩不会解析 innerHTML，renderUsagePage 重建后 querySelector 缓存的是旧元素，
// 所以显式再调一次 updateUsagePage，确保读到的是刚填入的值。
const freshStats = await realFetch('/api/usage/stats?range=7').then((r) => r.json());
const freshSt = await realFetch('/api/status').then((r) => r.json());
// 「全部」档（2026-10-12 审查）：此前 Number('all')||7 → 标签与数据都变成"最近 7 天"
const allStats = await realFetch('/api/usage/stats?range=all').then((r) => r.json());
check('「全部」档真的给全部（label/mode）', allStats.rangeLabel === '全部' && allStats.mode === 'all',
  `label=${allStats.rangeLabel} mode=${allStats.mode}`);
ctx.updateUsagePage(freshStats, freshSt, priceData || {});
const f = (n) => String(usageBox.querySelector(`[data-field="${n}"]`)?.textContent || '');
const cost = f('cost'), runs = f('runs'), search = f('search'), prompt = f('prompt');
console.log('  成本=' + cost + '  调用=' + runs + '  搜索=' + search + '  输入=' + prompt);
check('成本已填（¥ 开头）', cost.startsWith('¥'), cost);
check('调用次数已填（数字）', /^\d+$/.test(runs), runs);
check('搜索次数已填（数字）', /^[\d,]+$/.test(search), search);
check('输入 token 已填', prompt.length > 0, prompt);

// 搜索卡副行（2026-10-01 审查）：两个分支原先写成同一句字面量，等于没有区分。
// 真根因是 searchCount 记的是「联网动作总数」（web_search + web_fetch），所以副行要按
// toolCounts 拆开说。用例用真实 stats 的形状覆写三个字段，逐种组合对文案。
console.log('\n=== 搜索卡副行三种口径 ===');
const subOf = (override) => {
  ctx.updateUsagePage({ ...freshStats, ...override }, freshSt, priceData || {});
  return String(usageBox.querySelector('[data-field="search-sub"]')?.textContent || '');
};
const numberOf = (override) => {
  ctx.updateUsagePage({ ...freshStats, ...override }, freshSt, priceData || {});
  return String(usageBox.querySelector('[data-field="search"]')?.textContent || '');
};
const subNone = subOf({ searchCount: 0, toolCounts: {} });
const subSearchOnly = subOf({ searchCount: 5, toolCounts: { web_search: 5 } });
const subBoth = subOf({ searchCount: 8, toolCounts: { web_search: 5, web_fetch: 3 } });
const subFetchOnly = subOf({ searchCount: 2, toolCounts: { web_fetch: 2 } });
// 只有总数、没有工具明细（老会话的 messages 里没有 toolCall）：不能凭空断言"只抓了网页"
const subUnknown = subOf({ searchCount: 46, toolCounts: { send_message: 133, finish: 149 } });
console.log('  无=' + subNone + ' / 只搜=' + subSearchOnly + ' / 都有=' + subBoth + ' / 只抓=' + subFetchOnly + ' / 不明=' + subUnknown);
check('没有联网时说「没有联网」', subNone.includes('没有联网'), subNone);
check('纯搜索：说明没抓网页', subSearchOnly.includes('只做了联网搜索') && subSearchOnly.includes('没抓网页'), subSearchOnly);
check('都做了：两个数字都给出', subBoth.includes('搜索 5 次') && subBoth.includes('抓网页 3 次'), subBoth);
check('只抓网页：说明没走搜索', subFetchOnly.includes('只抓了网页') && subFetchOnly.includes('没走搜索'), subFetchOnly);
check('只有总数没有明细：不许硬说「只抓了网页」',
  subUnknown.includes('明细未记录') && !subUnknown.includes('只抓了网页'), subUnknown);
// 主数字是"联网动作总数"（= searchCount），不随拆分口径变；换个值要跟着变（别把主数字写死）
const num5 = numberOf({ searchCount: 5, toolCounts: { web_search: 5 } });
const num1234 = numberOf({ searchCount: 1234, toolCounts: { web_search: 1234 } });
check('主数字跟随 stats.searchCount（含千分位）', num5 === '5' && num1234 === '1,234', `${num5} / ${num1234}`);
// 还原成真实数据，后面的用例继续用
ctx.updateUsagePage(freshStats, freshSt, priceData || {});

// ── 各 range 都试 ──
console.log('\n=== 各时间范围 ===');
for (const rg of ['today', '7', '30', 'all']) {
  vm.runInContext(`state.usageRange = '${rg}';`, ctx);
  setUsageTab();                     // 同上：每次都要重设
  await (ctx.loadUsageView || sandbox.loadUsageView)({ force: true });
  const h = String(usageBox.innerHTML || '');
  const ok = h.length > 1000 && !h.includes('加载失败');
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + 'range=' + rg.padEnd(6) + ' ' + h.length + ' 字符');
}

// ── 下钻（点行）──
console.log('\n=== 下钻明细（点行）===');
vm.runInContext("state.usageRange = '7';", ctx);
setUsageTab();
const stats = await realFetch('/api/usage/stats?range=7').then((r) => r.json());
const firstDay = (stats.days || [])[0];
if (firstDay) {
  const r = await realFetch(`/api/usage/breakdown?range=7&dim=day&key=${encodeURIComponent(firstDay.key)}&by=model`);
  const b = await r.json();
  check('按天下钻返回数据（rows=' + ((b.rows || []).length) + '）', r.ok && Array.isArray(b.rows));
} else {
  console.log('  （无按天数据，跳过）');
}

// ── 回归：模拟真实点击「用量」页签 ──
// 2026-09-05 bug：点击处理器 inline 复制了 switchTab 逻辑却漏了 usage 分支，
// 上面直接调 loadUsageView 的测试全绿，但用户点页签永远空白。
// 这一段走真实点击路径（触发绑定的 click 监听 → switchTab → loadUsageView）。
console.log('\n=== 回归：模拟真实点击「用量」页签 ===');
const usageTab = tabStubs.find((t) => t.dataset.tab === 'usage');
const clickHandlers = (usageTab && usageTab._ev && usageTab._ev.click) || [];
check('用量页签已绑定点击事件', clickHandlers.length > 0);
// 先切走、清空页面，模拟用户从别的页签点过来
vm.runInContext("state.tab = 'sessions';", ctx);
usageBox.innerHTML = '';
for (const fn of clickHandlers) fn({ preventDefault() {} });
let clickedHtml = '';
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  clickedHtml = String(usageBox.innerHTML || '');
  if (clickedHtml.includes('用量与成本')) break;
}
check('点击后 state.tab = usage', vm.runInContext('state.tab', ctx) === 'usage');
check('点击后页面有实质内容（含「用量与成本」）', clickedHtml.includes('用量与成本'), clickedHtml.slice(0, 80));
check('点击后不是错误提示', !clickedHtml.includes('加载失败'), clickedHtml.slice(0, 80));

console.log('\n=== 回归：模拟真实点击「观测」页签 ===');
const assetTab = tabStubs.find((t) => t.dataset.tab === 'assets');
const assetClickHandlers = (assetTab && assetTab._ev && assetTab._ev.click) || [];
check('观测页签已绑定点击事件', assetClickHandlers.length > 0);
vm.runInContext("state.tab = 'sessions';", ctx);
const assetBox = document.getElementById('asset-page');
assetBox.innerHTML = '';
for (const fn of assetClickHandlers) fn({ preventDefault() {} });
let assetHtml = '';
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  assetHtml = String(assetBox.innerHTML || '');
  if (assetHtml.includes('AI 资产观测')) break;
}
check('点击后 state.tab = assets', vm.runInContext('state.tab', ctx) === 'assets');
check('观测页只展示共享表情与黑话资产',
  ['AI 资产观测', '表情包', '黑话'].every((text) => assetHtml.includes(text))
    && !assetHtml.includes('统一人物')
    && !assetHtml.includes('会话印象'),
  assetHtml.slice(0, 120));
check('观测页不是错误提示', !assetHtml.includes('资产读取失败'), assetHtml.slice(0, 120));

console.log('\n=== 回归：模拟真实点击「控制」页签 ===');
const controlTab = tabStubs.find((t) => t.dataset.tab === 'control');
const controlClickHandlers = (controlTab && controlTab._ev && controlTab._ev.click) || [];
check('控制页签已绑定点击事件', controlClickHandlers.length > 0);
vm.runInContext("state.tab = 'sessions';", ctx);
const controlBox = document.getElementById('control-page');
controlBox.innerHTML = '';
for (const fn of controlClickHandlers) fn({ preventDefault() {} });
let controlHtml = '';
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  controlHtml = String(controlBox.innerHTML || '');
  if (controlHtml.includes('服务与访问控制')) break;
}
check('点击后 state.tab = control', vm.runInContext('state.tab', ctx) === 'control');
check('控制页展示服务入口与密钥控制',
  ['服务与访问控制', 'DeepSeek Harness', 'Bridge Console', 'SnowLuma', 'QQ Agent 控制台 Token']
    .every((text) => controlHtml.includes(text)),
  controlHtml.slice(0, 120));
check('控制页不是错误提示', !controlHtml.includes('服务状态读取失败'), controlHtml.slice(0, 120));

await app.stop();
console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASSED ' + pass));
// 不用 process.exit：app.stop() 之后还有句柄在异步关闭。Windows 上强制退出会撞
// libuv 的 UV_HANDLE_CLOSING 断言——用例全过却以 127 结束（test-suite 重定向 TMP 后必现）。
process.exitCode = fail ? 1 : 0;
