// 插件页版式的跨文件守卫（2026-10-17）：
//   · 窄屏的筛选面板必须真的收起 —— 这里钉的是"选择器权重够不够"，因为我第一版就栽在这：
//     `@media (max-width:900px) { .plugin-facets { display:none } }` 写在基础规则
//     `.plugin-facets { display:flex }` **前面**，同权重下后出现的赢，窄屏照样把整条筛选
//     堆在卡片上方（实测 railDisplay=flex、gridTop=988）。行为层面在浏览器里量过，
//     这条只防"下一个人把选择器改回去"。
//   · 发布页是"左三步 + 右结构"两栏，窄了收成一列。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 拿到包含某个选择器的那一个 @media 块（同一 query 在文件里有好几处 —— 只看第一个会拿错）。 */
function mediaBlock(css, query, needle = '') {
  let from = 0;
  while (true) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start === -1) return '';
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) return '';
    const block = css.slice(start, end);
    if (!needle || block.includes(needle)) return block;
    from = end;
  }
}

test('窄屏筛选：收起规则的选择器要压过基础规则（否则窄屏照样堆在卡片上方）', () => {
  const css = read('ui/style.css');
  const block = mediaBlock(css, '(max-width: 900px)', '.plugin-facets');
  assert.ok(block, '找不到 900px 的媒体查询');
  assert.ok(/\.plugin-layout \.plugin-facets\s*\{\s*display:\s*none/.test(block),
    '收起规则必须是 `.plugin-layout .plugin-facets`（同权重会被后面的 `.plugin-facets{display:flex}` 顶回来）');
  assert.ok(/\.plugin-layout\.is-filters-open \.plugin-facets\s*\{[^}]*display:\s*flex/.test(block),
    '展开时要把它显示回来');
  // 基础规则在后面才写 display:flex —— 这正是需要提权重的原因，位置变了这条就该重新看。
  // ⚠️ 比的是**这一块**的位置：`css.indexOf('@media (max-width: 900px)')` 拿的是全文件第一个
  // 900px 查询（布局那块），拿它比的话把插件块搬到基础规则前面也照样绿（2026-10-17 审查抓到）。
  const base = css.indexOf('.plugin-facets {');
  assert.ok(base > css.indexOf(block), '基础规则在本块之后（权重问题仍成立）');
  assert.ok(/display:\s*flex/.test(css.slice(base, css.indexOf('}', base))), '基础规则仍是 display:flex');
});

test('窄屏筛选：按钮在骨架里、点得动、选完自动收起', () => {
  const js = read('ui/pages/plugins.js');
  assert.ok(/data-plugin-filters="1"/.test(js), '工具栏要有「筛选」按钮');
  assert.ok(/plugin-filter-toggle/.test(js), '按钮要带只在窄屏显示的类');
  assert.ok(/filtersOpen = !filtersOpen;/.test(js), '点了要切换');
  // 选完之后收起：四类筛选支路 + 清除筛选都要调它
  const closes = js.match(/closeFiltersIfNarrow\(\);/g) || [];
  assert.ok(closes.length >= 6, `标签/范围/分类/两个开关/清除共 6 处都要收起，实际 ${closes.length} 处`);
  assert.ok(/window\.matchMedia\?\.\('\(max-width: 900px\)'\)\?\.matches/.test(js),
    '只在窄屏收起（宽屏没有这个面板）');
});

test('发布页：两栏（左三步 / 右结构），窄了收成一列', () => {
  const js = read('ui/pages/plugins.js');
  const css = read('ui/style.css');
  assert.ok(/class="plugin-publish-grid"/.test(js), '步骤与右栏要在同一个两栏容器里');
  assert.ok(/plugin-publish-side/.test(js) && /plugin-publish-tree|plugin-tree/.test(js),
    '右栏要给出"生成的结构"');
  assert.ok(/\.plugin-publish-grid\s*\{[^}]*grid-template-columns:[^;]*minmax/.test(css),
    '两栏宽度要用 minmax 约束（右栏可收）');
  assert.ok(mediaBlock(css, '(max-width: 1000px)', '.plugin-publish-grid').includes('.plugin-publish-grid'),
    '窄于 1000px 要收成一列');
});

test('整页限宽居中：页头/页签/卡片同一条内容列（宽屏不能贴左边）', () => {
  const css = read('ui/style.css');
  // 1920 屏上原来整页贴左、右边空 750px —— 用户 2026-10-17 的「内容全堆在左侧」。
  assert.ok(/\.plugins-pane > \*\s*\{[^}]*max-width:\s*1200px[^}]*margin-inline:\s*auto/.test(css),
    '插件页的每个直接子块都要限宽 1200 并居中（与「用量」页 .usage-wrap 同一套口径）');
  // 卡片本身不再各自限宽：页面已经有上限，卡里再卡一次就会在卡内留空洞
  assert.equal(/\.plugin-detail \{[^}]*max-width: 1080px/.test(css), false,
    '详情卡别再单独限宽（会让正文与右栏之间空出一块）');
});

test('极端宽度：320px 下页签整块换行、Hero 收成两列（不拆词、不横向滚动）', () => {
  const css = read('ui/style.css');
  const js = read('ui/pages/plugins.js');
  // 页签行必须允许换行：`white-space: nowrap`（不拆词）之后不配 wrap，flex 不会收缩 —— 实测
  // 320px 时整页横向滚动
  const tabs = /\.plugin-tabs\s*\{[^}]*flex-wrap:\s*wrap/.test(css);
  assert.ok(tabs, '页签行要 flex-wrap: wrap');
  assert.ok(/\.plugin-tab\s*\{[^}]*white-space:\s*nowrap/.test(css), '页签标签不许拆词（"发布/插件"）');
  assert.ok(/\.plugin-publish-cta\s*\{(?:(?!\})[\s\S])*white-space:\s*nowrap/.test(css), '发布按钮同样不拆词');
  // 320px 的 Hero：三列（图标/正文/动作）挤不下，正文只剩 68px —— 收成两列、动作另起一行
  const narrow = mediaBlock(css, '(max-width: 640px)', '.plugin-hero');
  assert.ok(narrow, '要有 640px 的 Hero 断点');
  assert.ok(/\.plugin-hero\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/.test(narrow), 'Hero 收成两列');
  assert.ok(/\.plugin-detail-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(narrow), '动作区换到下一行');
  // 图标 404 要回落到首字母：data-fallback + 捕获阶段的 error 监听（error 不冒泡）
  assert.ok(/data-fallback=/.test(js), '图标要带 data-fallback');
  assert.ok(/addEventListener\('error',[\s\S]{0,600}\}, true\)/.test(js), 'error 监听要用捕获阶段（error 不冒泡）');
});

test('索引来的文案进 innerHTML 前必须转义（升级按钮的 label 里含第三方版本号）', () => {
  const js = read('ui/pages/plugins.js');
  // 升级按钮的文案是 `升级到 v${indexEntry.version}`，而索引是第三方内容源
  assert.match(js, /const text = esc\(label\);/, '动作按钮的 label 要先转义再拼（版本号会走到这里）');
  assert.match(js, /data-plugin-action="\$\{esc\(action\)\}"/, '动作名也一视同仁地转义');
  assert.equal(/data-plugin-action="\$\{action\}"/.test(js), false, '不许留下未转义的 action 插值');
  // 能力图标查表要防原型链（capability 名是索引给的，`constructor` 会命中 Object.prototype）
  assert.match(js, /Object\.hasOwn\(CAP_ICONS, cap\) \? CAP_ICONS\[cap\] : 'chip'/,
    '权限图标要按自有属性查表，否则 constructor/toString 会渲染成空图标');
});

test('详情页 history：已经在详情里就 replace 而不是继续压栈（否则「返回目录」退回上一个插件）', () => {
  const js = read('ui/pages/plugins.js');
  assert.match(js, /if \(history\?\.state && 'pluginDetail' in history\.state\) history\.replaceState\(/,
    '连续打开详情（相关插件）要用 replaceState，保持 history 里只有一条详情条目');
  assert.match(js, /history\?\.pushState\?\.\(\{ pluginDetail: next \}, ''\)/,
    '从目录进详情时才压栈');
});

test('popstate 回到目录时必须把面切回目录（否则渲染进 hidden 容器、界面毫无变化）', () => {
  const js = read('ui/pages/plugins.js');
  assert.match(js, /if \(pluginPane !== 'catalog'\) \{ pluginPane = 'catalog'; renderPane\(\); \}\s*\n\s*safeRenderIndex\(\);/,
    '不论新状态有没有 pluginDetail，都要把面切回目录再渲染');
});

test('插件页 history：别的页签按后退时 popstate 不处理（否则会静默吃掉一步历史）', () => {
  const js = read('ui/pages/plugins.js');
  assert.match(js, /const pluginView = document\.getElementById\('view-plugins'\);/,
    'popstate 要先确认插件页在前台');
  assert.match(js, /if \(!pluginView \|\| !pluginView\.classList\.contains\('active'\)\) return;/,
    '不在前台就什么都不做');
});

test('列表视图窄屏可折行（320px 下不横向溢出）', () => {
  const css = read('ui/style.css');
  const block = mediaBlock(css, '(max-width: 760px)', '.plugin-grid.is-list .plugin-card');
  assert.ok(block, '760px 媒体查询里要有列表档的窄屏规则');
  assert.match(block, /\.plugin-grid\.is-list \.plugin-card \{[^}]*flex-wrap:\s*wrap/,
    '列表行要允许折行（图标+标题+动作+作者+下载+时间一行放不下）');
  assert.match(block, /\.plugin-grid\.is-list \.plugin-card-head,[\s\S]*?min-width:\s*0/,
    'head/foot 要能收缩');
});
