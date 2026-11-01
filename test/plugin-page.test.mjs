// 插件接口 v3 的 page 能力：manifest 校验（entry 必须是插件目录里的 .html）与前端沙箱的关键属性。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePluginManifest } from '../src/plugins/manifest.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const base = { id: 'demo', name: '演示', version: '1.0.0' };

test('page：只有 v3 能声明；entry 必须是插件目录内的 .html；标题默认插件名', () => {
  const dir = path.join(ROOT, 'fixtures-plugin-page');
  assert.equal(parsePluginManifest({ ...base, apiVersion: 2, capabilities: ['page'], page: { entry: 'p.html' } }, { dir }).ok, false);
  assert.match(parsePluginManifest({ ...base, apiVersion: 3, capabilities: ['page'] }, { dir }).error, /page\.entry/);
  assert.match(parsePluginManifest({ ...base, apiVersion: 3, capabilities: ['page'], page: { entry: 'p.js' } }, { dir }).error, /page\.entry/);
  assert.match(parsePluginManifest({ ...base, apiVersion: 3, capabilities: ['page'], page: { entry: '../../x.html' } }, { dir }).error, /插件目录内/);
  const ok = parsePluginManifest({ ...base, apiVersion: 3, capabilities: ['page'], page: { entry: 'p.html' } }, { dir });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.page.entry, path.join(dir, 'p.html'));
  assert.equal(ok.manifest.page.title, '演示');
});

test('前端沙箱：iframe 不给 same-origin、注入 CSP 断网、只认自己建的窗口', () => {
  const src = fs.readFileSync(path.join(ROOT, '..', 'ui', 'pages', 'plugin-page.js'), 'utf8');
  const sandbox = /setAttribute\('sandbox', '([^']+)'\)/.exec(src)?.[1] || '';
  assert.ok(sandbox.split(' ').includes('allow-scripts'));
  assert.ok(!sandbox.includes('allow-same-origin'), '给了 same-origin 页面就能读控制台令牌');
  assert.ok(!sandbox.includes('allow-top-navigation') && !sandbox.includes('allow-popups') && !sandbox.includes('allow-forms'));
  assert.match(src, /default-src 'none'/, 'CSP 默认全禁（页面发不出网络请求）');
  assert.match(src, /frames\.get\(event\.source\)/, '只处理自己建的 iframe 发来的消息');
  assert.match(src, /\/api\/plugins\/page-rpc/, '页面只能经 page-rpc 调它自己的插件');
});
