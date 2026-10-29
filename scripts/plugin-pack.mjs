#!/usr/bin/env node
// 打包 + **自测** + 生成索引条目。
//
// 三件事一次做完，作者的"发布前检查"就是这一条命令：
//   ① 打包成 ustar tar.gz（可复现：同一份源码逐字节相同）；
//   ② **真装一遍**：用宿主自己的安装器把刚打出来的包在临时目录里装一次 ——
//      "包能不能装"不靠嘴说，这一步过不了就不用往索引里提；
//   ③ 打印可直接粘进索引的 JSON（或 --index <file> --write 直接写进去）。
//
// 用法：
//   node scripts/plugin-pack.mjs ./my-plugin --base-url https://github.com/me/my-plugin --tag v0.1.0 --min-version 0.8.5 --tags 工具
//   node scripts/plugin-pack.mjs ./my-plugin --index ../qq-agent-plugins/plugins/index.json --write
//   node scripts/plugin-pack.mjs ./my-plugin --json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexEntryFor, packPluginDir } from '../src/plugins/pack.js';
import { installPlugin } from '../src/plugins/install.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const has = (name) => args.includes(`--${name}`);
const asJson = has('json');

if (!dir) {
  console.error('用法：node scripts/plugin-pack.mjs <插件目录> [--out 目录] [--base-url 仓库地址] [--tag vX.Y.Z] [--min-version 0.8.5] [--tags a,b] [--author 名字] [--homepage 链接] [--index 索引文件 --write] [--json]');
  process.exit(2);
}

const out = (payload) => console.log(asJson ? JSON.stringify(payload) : payload.text);
const goodbye = (ok, payload) => { out(payload); process.exit(ok ? 0 : 1); };

let packed = null;
try {
  // 给了 --index 时默认落到索引仓库的 plugins/packages/（verify-index 要求仓库里有这份产物）；
  // 没给才落在插件目录旁边（作者一眼能找到）。--out 永远优先。
  const indexFile = flag('index');
  const defaultOut = indexFile
    ? path.join(path.dirname(path.resolve(indexFile)), 'packages')
    : path.dirname(path.resolve(dir));
  packed = packPluginDir({
    dir,
    outDir: path.resolve(flag('out') || defaultOut)
  });
} catch (error) {
  goodbye(false, { ok: false, error: error?.message ?? String(error), code: error?.code || '' , text: `✗ 打包失败：${error?.message ?? error}` });
}

// ② 真装一遍：用宿主自己的安装器（同一个 parseTarGz + manifest 校验 + 原子换入）
// 沙盒建不出来（TMP 不可写、磁盘满）也算自测没过：**没验过就说验过了**比直接报错危险得多。
let selfTest = { ok: false, error: '' };
let sandbox = '';
try {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-selftest-'));
  const installed = await installPlugin({ tarball: packed.buffer, id: packed.id, dataDir: sandbox, log: () => {} });
  const installedManifest = JSON.parse(fs.readFileSync(path.join(sandbox, 'plugins', installed.id, 'plugin.json'), 'utf8'));
  selfTest = installedManifest.id === packed.id
    ? { ok: true, error: '' }
    : { ok: false, error: `装出来的 id（${installedManifest.id}）与打包的不一致` };
} catch (error) {
  selfTest = { ok: false, error: error?.message ?? String(error) };
} finally {
  if (sandbox) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ }
  }
}

const tags = flag('tags') ? flag('tags').split(',').map((t) => t.trim()).filter(Boolean) : [];
const entry = indexEntryFor(packed, {
  baseUrl: flag('base-url'),
  tag: flag('tag'),
  minVersion: flag('min-version'),
  tags,
  author: flag('author'),
  homepage: flag('homepage')
});

// ③ 写索引（按 id 合并，不是整条替换）
let indexResult = null;
const indexFile = flag('index');
if (indexFile) {
  const file = path.resolve(indexFile);
  try {
    const index = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, plugins: [] };
    if (!Array.isArray(index.plugins)) throw new Error('索引里的 plugins 不是数组');
    const before = index.plugins.length;
    const at = index.plugins.findIndex((item) => item && item.id === entry.id);
    // 写进去的那份：丢掉模板占位符（它们会原样进市场），并且**不要让默认值冲掉条目里已有的值**
    //（整条替换是老实现：会顺手清掉 revoked / publisher / signature / category / readme ——
    //  一个被撤回的插件会因为"重新打了一次包"而重新变成可安装，签名信任链也会静默降级）
    const writable = { ...entry };
    for (const [field, value] of Object.entries(writable)) {
      if (typeof value === 'string' && /^<[^>]*>$/.test(value.trim())) delete writable[field];
    }
    if (!tags.length) delete writable.tags;                       // 默认 ['社区'] 不该覆盖原有分类标签
    if (!flag('min-version') && at !== -1) delete writable.minVersion;   // 已上架条目保留自己的门控
    if (at === -1 && !writable.minVersion) writable.minVersion = '0.8.5';
    if (at === -1) index.plugins.push(writable);
    else index.plugins[at] = { ...index.plugins[at], ...writable };
    index.updatedAt = new Date().toISOString().slice(0, 10);
    if (has('write')) {
      // 自测没过就别写：文档承诺"自测不过别往索引里提"，脚本自己更不能先写再退
      if (!selfTest.ok) {
        indexResult = { file, action: 'skipped', count: index.plugins.length, reason: '自测没过，未写入索引' };
      } else {
        fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
        indexResult = { file, action: at === -1 ? 'added' : 'updated', count: index.plugins.length };
      }
    } else {
      indexResult = { file, action: 'preview', wouldBe: at === -1 ? 'added' : 'updated', count: index.plugins.length, before };
    }
  } catch (error) {
    goodbye(false, { ok: false, error: `写索引失败：${error?.message ?? error}`, text: `✗ 写索引失败：${error?.message ?? error}` });
  }
}

// 占位符提醒（不拦）：骨架生成的一句话描述/主页如果没改，就会原样进市场 ——
// 用户看到的是「演示插件（一句话说清它给机器人加了什么能力）」。自测管不了这个。
const placeholders = [];
if (/一句话说清/.test(String(entry.description || ''))) placeholders.push('description 还是骨架里的占位句');
if (/^<.*>$/.test(String(entry.homepage || ''))) placeholders.push('homepage 还是 <占位符>');
if (/^<.*>$/.test(String(entry.author || ''))) placeholders.push('author 还是 <占位符>');
if (/^<.*>$/.test(String(entry.minVersion || ''))) placeholders.push('minVersion 还是 <占位符>（它会原样写进索引，宿主会把这个插件判成"装不了"）');
if (/^<.*>$/.test(String(entry.downloadUrl || ''))) placeholders.push('downloadUrl 还是 <占位符>（没有 --base-url / --tag 时生成不出来，写进索引也没法装）');

const text = [
  selfTest.ok ? '✓ 自测：这个包装得上（用宿主自己的安装器在临时目录里真装了一次）' : `✗ 自测没过：${selfTest.error}`,
  `  包：${packed.file || '(未落盘)'}`,
  `  大小：${(packed.bytes / 1024).toFixed(1)}KB，文件 ${packed.fileCount} 个`,
  `  sha256：${packed.sha256}`,
  '',
  '把下面这段粘进索引（plugins/index.json 的 plugins 数组里），或加 --index <文件> --write 让我直接写：',
  JSON.stringify(entry, null, 2),
  indexResult ? `\n索引：${indexResult.action} → ${indexResult.file}（现在共 ${indexResult.count} 条）` : '',
  placeholders.length ? `\n⚠️ 上架前改掉这几处（它们会原样显示给使用者）：${placeholders.join('；')}` : ''
].filter(Boolean).join('\n');

goodbye(selfTest.ok, {
  ok: selfTest.ok,
  selfTest,
  id: packed.id,
  version: packed.version,
  file: packed.file,
  bytes: packed.bytes,
  sha256: packed.sha256,
  entry,
  index: indexResult,
  text
});
