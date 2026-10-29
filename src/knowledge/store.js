// 轻量知识库：只读 data/knowledge 下的 .md/.txt，按关键词 + 中文二元组检索。
// 不引入向量库/embedding：语料少时关键词更可控，也避免多一套 Key 与索引运维。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';

const EXTS = new Set(['.md', '.txt']);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = 5000;
const CACHE_TTL_MS = 10000;

let cache = { dir: '', sig: '', chunks: [], files: 0, updatedAt: 0, checkedAt: 0 };

export function knowledgeDir(cfg = getConfig()) {
  const raw = String(cfg?.knowledge?.dir || '').trim();
  return raw ? path.resolve(raw) : path.join(DATA_DIR, 'knowledge');
}

export function knowledgeEnabled(cfg = getConfig()) {
  if (cfg?.knowledge?.enabled !== true) return false;
  try { return fs.statSync(knowledgeDir(cfg)).isDirectory(); } catch { return false; }
}

function listFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3 || out.length >= MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile() || !EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function signature(files) {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${path.relative(knowledgeDir(), file)}:${stat.size}:${stat.mtimeMs}`;
    } catch { return `${file}:0:0`; }
  }).join('|');
}

export function chunkText(text, chunkChars = 900, overlapChars = 120) {
  const size = Math.max(200, Math.min(4000, Number(chunkChars) || 900));
  const overlap = Math.max(0, Math.min(Math.floor(size / 2), Number(overlapChars) || 0));
  const paragraphs = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (!current) current = paragraph;
    else if (current.length + paragraph.length + 2 <= size) current += `\n\n${paragraph}`;
    else {
      if (current.trim()) chunks.push(current.trim());
      current = paragraph;
    }
    while (current.length > size) {
      const head = current.slice(0, size).trim();
      if (head) chunks.push(head);
      current = current.slice(size - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function queryTerms(query) {
  const lower = String(query || '').toLowerCase();
  const out = new Set();
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) out.add(match[0]);
  // 按标点/空白分段后再取二元组，避免「禁言。广告」拼出跨句的「言广」。
  for (const piece of lower.split(/[^\u4e00-\u9fff]+/)) {
    if (!piece) continue;
    if (piece.length === 1) { out.add(piece); continue; }
    for (let i = 0; i + 2 <= piece.length; i += 1) out.add(piece.slice(i, i + 2));
  }
  return [...out].slice(0, 40);
}

function snippetOf(text, terms) {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (index < 0 || at < index)) index = at;
  }
  if (index < 0) return text.slice(0, 500);
  const start = Math.max(0, index - 200);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 600)}${start + 600 < text.length ? '…' : ''}`;
}

function ensureIndex() {
  const cfg = getConfig();
  const dir = knowledgeDir(cfg);
  if (cfg?.knowledge?.enabled !== true || !fs.existsSync(dir)) {
    cache = { dir, sig: '', chunks: [], files: 0, updatedAt: 0, checkedAt: Date.now() };
    return cache;
  }
  // 2 秒内不重复 stat：搜索是同步热路径，500 个文件每次都 stat 会卡住事件循环。
  if (cache.dir === dir && cache.sig && Date.now() - cache.checkedAt < CACHE_TTL_MS) return cache;
  const files = listFiles(dir).slice(0, MAX_FILES);
  const sliceSig = `${Number(cfg.knowledge.chunkChars) || 900}:${Number(cfg.knowledge.overlapChars) || 120}`;
  const sig = `${dir}\0${sliceSig}\0${signature(files)}`;
  if (cache.sig === sig) {
    cache.checkedAt = Date.now();
    return cache;
  }
  const chunks = [];
  let totalBytes = 0;
  for (const file of files) {
    if (chunks.length >= MAX_CHUNKS) break;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) continue;
      totalBytes += stat.size;
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(dir, file).split(path.sep).join('/');
      for (const value of chunkText(text, cfg.knowledge.chunkChars, cfg.knowledge.overlapChars)) {
        if (chunks.length >= MAX_CHUNKS) break;
        chunks.push({ source: rel, text: value, lower: value.toLowerCase() });
      }
    } catch { /* 单文件读失败不影响其他文件 */ }
  }
  cache = { dir, sig, chunks, files: files.length, updatedAt: Date.now(), checkedAt: Date.now() };
  return cache;
}

export function knowledgeStats() {
  const cfg = getConfig();
  if (cfg?.knowledge?.enabled !== true) {
    return { dir: knowledgeDir(cfg), files: 0, chunks: 0, updatedAt: 0 };
  }
  const idx = ensureIndex();
  return { dir: idx.dir, files: idx.files, chunks: idx.chunks.length, updatedAt: idx.updatedAt };
}

function safeFileName(name) {
  const text = String(name || '').trim().replace(/\\/g, '/');
  if (!text || text.length > 160 || text.startsWith('/')) return '';
  if (!EXTS.has(path.extname(text).toLowerCase())) return '';
  const parts = text.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return '';
  return text;
}

export function listKnowledgeFiles() {
  const cfg = getConfig();
  const dir = knowledgeDir(cfg);
  if (!fs.existsSync(dir)) return [];
  return listFiles(dir).slice(0, MAX_FILES).map((file) => {
    try {
      const stat = fs.statSync(file);
      return {
        name: path.relative(dir, file).split(path.sep).join('/'),
        size: stat.size,
        mtime: stat.mtimeMs
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function writeKnowledgeFile(name, content) {
  const cfg = getConfig();
  const fileName = safeFileName(name);
  if (!fileName) throw new Error('文件名不合法（只支持 .md/.txt，不能跳出知识库目录）');
  const text = String(content ?? '');
  if (!text.trim()) throw new Error('内容不能为空');
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('单个文件不能超过 2MB');
  const dir = knowledgeDir(cfg);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const full = path.resolve(dir, fileName);
  if (!full.startsWith(`${path.resolve(dir)}${path.sep}`)) throw new Error('文件名不合法');
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  fs.writeFileSync(full, text, { encoding: 'utf8', mode: 0o600 });
  cache = { dir, sig: '', chunks: [], files: 0, updatedAt: 0, checkedAt: 0 };
  return { name: fileName, size: Buffer.byteLength(text) };
}

export function deleteKnowledgeFile(name) {
  const cfg = getConfig();
  const fileName = safeFileName(name);
  if (!fileName) throw new Error('文件名不合法');
  const dir = knowledgeDir(cfg);
  const full = path.resolve(dir, fileName);
  if (!full.startsWith(`${path.resolve(dir)}${path.sep}`)) throw new Error('文件名不合法');
  fs.rmSync(full, { force: true });
  cache = { dir, sig: '', chunks: [], files: 0, updatedAt: 0, checkedAt: 0 };
  return { name: fileName };
}

export function reindexKnowledge() {
  cache = { dir: knowledgeDir(getConfig()), sig: '', chunks: [], files: 0, updatedAt: 0, checkedAt: 0 };
  return knowledgeStats();
}

export function searchKnowledge(query, { limit = 4 } = {}) {
  const cfg = getConfig();
  if (cfg?.knowledge?.enabled !== true) return { results: [], stats: { files: 0, chunks: 0 } };
  const idx = ensureIndex();
  const terms = queryTerms(query);
  if (!terms.length || !idx.chunks.length) return { results: [], stats: { files: idx.files, chunks: idx.chunks.length } };
  const scored = [];
  const needle = String(query || '').toLowerCase().trim().slice(0, 200);
  for (const chunk of idx.chunks) {
    const lower = chunk.lower || chunk.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let count = 0;
      let at = lower.indexOf(term);
      while (at >= 0 && count < 20) { count += 1; at = lower.indexOf(term, at + term.length); }
      if (count) score += count * (term.length >= 2 ? 2 : 1);
    }
    if (needle && lower.includes(needle)) score += 8;
    if (chunk.source.toLowerCase().includes(terms[0])) score += 3;
    if (score > 0) scored.push({ ...chunk, score });
  }
  scored.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
  const max = Math.max(1, Math.min(10, Number(limit) || Number(cfg?.knowledge?.maxResults) || 4));
  return {
    results: scored.slice(0, max).map((chunk) => ({
      source: chunk.source,
      snippet: snippetOf(chunk.text, terms),
      score: chunk.score
    })),
    stats: { files: idx.files, chunks: idx.chunks.length }
  };
}
