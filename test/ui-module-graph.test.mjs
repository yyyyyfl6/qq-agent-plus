// ui/ 的**模块图契约**（2026-10-01，B 档 Step 2「全量 ESM 化」之后取代 ui-contract 的全局清单）。
//
// 背景：模块化之前，30 个 classic script 靠"全局词法环境"互相看见，于是有一份 249 条的
// uiSharedGlobals 清单 + 一个"引用必须登记在清单里"的契约用例。那层契约只保证"耦合是显式的"，
// 显式错了（拼错名字、漏 import）画面上是**静默 undefined**。改成 ES module 之后，
// 契约可以更强、也更简单：**跨文件引用只有一条合法路径 —— import**。
//
// 这个文件把六件事钉死：
//   ① 每个 import 都能解析：目标文件存在、导出的名字确实存在（拼错/漏 export 当场红）；
//   ② 未解析引用（除浏览器内建）为空 —— 想再冒出跨文件全局，必须显式改这个用例；
//   ③ 导出的绑定里不许有 let/var（跨文件可变状态一律挂 state；import 绑定只读，写它 TypeError）；
//   ④ 没有任何文件**写** import 出来的绑定（同上，这是模块化最容易踩的静默坑）；
//   ⑤ 模块求值期（顶层语句）跨文件引用不许指到"还在环上、又还没初始化"的 const/let（TDZ）；
//   ⑥ 不许再用改写全局来包裹渲染入口（接管请走 QARegistry）；window 上只允许两个显式对外面。
//
// **缺 espree / eslint-scope / globals 时整体跳过** —— 它们是 eslint 的依赖（devDependencies）。
// 生产/更新器环境按 D6 约定用 `npm ci --omit=dev`，那里没有它们；与 ui-smoke 缺 happy-dom
// 自动跳过是同一条约定（硬报错会让更新器环境变红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

let espree = null;
let eslintScope = null;
let globalsPkg = null;
try {
  const require = createRequire(import.meta.url);
  espree = require('espree');
  eslintScope = require('eslint-scope');
  globalsPkg = require('globals');
} catch (e) {
  // 只放过"确实没装"；装了却加载失败（依赖升级后不再 hoist、包损坏）必须抛出
  // —— 否则这条最关键的模块图契约会静默跳过（2026-10-01 审查）。
  if (e?.code !== 'MODULE_NOT_FOUND') throw e;
}
const SKIP = espree && eslintScope && globalsPkg
  ? false
  : 'espree / eslint-scope / globals 未安装（devDependencies；--omit=dev 环境按约定跳过）';

// browser = window 上的东西；builtin = ES 内建（Error/Map/…）。两者都不算跨文件耦合。
const browserGlobals = new Set([
  ...Object.keys(globalsPkg?.browser ?? {}),
  ...Object.keys(globalsPkg?.builtin ?? {})
]);

const UI = path.resolve('ui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
// script 清单的唯一真相源 = index.html（与 render-test / ui-smoke / ui-modules 同一口径）
const files = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));

const resolveSource = (from, source) => {
  assert.ok(source.startsWith('.'), `${from}: import 必须用相对路径（实际 ${source}）`);
  const abs = path.resolve(UI, path.dirname(from), source);
  const rel = path.relative(UI, abs).split(path.sep).join('/');
  assert.ok(files.includes(rel), `${from}: import 指向了不存在的文件 ${source}`);
  return rel;
};

function analyze(rel) {
  const src = fs.readFileSync(path.join(UI, rel), 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: 'module', loc: true, range: true });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: 'module', ignoreEval: true });
  const moduleScope = sm.globalScope.childScopes.find((s) => s.type === 'module') || sm.globalScope;
  const imports = new Map();          // local name -> { source, target }
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    for (const spec of node.specifiers) {
      assert.equal(spec.type, 'ImportSpecifier', `${rel}: 只允许具名 import（不许 default/namespace）: ${source}`);
      imports.set(spec.local.name, { source, target: resolveSource(rel, source) });
    }
  }
  const exported = new Set();
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    assert.equal(node.source ?? null, null, `${rel}: 不生成 re-export（export ... from）`);
    for (const spec of node.specifiers) exported.add(spec.local.name);
  }
  const topLevel = new Map();         // name -> kind（let/const/var/function/class）
  for (const v of moduleScope.variables) {
    const def = v.defs[0];
    if (!def) continue;
    if (!['Variable', 'FunctionName', 'ClassName'].includes(def.type)) continue;
    topLevel.set(v.name, def.type === 'Variable' ? def.parent.kind : (def.type === 'FunctionName' ? 'function' : 'class'));
  }
  return { rel, src, ast, sm, imports, exported, topLevel };
}

let analyzed = null;
function analyzeAll() {
  if (!analyzed) analyzed = new Map(files.map((rel) => [rel, analyze(rel)]));
  return analyzed;
}

test('每个 import 都能解析：目标存在、名字确实被导出', { skip: SKIP }, () => {
  const filesByRel = analyzeAll();
  const bad = [];
  for (const f of filesByRel.values()) {
    for (const [local, { source, target }] of f.imports) {
      if (!filesByRel.get(target).exported.has(local)) bad.push(`${f.rel}: 从 ${source} 导入的 ${local} 并没有被导出`);
    }
  }
  assert.deepEqual(bad, [], `这些 import 解析不通（漏 export / 名字拼错）：\n${bad.join('\n')}`);
});

test('未解析的引用只剩浏览器内建（跨文件引用不许走全局）', { skip: SKIP }, () => {
  const offenders = [];
  for (const f of analyzeAll().values()) {
    const free = new Set(f.sm.globalScope.through.map((r) => r.identifier.name));
    for (const name of free) if (!browserGlobals.has(name)) offenders.push(`${f.rel}: ${name}`);
  }
  assert.deepEqual(offenders, [], `这些名字既不是浏览器内建、也不是 import 进来的（模块化之前靠全局词法环境的耦合又长回来了）：\n${offenders.join('\n')}`);
});

test('导出的绑定里不许有 let/var（跨文件可变状态要挂 state）', { skip: SKIP }, () => {
  const offenders = [];
  for (const f of analyzeAll().values()) {
    for (const name of f.exported) {
      const kind = f.topLevel.get(name);
      assert.ok(kind, `${f.rel}: 导出了不存在的名字 ${name}`);
      if (kind === 'let' || kind === 'var') offenders.push(`${f.rel}: ${kind} ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `import 绑定只读，导出 let/var 等于给人埋一个 TypeError：\n${offenders.join('\n')}`);
});

test('没有任何文件写 import 出来的绑定（模块化最阴的那个坑）', { skip: SKIP }, () => {
  const offenders = [];
  for (const f of analyzeAll().values()) {
    const walk = (scope) => {
      for (const ref of scope.references) {
        const r = ref.resolved;
        const isImport = r && r.scope.type === 'module' && r.defs.some((d) => d.type === 'ImportBinding');
        if (isImport && ref.isWrite()) {
          offenders.push(`${f.rel}:${ref.identifier.loc.start.line} ${ref.isReadWrite() ? '改' : '写'} ${ref.identifier.name}`);
        }
      }
      scope.childScopes.forEach(walk);
    };
    walk(f.sm.globalScope);
  }
  assert.deepEqual(offenders, [], `ES module 的 import 绑定不可写，这些位置在浏览器里会 TypeError：\n${offenders.join('\n')}`);
});

test('模块求值期的跨文件引用不许踩 TDZ（环上的 const/let 会抛）', { skip: SKIP }, () => {
  const filesByRel = analyzeAll();
  // 文件图（含环检测）：A 引用 B 的顶层名字，且 B 的求值可能晚于 A 的顶层语句。
  const edges = new Map();
  for (const f of filesByRel.values()) edges.set(f.rel, new Set([...f.imports.values()].map((i) => i.target)));
  const onCycle = new Set();
  const stateOf = new Map();
  const stack = [];
  const dfs = (n) => {
    stateOf.set(n, 1);
    stack.push(n);
    for (const t of edges.get(n) || []) {
      if (!stateOf.has(t)) dfs(t);
      else if (stateOf.get(t) === 1) stack.slice(stack.indexOf(t)).forEach((x) => onCycle.add(x));
    }
    stack.pop();
    stateOf.set(n, 2);
  };
  for (const rel of files) if (!stateOf.has(rel)) dfs(rel);

  const offenders = [];
  for (const f of filesByRel.values()) {
    // 顶层语句（不在任何函数体里）里的引用 = 模块求值期就会执行
    const isFunc = (t) => t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression';
    const insideFunc = new WeakSet();
    const mark = (node, depth) => {
      if (!node || typeof node.type !== 'string') return;
      const d = isFunc(node.type) ? depth + 1 : depth;
      if (d > 0) insideFunc.add(node);
      for (const key of Object.keys(node)) {
        if (['loc', 'range', 'parent', 'start', 'end'].includes(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) v.forEach((c) => mark(c, d));
        else if (v && typeof v.type === 'string') mark(v, d);
      }
    };
    mark(f.ast, 0);
    const walk = (scope) => {
      for (const ref of scope.references) {
        const r = ref.resolved;
        const isImport = r && r.scope.type === 'module' && r.defs.some((d) => d.type === 'ImportBinding');
        if (!isImport || insideFunc.has(ref.identifier)) continue;
        const target = f.imports.get(ref.identifier.name)?.target;
        if (!target) continue;
        const kind = filesByRel.get(target).topLevel.get(ref.identifier.name);
        // 只有"环上的 const/let/class"真的会 TDZ；function 声明会被提升，var 是 undefined 也不抛。
        // ⚠ 这条只看**顶层语句直接引用**：顶层调用某个函数、那个函数里再读 state，它看不见
        // （2026-10-01 白屏就是这种形态）—— 那种情况靠 test/ui-real-modules.test.mjs 用真模块
        // 语义加载整棵树来抓，两条一起才是完整的网。
        if (onCycle.has(f.rel) && onCycle.has(target) && ['const', 'let', 'class'].includes(kind)) {
          offenders.push(`${f.rel}:${ref.identifier.loc.start.line} 顶层语句读 ${ref.identifier.name}（${target} 的 ${kind}，两文件在同一个环上）`);
        }
      }
      scope.childScopes.forEach(walk);
    };
    walk(f.sm.globalScope);
  }
  assert.deepEqual(offenders, [], `模块求值期会踩 TDZ（浏览器里直接白屏）：\n${offenders.join('\n')}`);
});

test('再没有文件靠改写全局包裹渲染入口（要接管请走 QARegistry）', () => {
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 有意保留的两个对外面：registry 的 QARegistry、i18n 的 QAText（都是 window.x = 显式赋值）
  const allowed = new Set([
    ['core/registry.js', 'window.QARegistry'],
    ['i18n/zh-CN.js', 'window.QAText']
  ].map(([rel, text]) => `${rel}:${text}`));
  const offenders = [];
  for (const rel of files) {
    const code = stripComments(fs.readFileSync(path.join(UI, rel), 'utf8'));
    // ⚠️ `=(?!=)`：只认赋值。原来的 `\s*=` 会把 `typeof window.addEventListener === 'function'`
    // 里的 `===` 当成"往 window 上挂东西"（2026-10-17 咬到一次假阳性；当时为了绕开它把函数
    // 检查删了，反而让 render-test 的窗口桩抛错 —— 修判据，别修被测代码）
    for (const m of code.matchAll(/window\.[A-Za-z_$][\w$]*\s*=(?!=)/g)) {
      const hit = `${rel}:${m[0].replace(/\s*=$/, '')}`;
      if (!allowed.has(hit)) offenders.push(hit);
    }
  }
  assert.deepEqual(offenders, [], `这些位置还在往 window 上挂东西：\n${offenders.join('\n')}`);
  // 判据自检：赋值要抓到、比较不许误报（两个方向都钉住，免得下次又被"改宽/改窄"骗过）
  const probe = (src) => [...src.matchAll(/window\.[A-Za-z_$][\w$]*\s*=(?!=)/g)].map((m) => m[0].replace(/\s*=$/, ''));
  assert.deepEqual(probe('window.QARegistry = {};'), ['window.QARegistry'], '赋值要被抓到');
  assert.deepEqual(probe("typeof window.addEventListener === 'function'"), [], '`===` 不是赋值');
});
