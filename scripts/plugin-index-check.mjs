#!/usr/bin/env node
// 索引体检：把索引文件当**要发布的东西**来检查（作者提索引 PR、CI 门禁、发版前自查都用它）。
//
// 查三类：
//   ① 结构：必填字段、id/version/sha256 形状、重复 id、地址是不是 http(s)；
//   ② 兼容：每条声明的 apiVersion / minVersion 与**本仓库当前状态**比 —— 结果是"能装/不能装"，
//      不能装不一定是错（可能条目本来就要求更新的宿主），所以按 warn 报，但会打印出来；
//   ③ 一致（`--verify-local`，默认开）：索引里指向仓库内产物的条目，必须与现打一份源码的结果
//      逐字节一致 —— 改了源码忘了重打包是最容易发生、也最难看出来的一种坏（用户装到旧包）。
//      `--verify-remote` 额外把每个 downloadUrl 真下载下来核对 sha256（要联网，CI 里可选）。
//
// 用法：
//   node scripts/plugin-index-check.mjs                          # 体检官方索引（含仓库内产物一致性）
//   node scripts/plugin-index-check.mjs path/to/index.json
//   node scripts/plugin-index-check.mjs --verify-remote           # 额外真下载核对
//   node scripts/plugin-index-check.mjs --json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePluginIndex } from '../src/plugins/install.js';
import { PLUGIN_API_VERSION } from '../src/plugins/manifest.js';
import { packPluginDir } from '../src/plugins/pack.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const asJson = has('json');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(repoRoot, 'plugins', 'index.json'));

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const errors = [];
const warnings = [];
const infos = [];
const error = (code, message) => errors.push({ code, message });
const warn = (code, message) => warnings.push({ code, message });
const info = (message) => infos.push(message);

let parsed = null;
try {
  parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  error('E_READ', `索引读不了或不是合法 JSON：${err?.message ?? err}`);
}

let entries = [];
let skipped = [];
if (parsed) {
  try {
    const normalized = normalizePluginIndex(parsed, {
      apiVersion: PLUGIN_API_VERSION, hostVersion: pkg.version, source: path.basename(file)
    });
    entries = normalized.entries;
    skipped = normalized.skipped;
  } catch (err) {
    error('E_SHAPE', err?.message ?? String(err));
  }
  if (parsed.version !== undefined && Number(parsed.version) !== 1) {
    warn('W_INDEX_VERSION', `索引文档版本是 ${JSON.stringify(parsed.version)}，本工具只认识 1（未知字段会被忽略，但形状变了要同步改读取器）`);
  }
  for (const item of skipped) error('E_ENTRY', `${item.id || '(没有 id)'} 用不了：${item.reason}`);
  const seen = new Map();
  for (const item of entries) {
    if (seen.has(item.id)) error('E_DUPLICATE', `同 id 出现两次：${item.id}（v${seen.get(item.id)} 与 v${item.version}）`);
    seen.set(item.id, item.version);
    if (!item.version) warn('W_NO_VERSION', `${item.id} 没写 version`);
    if (!item.description) warn('W_NO_DESCRIPTION', `${item.id} 没写 description（页面上会是一片空白）`);
    if (item.compatible === false) warn('W_INCOMPATIBLE', `${item.id} 本机装不了：${item.reason}`);
    else info(`${item.id} v${item.version || '(未标版本)'} → 可安装（${item.url}）`);
  }
}

// ③ 仓库内产物一致性：downloadUrl 指向本仓 `main` 分支的 raw 地址时，找出对应文件现打一遍比对
const verifyLocal = !has('no-verify-local');
const localArtifacts = [];
if (verifyLocal && entries.length) {
  for (const item of entries) {
    const match = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:refs\/heads\/)?[^/]+\/(.+)$/.exec(item.url);
    const rel = match ? decodeURIComponent(match[1]) : '';
    const candidate = rel ? path.join(repoRoot, rel) : '';
    if (!candidate || !fs.existsSync(candidate)) continue;
    const bytes = fs.readFileSync(candidate);
    const { sha256Of } = await import('../src/plugins/install.js');
    const actual = sha256Of(bytes);
    if (actual !== item.sha256) {
      error('E_ARTIFACT_DRIFT', `${item.id}：索引里的 sha256（${item.sha256.slice(0, 12)}…）与仓库里那份产物（${actual.slice(0, 12)}…）不一致 —— 换过包忘了改索引，或改过索引忘了重打包`);
    } else {
      info(`${item.id}：仓库内产物 ${rel} 与索引里的 sha256 一致`);
    }
    // 现打一遍源码：产物必须是"现在这份源码"打出来的（否则用户装到的是旧包）
    const sourceDir = path.join(repoRoot, 'examples', 'plugins', item.id);
    if (fs.existsSync(path.join(sourceDir, 'plugin.json'))) {
      try {
        const fresh = packPluginDir({ dir: sourceDir });
        if (fresh.sha256 !== actual) {
          error('E_SOURCE_DRIFT', `${item.id}：现打源码得到的 sha256（${fresh.sha256.slice(0, 12)}…）与仓库里那份产物（${actual.slice(0, 12)}…）不一致 —— 重跑 node scripts/plugin-pack.mjs examples/plugins/${item.id} --out plugins/packages`);
        } else {
          info(`${item.id}：仓库内产物与 examples/plugins/${item.id} 现打的结果一致`);
        }
        if (fresh.manifest.version !== item.version) {
          error('E_VERSION_DRIFT', `${item.id}：manifest 版本（${fresh.manifest.version}）与索引条目（${item.version}）不一致`);
        }
        if (JSON.stringify(fresh.manifest.capabilities) !== JSON.stringify(item.capabilities)) {
          warn('W_CAP_DRIFT', `${item.id}：索引里的 capabilities 与 manifest 不一致（页面展示会误导使用者）`);
        }
      } catch (err) {
        error('E_PACK', `${item.id}：现打源码失败 —— ${err?.message ?? err}`);
      }
    }
    localArtifacts.push({ id: item.id, rel });
  }
}

// ── 可选：真下载核对（联网；CI 里可以不开）───────────────────────────────────
const remote = [];
if (has('verify-remote') && entries.length) {
  const { safeFetchBinary } = await import('../src/llm/safe-fetch.js');
  const { sha256Of, MAX_PLUGIN_ARCHIVE_BYTES } = await import('../src/plugins/install.js');
  for (const item of entries) {
    try {
      const downloaded = await safeFetchBinary(item.url, MAX_PLUGIN_ARCHIVE_BYTES);
      const buffer = downloaded?.buffer ?? Buffer.alloc(0);
      const actual = sha256Of(buffer);
      if (actual !== item.sha256) error('E_REMOTE_MISMATCH', `${item.id}：下载到的内容 sha256（${actual.slice(0, 12)}…）与索引里的（${item.sha256.slice(0, 12)}…）不符`);
      else info(`${item.id}：远端下载核对通过（${(buffer.length / 1024).toFixed(1)}KB）`);
      remote.push({ id: item.id, ok: actual === item.sha256, bytes: buffer.length });
    } catch (err) {
      error('E_REMOTE', `${item.id}：下载失败 —— ${err?.message ?? err}`);
      remote.push({ id: item.id, ok: false, bytes: 0 });
    }
  }
}

const ok = errors.length === 0;
const text = [
  `${ok ? '✓' : '✗'} 索引体检：${file}`,
  `  条目 ${entries.length} 条，块掉 ${skipped.length} 条，宿主版本 ${pkg.version}（插件 API v${PLUGIN_API_VERSION}）`,
  ...infos.map((line) => `  · ${line}`),
  ...warnings.map((item) => `  ⚠ [${item.code}] ${item.message}`),
  ...errors.map((item) => `  ✗ [${item.code}] ${item.message}`),
  ok ? '结论：可以上架。' : `结论：有 ${errors.length} 处必须修（上面 ✗ 那些）。`
].join('\n');

console.log(asJson
  ? JSON.stringify({ ok, file, entries: entries.length, skipped, errors, warnings, infos, remote, localArtifacts })
  : text);
process.exit(ok ? 0 : 1);
