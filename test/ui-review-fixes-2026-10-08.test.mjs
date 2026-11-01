// 2026-10-08 全量审查里修掉的那批控制台缺陷的**源码锚点**。
//
// 为什么用锚点而不是行为用例：这几处要么靠"模块导出 vs window 全局"的差异（沙箱把模块拍平成
// 普通脚本，函数恰好成了全局，行为用例根本测不出来 —— 当初 window.switchTab 就是这么混过 CI 的），
// 要么靠时序（渲染完才挂监听）、要么靠"某一处用没用某个函数"。这些只有盯着源码才咬得住。
//
// 两个必须守住的规矩：
//   ① 匹配前先剥注释：注释里复述一遍旧写法（本项目注释习惯很好，很容易写到）会让
//      "不许出现 X" 的断言被一条注释满足掉 —— 这条坑本仓踩过不止一次。
//   ② 断言要指向"那个调用点"，不是"某个文件里出现过"：所以每条都给出足够长的上下文片段。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥掉行注释与块注释（字符串里的 // 会被误伤，但本项目这些断言片段不涉及 URL 字面量）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 取某个函数/方法的源码体（从 `signature` 起、到下一个顶层 `}` 结束）。 */
function bodyOf(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `源码里找不到 ${signature}（改名了？锚点要跟着改）`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

test('总览页的两个入口不再碰 window.switchTab / 那个没人听的 qa-settings-section 事件', () => {
  const src = stripComments(read('ui/pages/overview.js'));
  assert.equal(/window\.switchTab/.test(src), false,
    'window 上没有 switchTab（它是 app.js 的模块导出），继续这么调只会在真机上抛 TypeError');
  assert.equal(/qa-settings-section/.test(src), false,
    '全仓没有 qa-settings-section 的监听者：派发它等于"以为换了分区、其实什么都没发生"');
  assert.ok(/import\s*\{[^}]*switchTab[^}]*\}\s*from\s*'\.\.\/app\.js'/.test(src),
    '要像 features.js 一样从 app.js import switchTab');
  // 「去更新 / 看详情」改走全局委托：锚点里必须带着分区键（分区键写错也是白搭）
  assert.ok(/overview-goto-onebot[^>]*data-open-settings="onebot"/.test(src),
    'OneBot 入口要带 data-open-settings="onebot"（onebot 是侧栏真有的分区 id）');
});

test('总览页的异常等级/状态复用常量表，且时间钉在上海时区', () => {
  const src = stripComments(read('ui/pages/overview.js'));
  assert.ok(/INCIDENT_SEVERITY_LABELS/.test(src) && /INCIDENT_STATE_LABELS/.test(src),
    'severity/state 的中文名要用 core/constants.js 的那份表（自己抄一份必然与服务端取值漂掉）');
  // 服务端取值是 warning / acknowledged；自己写 warn / acked 时会把英文原样漏到界面上
  assert.equal(/warn:\s*'警告'/.test(src), false, '不许再自己写一份 warn 键的小表');
  assert.equal(/acked:\s*'已确认'/.test(src), false, '不许再自己写一份 acked 键的小表');
  assert.ok(/ZONE_OFFSET_MS/.test(src), '日期/日切要按上海时区算（与服务端 todayKey 同口径）');
  assert.equal(/\bgetHours\(|\bgetMonth\(|\bgetDate\(/.test(src), false,
    '本地时区取值会让非 UTC+8 的管理员看到"今天的柱子是 0"、时间戳与别的页对不上');
});

test('会话列表的"滚到底加载更多"挂在渲染里，而不是 init 末尾（首启会提前 return 跳过）', () => {
  const src = stripComments(read('ui/pages/sessions.js'));
  assert.ok(/import\s*\{[^}]*initSessionScrollLoader[^}]*\}\s*from\s*'\.\.\/core\/dom-util\.js'/.test(src),
    'sessions.js 要 import initSessionScrollLoader');
  const body = bodyOf(src, 'function renderSessionList()');
  assert.ok(/initSessionScrollLoader\(\)/.test(body),
    '监听要挂在 renderSessionList 里：首次启动配置没填好时 init 会提前 return，那一刻 #session-list 还不存在');
});

test('存档列表的行可键盘进入（role/tabindex + Enter/Space）', () => {
  const src = stripComments(read('ui/pages/chat.js'));
  assert.ok(/class="chat-item[^"]*"\s+data-key="\$\{esc\(c\.key\)\}"\s+role="button"\s+tabindex="0"/.test(src),
    '存档行要带 role="button" tabindex="0"（否则 Tab 直接跳过整列，只能点鼠标）');
  assert.ok(/event\.key !== 'Enter' && event\.key !== ' '/.test(src),
    '要有 Enter/Space 的 keydown 处理（与「会话」列表同一口径）');
});

test('思考档位重画后要重新给滑块定位（否则选中档是白字贴浅色轨道 = 看不见）', () => {
  const src = stripComments(read('ui/pages/settings.js'));
  const body = bodyOf(src, 'function syncThinkingUi(');
  // 必须用 enhanceSeg：它才挂"点击后重新对位"与方向键监听；refreshSeg 只定位不挂监听，
  // 重建出来的新节点上这些全是缺的（2026-10-08 二轮审查修正）。
  assert.ok(/slot\.innerHTML\s*=/.test(body) && /enhanceSeg\(slot\)/.test(body),
    'syncThinkingUi 重建分段控件后要 enhanceSeg(slot)（插滑块 + 挂监听 + 定位）');
  assert.equal(/refreshSeg\(slot\)/.test(body), false, 'refreshSeg 不挂监听，别用它收尾');
});

test('外观面板以"当前生效的外观"渲染，而不是已保存的配置（否则切走再切回会显示旧选择）', () => {
  const src = stripComments(read('ui/pages/settings-appearance.js'));
  const body = bodyOf(src, 'function renderAppearanceBlock(c)');
  assert.ok(/\.\.\.currentAppearance\(\)/.test(body),
    'renderAppearanceBlock 要把 currentAppearance() 铺在最上层：外观是"点了就生效、保存才落盘"的');
});

test('数字字段不再用 `|| 默认值` 吃掉显式的 0', () => {
  const src = stripComments(read('ui/pages/settings-save.js'));
  assert.ok(/function numKeep\(/.test(src), '要有一个"显式 0 留住"的取数助手');
  for (const [id, key] of [
    ['cfg-draindelay', 'drainDelayMs'],
    ['cfg-temperature', 'temperature'],
    ['cfg-pro-prob', 'probability'],
    ['cfg-bylength', 'byLengthMs']
  ]) {
    assert.ok(new RegExp(`numKeep\\(val\\('#${id}'`).test(src),
      `#${id}（${key}）要用 numKeep：min="0" 的控件里 0 是合法值（0 = 不等 / 贪心解码 / 从不主动开口）`);
  }
  // 旧写法整体不许再出现（这四处都是 min="0" 的控件）
  for (const bad of [
    /Number\(val\('#cfg-draindelay'[^)]*\)\)\s*\|\|\s*1200/,
    /Number\(val\('#cfg-temperature'[^)]*\)\)\s*\|\|\s*0\.8/,
    /Number\(val\('#cfg-pro-prob'[^)]*\)\)\s*\|\|\s*0\.25/,
    /Number\(val\('#cfg-bylength'[^)]*\)\)\s*\|\|\s*20/
  ]) {
    assert.equal(bad.test(src), false, `旧写法还在：${bad}`);
  }
});

// ── 二轮（2026-10-08 下午）审查修掉的那批：同样是"改在另一个调用点"就容易漏的地方 ──

test('三处列表的行都可键盘进入（会话 / 存档 / 会话记忆口径一致）', () => {
  // 会话记忆那一列原来漏了（只有会话与存档做了），Tab 会跳过整列。
  const mem = stripComments(read('ui/pages/memory.js'));
  assert.ok(/class="chat-item[^"]*"\s+data-key="\$\{esc\(key\)\}"\s+role="button"\s+tabindex="0"/.test(mem),
    '会话记忆的行要有 role="button" tabindex="0"');
  assert.ok(/event\.key !== 'Enter' && event\.key !== ' '/.test(mem), '要有 Enter/Space 的 keydown');
  for (const file of ['ui/pages/sessions.js', 'ui/pages/chat.js']) {
    const src = stripComments(read(file));
    assert.ok(/role="button"\s+tabindex="0"/.test(src), `${file} 的行也要能键盘进入（口径统一）`);
  }
});

test('用量表的行可键盘打开明细（tr 不是原生可聚焦元素，得自己补）', () => {
  const src = stripComments(read('ui/pages/usage.js'));
  assert.ok(/tr\.tabIndex = 0/.test(src) && /tr\.setAttribute\('role', 'button'\)/.test(src),
    '渲染后要给 tr[data-key] 补 tabindex/role');
  assert.ok(/host\.addEventListener\('keydown'/.test(src), '要有键盘打开明细的委托处理');
  assert.equal(/host\.addEventListener\('click'[\s\S]{0,200}openUsageBreakdown/.test(src), true,
    '点击那条路要保留');
});

test('异常处理的三个动作失败时要看得见（不许只剩控制台报错）', () => {
  const src = stripComments(read('ui/pages/features.js'));
  const body = bodyOf(src, 'const incidentAction = (');
  assert.ok(/try\s*\{/.test(body) && /catch\s*\(/.test(body) && /alert\(/.test(body),
    'incidentAction 要 try/catch 并把错误告诉用户');
  for (const sel of ['[data-incident-ack]', '[data-incident-resolve]', '[data-incident-delete]']) {
    assert.ok(src.includes(sel), `${sel} 的入口要还在`);
  }
  assert.ok(/button\.disabled = true/.test(body), '在飞的按钮要禁用，避免连点');
});

test('外观面板的自定义强调色输入框取"当前生效值"，不留第二个真源', () => {
  const src = stripComments(read('ui/pages/settings-appearance.js'));
  assert.equal(/c\.ui\?\.accent/.test(src), false,
    '面板里不许再直接读已保存的 c.ui.accent（那会让"改了没保存"在切走再切回时被清空）');
  assert.ok(/id="cfg-accent"[^>]*value="\$\{esc\(cur\.customAccent \? cur\.accent : ''\)\}"/.test(src),
    '要取当前生效的 cur.customAccent / cur.accent');
});

test('侧栏的宽/窄屏判据读 CSS 的计算值，不量宽度（会被 260ms 过渡骗到）', () => {
  const src = stripComments(read('ui/core/side-nav.js'));
  assert.ok(/getComputedStyle\(pill\)\.display !== 'none'/.test(src), '要用滑块的计算 display 判窄屏那套');
  assert.equal(/offsetWidth \|\| 0\) < 100/.test(src), false, '不许用宽度阈值（过渡中读到的是旧值）');
  // 注意用 [\s\S] 而不是 \n：这个文件是 CRLF，写死 \n 会永远匹配不上（实测踩到）
  assert.ok(/positionPill\(doc\);[\s\S]{0,80}const collapsed = collapsedNow/.test(src),
    '要先建滑块再判收起态（否则读不到它的 display）');
});

test('浮层能用 Esc 关掉（走各自的 .model-modal-close，Promise 不会悬着）', () => {
  const src = stripComments(read('ui/app.js'));
  const body = bodyOf(src, "document.addEventListener('keydown'");
  assert.ok(/Escape/.test(body) && /model-modal-overlay/.test(body) && /model-modal-close/.test(body),
    'Esc 要找最上层浮层并点它的关闭按钮');
});
