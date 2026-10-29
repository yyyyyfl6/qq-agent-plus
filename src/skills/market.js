// 技能市场：索引只提供元数据与文件哈希，安装时逐文件下载并校验。
// 技能不执行代码，所以这里不需要插件那套授权体系；但仍然限制体积、路径和来源，
// 装错的技能最多是"流程写得不对"，不能变成读写宿主文件。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config.js';
import { safeFetchRequest } from '../llm/safe-fetch.js';
import { createIndexTextFetcher } from '../plugins/index-fetch.js';
import { getSkillRegistry, skillUserDir, validateSkillDir } from './registry.js';

const MAX_INDEX_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FILES = 8;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_VERSION = 2;
const STALE_FALLBACK_MS = 7 * 86400000;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const FILE_KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;

const clean = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

let memoryCache = { url: '', at: 0, payload: null };
// 后台刷新去重：过期缓存先返回旧数据，同一 URL 只允许一个刷新请求在飞。
let refreshInFlight = { url: '', promise: null };

function cacheFile() {
  return path.join(skillUserDir(), '.market-cache.json');
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function packageHash(files) {
  return hash(Object.keys(files).sort().map((name) => `${name}:${files[name].sha256}`).join('\n'));
}

function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value || '').trim().replace(/^[vV]/, '').split('+')[0];
    const dash = text.indexOf('-');
    const core = (dash >= 0 ? text.slice(0, dash) : text).split('.').map((n) => Number(n) || 0);
    return { core, pre: dash >= 0 ? text.slice(dash + 1) : '' };
  };
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a.core[i] || 0) !== (b.core[i] || 0)) return (a.core[i] || 0) > (b.core[i] || 0) ? 1 : -1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}

function textFetcher(maxBytes) {
  const allowPrivate = getConfig().skills?.allowPrivateIndex === true;
  return createIndexTextFetcher({
    fetchImpl: (url, options = {}) => safeFetchRequest(url, {
      maxBytes: options.maxBytes ?? maxBytes,
      signal: options.signal,
      headers: options.headers,
      allowPrivate
    }),
    maxBytes
  });
}

function resolveFileUrl(indexUrl, value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('文件缺少地址');
  const url = new URL(raw, indexUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('文件地址只允许 http/https');
  return url.toString();
}

function normalizeIndex(raw, indexUrl) {
  if (!isPlainObject(raw)) throw new Error('技能索引必须是 JSON 对象');
  const list = Array.isArray(raw.skills) ? raw.skills : [];
  if (!list.length) throw new Error('技能索引里没有技能');
  const skills = [];
  const seen = new Set();
  for (const item of list.slice(0, 200)) {
    if (!isPlainObject(item)) continue;
    const id = clean(item.id, 80);
    if (!SKILL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const files = {};
    if (isPlainObject(item.files)) {
      for (const [name, meta] of Object.entries(item.files).slice(0, MAX_FILES)) {
        if (!FILE_KEY_RE.test(name) || name.startsWith('.') || !/\.(json|md)$/i.test(name)) continue;
        if (!isPlainObject(meta)) continue;
        const sha256 = String(meta.sha256 || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256)) continue;
        const bytes = Number(meta.bytes);
        if (Number.isFinite(bytes) && (bytes <= 0 || bytes > MAX_FILE_BYTES)) continue;
        try {
          files[name] = { url: resolveFileUrl(indexUrl, meta.url || meta.path), sha256, bytes: Number.isFinite(bytes) ? bytes : 0 };
        } catch { /* 单个坏文件跳过，安装时缺文件会失败 */ }
      }
    }
    if (!files['skill.json']) continue;
    const allowedTools = Array.isArray(item.allowedTools) ? item.allowedTools.map((t) => clean(t, 64)).filter(Boolean).slice(0, 40) : [];
    const triggers = Array.isArray(item.triggers) ? item.triggers.map((t) => clean(t, 40)).filter(Boolean).slice(0, 30) : [];
    skills.push({
      id,
      name: clean(item.name, 60) || id,
      description: clean(item.description, 200),
      version: clean(item.version, 32) || '1.0.0',
      author: clean(item.author, 80),
      category: clean(item.category, 40) || '其他',
      homepage: clean(item.homepage, 300),
      preview: clean(item.preview, 2000),
      allowedTools,
      triggers,
      files,
      sha256: packageHash(files)
    });
  }
  if (!skills.length) throw new Error('技能索引里没有可用条目');
  return {
    version: Number(raw.version) || 1,
    name: clean(raw.name, 80) || '技能索引',
    updatedAt: clean(raw.updatedAt, 40),
    skills
  };
}

function readFileCache(url) {
  try {
    const text = fs.readFileSync(cacheFile(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed?.url !== url || parsed?.cacheVersion !== CACHE_VERSION || !isPlainObject(parsed.payload)) return null;
    return { at: Number(parsed.at) || 0, index: normalizeIndex(parsed.payload, url) };
  } catch { return null; }
}

function writeFileCache(url, index, at) {
  try {
    const dir = skillUserDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = cacheFile();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ cacheVersion: CACHE_VERSION, url, at, payload: { version: index.version, name: index.name, updatedAt: index.updatedAt, skills: index.skills } }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch { /* 缓存写失败不影响本次结果 */ }
}

export function resetMarketCacheForTests() {
  memoryCache = { url: '', at: 0, payload: null };
  refreshInFlight = { url: '', promise: null };
  try { fs.rmSync(cacheFile(), { force: true }); } catch { /* 忽略 */ }
}

export function marketIndexUrl() {
  return String(getConfig().skills?.indexUrl || '').trim();
}

async function fetchMarketIndex(url) {
  const response = await textFetcher(MAX_INDEX_BYTES)(url);
  if (response.statusCode !== 200) throw new Error(`索引 HTTP ${response.statusCode}`);
  if (response.truncated) throw new Error('索引超过 256KB 上限');
  const raw = JSON.parse(response.body);
  // 相对文件路径必须按用户配置的索引地址解析。API 兜底时 response.url 是
  // api.github.com/contents/...，拿它当 base 会把文件地址变成 JSON 信封地址，
  // 下载到的不是原文件，sha256 必然不匹配。
  const index = normalizeIndex(raw, url);
  const at = Date.now();
  memoryCache = { url, at, payload: index };
  writeFileCache(url, index, at);
  return { index, fetchedAt: at, stale: false, url };
}

function sharedMarketFetch(url) {
  if (refreshInFlight.url === url && refreshInFlight.promise) return refreshInFlight.promise;
  const promise = fetchMarketIndex(url);
  refreshInFlight = { url, promise };
  void promise.finally(() => {
    if (refreshInFlight.promise === promise) refreshInFlight = { url: '', promise: null };
  }).catch(() => {});
  return promise;
}

function refreshMarketIndexInBackground(url) {
  return sharedMarketFetch(url).catch(() => null);
}

/**
 * 启动预热：只负责把索引放进内存/文件缓存，不阻塞启动。
 * GitHub raw 从机房偶发 20 秒超时；首次打开技能市场不应该替这个等待买单。
 */
export function warmMarketIndex() {
  const url = marketIndexUrl();
  if (!url) return Promise.resolve(null);
  const now = Date.now();
  if (memoryCache.url === url && memoryCache.payload && now - memoryCache.at < CACHE_TTL_MS) {
    return Promise.resolve(null);
  }
  const fileCache = readFileCache(url);
  if (fileCache && now - fileCache.at < CACHE_TTL_MS) {
    memoryCache = { url, at: fileCache.at, payload: fileCache.index };
    return Promise.resolve(null);
  }
  return refreshMarketIndexInBackground(url);
}

export async function loadMarketIndex({ force = false } = {}) {
  const url = marketIndexUrl();
  if (!url) throw new Error('未配置技能索引地址（设置 → 技能 → 索引地址）');
  const now = Date.now();
  if (!force && memoryCache.url === url && memoryCache.payload && now - memoryCache.at < CACHE_TTL_MS) {
    return { index: memoryCache.payload, fetchedAt: memoryCache.at, stale: false, url };
  }
  const fileCache = readFileCache(url);
  if (!force && fileCache && now - fileCache.at < CACHE_TTL_MS) {
    memoryCache = { url, at: fileCache.at, payload: fileCache.index };
    return { index: fileCache.index, fetchedAt: fileCache.at, stale: false, url };
  }
  // 缓存过期：先把旧索引给页面，后台再刷新。GitHub raw 超时就 next time 再说，
  // 页面不再为了"确认有没有新技能"干等 20 秒。
  if (!force && fileCache && now - fileCache.at < STALE_FALLBACK_MS) {
    memoryCache = { url, at: fileCache.at, payload: fileCache.index };
    void refreshMarketIndexInBackground(url);
    return { index: fileCache.index, fetchedAt: fileCache.at, stale: true, url, refreshing: true };
  }
  try {
    return await sharedMarketFetch(url);
  } catch (error) {
    if (fileCache && now - fileCache.at < STALE_FALLBACK_MS) {
      memoryCache = { url, at: fileCache.at, payload: fileCache.index };
      return { index: fileCache.index, fetchedAt: fileCache.at, stale: true, url, error: String(error?.message || error) };
    }
    if (memoryCache.url === url && memoryCache.payload) {
      return { index: memoryCache.payload, fetchedAt: memoryCache.at, stale: true, url, error: String(error?.message || error) };
    }
    throw new Error(`读取技能索引失败：${error?.message || error}`);
  }
}

export async function listMarketSkills({ force = false } = {}) {
  const { index, fetchedAt, stale, url, error } = await loadMarketIndex({ force });
  const registry = getSkillRegistry();
  const installedList = registry.list();
  const installed = new Map(installedList.map((skill) => [skill.id, skill]));
  const indexedIds = new Set(index.skills.map((entry) => entry.id));
  const localOnly = installedList.filter((skill) => !indexedIds.has(skill.id)).map((skill) => ({
    ...skill,
    installed: true,
    installedVersion: skill.version,
    installedSource: skill.source,
    builtin: skill.source === 'builtin',
    localOnly: true,
    files: {},
    sha256: '',
    author: '',
    category: '本地',
    homepage: ''
  }));
  return {
    ok: true,
    index: { name: index.name, updatedAt: index.updatedAt, url, fetchedAt, stale, error: error || '' },
    skills: [...index.skills.map((entry) => {
      const current = installed.get(entry.id);
      return {
        ...entry,
        installed: Boolean(current),
        installedVersion: current?.version || '',
        installedSource: current?.source || '',
        builtin: current?.source === 'builtin',
        updateAvailable: Boolean(current && compareVersions(entry.version, current.version) > 0)
      };
    }), ...localOnly]
  };
}

function findEntry(index, id) {
  const key = String(id || '').trim();
  const entry = index.skills.find((item) => item.id === key);
  if (!entry) throw new Error('索引里没有这个技能');
  return entry;
}

async function downloadFile(file, fetchFn) {
  const result = await fetchFn(file.url);
  if (result.statusCode !== 200) throw new Error(`技能文件 HTTP ${result.statusCode}`);
  if (result.truncated) throw new Error('技能文件超过 128KB 上限');
  const text = String(result.body || '');
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  if (digest !== file.sha256) throw new Error('文件哈希不匹配，已拒绝安装');
  if (!text.trim()) throw new Error('技能文件为空');
  if (text.includes('\0')) throw new Error('技能文件含 NUL 字符');
  return text;
}

async function downloadPackage(entry, fetchFn) {
  const names = Object.keys(entry.files);
  let total = 0;
  const files = {};
  for (const name of names) {
    const text = await downloadFile(entry.files[name], fetchFn);
    total += Buffer.byteLength(text, 'utf8');
    if (total > MAX_TOTAL_BYTES) throw new Error('技能包总大小超过 512KB 上限');
    files[name] = text;
  }
  return files;
}

function writePackage(dir, files) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  }
}

function removeQuietly(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
}

function publicEntry(entry) {
  return {
    ...entry,
    files: Object.fromEntries(Object.entries(entry.files).map(([name, meta]) => [name, { sha256: meta.sha256, bytes: meta.bytes }]))
  };
}

export async function previewMarketSkill(id, { full = false } = {}) {
  const { index, url, fetchedAt, stale } = await loadMarketIndex();
  const entry = findEntry(index, id);
  const manifest = {
    id: entry.id, name: entry.name, version: entry.version,
    description: entry.description, allowedTools: entry.allowedTools, triggers: entry.triggers
  };
  // 默认只返回索引里的摘要：查看详情不应该先把整个技能包下载一遍。
  if (!full) {
    return {
      ok: true, url, fetchedAt, stale, previewOnly: true,
      entry: publicEntry(entry),
      instructions: entry.preview || '',
      manifest
    };
  }
  // 只有明确点“加载完整 SKILL.md”时才下载 manifest 和说明文件，不碰其余文件。
  const fetcher = textFetcher(MAX_FILE_BYTES);
  const manifestText = await downloadFile(entry.files['skill.json'], fetcher);
  const rawManifest = JSON.parse(manifestText);
  const instructionsName = String(rawManifest.instructions || 'SKILL.md').trim();
  if (!entry.files[instructionsName]) throw new Error('索引缺少 SKILL.md 文件条目');
  const instructions = await downloadFile(entry.files[instructionsName], fetcher);
  return {
    ok: true, url, fetchedAt, stale, previewOnly: false,
    entry: publicEntry(entry),
    instructions: String(instructions).slice(0, 12000),
    manifest: {
      id: rawManifest.id, name: rawManifest.name, version: rawManifest.version,
      description: rawManifest.description, allowedTools: rawManifest.allowedTools || [], triggers: rawManifest.triggers || []
    }
  };
}

export async function installMarketSkill({ id, expectedSha256 = '', confirm = false } = {}) {
  if (confirm !== true) throw new Error('安装技能需要确认');
  const { index, url } = await loadMarketIndex();
  const entry = findEntry(index, id);
  if (expectedSha256 && String(expectedSha256) !== entry.sha256) {
    throw new Error('索引内容已变化，请刷新市场后重新确认');
  }
  const registry = getSkillRegistry();
  const current = registry.get(entry.id);
  if (current?.source === 'builtin') throw new Error('这是内置技能，不能从市场覆盖');
  const files = await downloadPackage(entry, textFetcher(MAX_FILE_BYTES));
  const userDir = skillUserDir();
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const temp = path.join(userDir, `.tmp-${entry.id}-${process.pid}-${Date.now()}`);
  const target = path.join(userDir, entry.id);
  const backup = path.join(userDir, `.backup-${entry.id}-${Date.now()}`);
  writePackage(temp, files);
  try {
    const validated = validateSkillDir(temp);
    if (validated.id !== entry.id) throw new Error('manifest 的 id 与索引不一致');
  } catch (error) {
    removeQuietly(temp);
    throw new Error(`技能包校验失败：${error?.message || error}`);
  }
  let movedOld = false;
  try {
    if (fs.existsSync(target)) { fs.renameSync(target, backup); movedOld = true; }
    fs.renameSync(temp, target);
    registry.reload();
    const installed = registry.get(entry.id);
    if (!installed || installed.source !== 'user') throw new Error('安装后未能加载，已回滚');
    removeQuietly(backup);
    return { ok: true, updated: Boolean(current), skill: registry.list().find((skill) => skill.id === entry.id), sourceUrl: url };
  } catch (error) {
    removeQuietly(target);
    if (movedOld) { try { fs.renameSync(backup, target); } catch { /* 忽略 */ } }
    registry.reload();
    throw error;
  } finally {
    removeQuietly(temp);
  }
}

export async function uninstallMarketSkill({ id, confirm = false } = {}) {
  if (confirm !== true) throw new Error('卸载技能需要确认');
  const registry = getSkillRegistry();
  const skill = registry.get(String(id || '').trim());
  if (!skill) throw new Error('技能不存在');
  if (skill.source !== 'user') throw new Error('内置技能不能卸载；可以停用');
  const userDir = path.resolve(skillUserDir());
  const target = path.resolve(userDir, skill.id);
  if (path.dirname(target) !== userDir) throw new Error('技能路径非法');
  const removed = path.join(userDir, `.removed-${skill.id}-${Date.now()}`);
  if (fs.existsSync(target)) fs.renameSync(target, removed);
  registry.reload();
  if (registry.get(skill.id)) {
    if (fs.existsSync(removed)) { try { fs.renameSync(removed, target); } catch { /* 忽略 */ } }
    throw new Error('卸载后技能仍在加载，已回滚');
  }
  removeQuietly(removed);
  return { ok: true, id: skill.id };
}
