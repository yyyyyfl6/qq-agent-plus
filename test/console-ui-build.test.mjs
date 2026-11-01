// 控制台"前端构建戳"的单元测试。
//
// 这个戳的用途是：/api/status 带上它，前端轮询发现它变了就提示"控制台已更新，点此刷新"
// —— 控制台是单页应用，部署（尤其"只同步 ui/、不重启服务"那条路）不会自动替换已打开的页面。
//
// 为什么要单独测：它原来写死了 6 个文件名，**漏掉了 ui/pages/*.js 与 ui/core/*.js** ——
// 而那才是改得最勤的（2026-10-16 改的正是 pages/plugins.js，戳不变 → 已打开的页面永远收不到
// 刷新提示，"不重启也能上前端"这条路的收益等于零）。当时**没有任何用例覆盖它**，
// 是靠人肉发现的（变异验证时"把递归枚举改回写死清单"竟然全绿）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { uiBuildStamp } = await import('../src/console/ui-build.js');

test('构建戳：ui/ 下任意位置的文件变了，戳就得变（含 pages/ 与 core/）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-uibuild-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'pages', 'plugins.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'core', 'dom.js'), 'export const b = 1;\n');

  const base = uiBuildStamp(dir);
  assert.match(base, /pages\/plugins\.js/, 'pages/ 下的模块必须在戳里（这条就是漏过的那个）');
  assert.match(base, /core\/dom\.js/, 'core/ 下的模块也必须在戳里');
  assert.match(base, /index\.html/, '根下的入口也要在');

  // 改一个**深层**文件：只动体积（mtime 在 1ms 内可能不变，所以改长度最稳）
  fs.writeFileSync(path.join(dir, 'pages', 'plugins.js'), 'export const a = 1;\nexport const c = 2;\n');
  assert.notEqual(uiBuildStamp(dir), base, 'pages/ 下的文件变了，戳必须跟着变');

  // 新增一个文件同样要能体现（不然"新加了一个页面模块"不会被发现）
  const afterEdit = uiBuildStamp(dir);
  fs.writeFileSync(path.join(dir, 'core', 'icons.js'), 'export const d = 1;\n');
  assert.notEqual(uiBuildStamp(dir), afterEdit, '新增文件也要让戳变');

  // 非前端资源不该干扰（图片/字体这类改了不用提示刷新）
  const beforeNoise = uiBuildStamp(dir);
  fs.writeFileSync(path.join(dir, 'logo.png'), 'x');
  fs.writeFileSync(path.join(dir, '.hidden.js'), 'x');
  assert.equal(uiBuildStamp(dir), beforeNoise, '图片与点开头的文件不算进戳');

  // 目录不存在时不抛错（部署期间的一瞬间可能读不到）
  assert.doesNotThrow(() => uiBuildStamp(path.join(dir, 'nope')));
});
