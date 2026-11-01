// 长期记忆（参考 AstrBot 的 Mnemosyne / LivingMemory 一类插件）：
// 把"值得记住的事"（约定、经历、偏好、群里的梗与重要事件）存成短条目，聊天时按相关度召回。
//
// 与已有的「人物记忆」（memory/*，按 QQ 号记对人的印象）分工：
//   · 人物记忆回答"他是个什么样的人"；
//   · 长期记忆回答"之前发生过什么、说好了什么"——按会话（默认）或全局存事件/事实。
//
// 设计要点：
//   · 存储：独立 SQLite（data/long-memory.sqlite，0600）。**从没启用过就不建库**（实验功能规范 §2）。
//   · 检索：中文二元组 + 英文词的 BM25 词法打分；可选向量（OpenAI 兼容 /embeddings），
//     两者加权混合，再叠加重要度与时间衰减。向量服务挂了自动退回纯词法，不影响聊天。
//   · 写入：模型用 long_memory_save 主动记；可选"自动提炼"——后台按会话增量读新消息、
//     让模型抽出值得长期记住的事实（默认关，开了也有每小时次数闸门）。
//   · 隐私：scope=chat（默认）时只在同一个群/私聊里召回；scope=global 时群聊里不召回私聊来源的条目。
//   · 关闭：停掉定时器与召回，**不删数据**；控制台页面在关闭时也能查看、编辑、删除。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, updateConfig } from '../core/config.js';
import { openDatabase } from '../core/sqlite.js';
import { chatCompletion, resolveApiKey } from '../llm/llm.js';
import { repairJsonObject } from '../core/json-repair.js';
import { sanitizeUserText } from '../core/util.js';
import {
  clampInt, clampNumber, cosine, err, fetchWithTimeout, hostOf, isPlainObject, ok, str, textSimilarity, tokenize
} from './shared.js';

export const LONG_MEMORY_DEFAULTS = Object.freeze({
  enabled: false,
  scope: 'chat',               // chat = 只在同一会话召回；global = 跨会话（群里不召回私聊来源）
  autoRecall: true,            // 每轮把最相关的几条放进提示词
  recallTopK: 4,
  recallMinScore: 0.18,        // 0~1，低于这个分数的不注入（宁缺勿滥）
  maxContentChars: 200,
  maxEntries: 5000,            // 超出后淘汰"最不重要且最久没被想起"的
  autoExtract: false,          // 后台自动提炼（额外花 token）
  extractMinMessages: 30,      // 一个会话攒够多少条新消息才提炼一次
  extractIntervalMinutes: 30,
  extractMaxPerHour: 6,
  extractChats: [],            // 空 = 所有有新消息的会话；填了就只提炼这些（chatKey，如 group:123）
  embedding: {
    enabled: false,
    baseUrl: '',               // 留空 = 跟聊天模型同一家
    apiKey: '',                // 留空时仅在与聊天模型同主机时复用模型 Key
    model: '',                 // 如 BAAI/bge-m3、text-embedding-3-small
    timeoutMs: 15000
  }
});

export function longMemoryConfig(cfg = getConfig()) {
  const raw = isPlainObject(cfg?.longMemory) ? cfg.longMemory : {};
  const emb = isPlainObject(raw.embedding) ? raw.embedding : {};
  return {
    enabled: raw.enabled === true,
    scope: raw.scope === 'global' ? 'global' : 'chat',
    autoRecall: raw.autoRecall !== false,
    recallTopK: clampInt(raw.recallTopK, 1, 12, LONG_MEMORY_DEFAULTS.recallTopK),
    recallMinScore: clampNumber(raw.recallMinScore, 0, 1, LONG_MEMORY_DEFAULTS.recallMinScore),
    maxContentChars: clampInt(raw.maxContentChars, 40, 600, LONG_MEMORY_DEFAULTS.maxContentChars),
    maxEntries: clampInt(raw.maxEntries, 100, 50000, LONG_MEMORY_DEFAULTS.maxEntries),
    autoExtract: raw.autoExtract === true,
    extractMinMessages: clampInt(raw.extractMinMessages, 5, 500, LONG_MEMORY_DEFAULTS.extractMinMessages),
    extractIntervalMinutes: clampInt(raw.extractIntervalMinutes, 5, 1440, LONG_MEMORY_DEFAULTS.extractIntervalMinutes),
    extractMaxPerHour: clampInt(raw.extractMaxPerHour, 1, 60, LONG_MEMORY_DEFAULTS.extractMaxPerHour),
    extractChats: Array.isArray(raw.extractChats)
      ? raw.extractChats.map((x) => str(x, 64)).filter((x) => /^(group|private):\d+$/.test(x))
      : [],
    embedding: {
      enabled: emb.enabled === true,
      baseUrl: str(emb.baseUrl, 300).replace(/\/+$/, ''),
      apiKey: str(emb.apiKey, 500),
      model: str(emb.model, 120),
      timeoutMs: clampInt(emb.timeoutMs, 2000, 60000, 15000)
    }
  };
}

/** 控制台下发用：去掉 Key 本体，只留"存过没有"。 */
export function publicLongMemoryConfig(cfg = getConfig()) {
  const c = longMemoryConfig(cfg);
  const { apiKey, ...emb } = c.embedding;
  return { ...c, embedding: { ...emb, hasApiKey: Boolean(apiKey) } };
}

/** 控制台保存：Key 留空/掩码 = 保持原值；其余字段按 schema 夹紧后整段写回。 */
export function saveLongMemoryConfig(patch = {}) {
  const current = longMemoryConfig();
  const p = isPlainObject(patch) ? patch : {};
  const embPatch = isPlainObject(p.embedding) ? p.embedding : {};
  const nextKey = str(embPatch.apiKey, 500);
  const merged = {
    ...current,
    ...p,
    embedding: {
      ...current.embedding,
      ...embPatch,
      apiKey: nextKey && nextKey !== '******' ? nextKey : (embPatch.clearApiKey === true ? '' : current.embedding.apiKey)
    }
  };
  delete merged.embedding.clearApiKey;
  delete merged.embedding.hasApiKey;
  const normalized = longMemoryConfig({ longMemory: merged });
  updateConfig({ longMemory: normalized });
  return publicLongMemoryConfig();
}

// ── 向量 ─────────────────────────────────────────────────────────────

function embeddingEndpoint(c, cfg) {
  return (c.embedding.baseUrl || String(cfg?.api?.baseUrl || '').trim()).replace(/\/+$/, '');
}

/** 与生图同一条 Key 归属规则：别家地址绝不复用聊天模型的 Key。 */
function embeddingAuth(c, cfg) {
  if (c.embedding.apiKey) return { ok: true, key: c.embedding.apiKey };
  const base = embeddingEndpoint(c, cfg);
  if (hostOf(base) && hostOf(base) === hostOf(cfg?.api?.baseUrl)) {
    return { ok: true, key: String(resolveApiKey(cfg) || '') };
  }
  return { ok: false, error: '向量服务与聊天模型不是同一家，需要单独填 Key（不会把模型的 Key 发给别家）' };
}

export function embeddingReady(cfg = getConfig()) {
  const c = longMemoryConfig(cfg);
  return c.embedding.enabled && Boolean(c.embedding.model) && Boolean(embeddingEndpoint(c, cfg));
}

export async function embedTexts(texts, { cfg = getConfig(), fetchFn = fetch, signal = null } = {}) {
  const c = longMemoryConfig(cfg);
  if (!embeddingReady(cfg)) throw new Error('向量检索未启用或未配置模型');
  const auth = embeddingAuth(c, cfg);
  if (!auth.ok) throw new Error(auth.error);
  const res = await fetchWithTimeout(`${embeddingEndpoint(c, cfg)}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {})
    },
    body: JSON.stringify({ model: c.embedding.model, input: texts.map((t) => String(t).slice(0, 2000)) })
  }, { timeoutMs: c.embedding.timeoutMs, signal, fetchFn });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 下面报原文 */ }
  if (!res.ok) throw new Error(`向量服务 HTTP ${res.status}：${String(parsed?.error?.message || text).slice(0, 200)}`);
  const data = Array.isArray(parsed?.data) ? parsed.data : [];
  const vectors = data
    .slice()
    .sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0))
    .map((d) => (Array.isArray(d?.embedding) ? d.embedding.map(Number) : null));
  if (vectors.length !== texts.length || vectors.some((v) => !v || !v.length)) {
    throw new Error('向量服务返回的条数/格式不对');
  }
  return vectors;
}

// ── 存储 ─────────────────────────────────────────────────────────────

export function longMemoryDatabasePath(dataDir) {
  return path.join(dataDir, 'long-memory.sqlite');
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    chatKey: row.chat_key,
    subjectId: row.subject_id || '',
    subjectName: row.subject_name || '',
    content: row.content,
    tags: (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(),
    importance: Number(row.importance) || 3,
    source: row.source || 'model',
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    lastRecalledAt: Number(row.last_recalled_at) || 0,
    recallCount: Number(row.recall_count) || 0,
    hasEmbedding: Boolean(row.embedding)
  };
}

export class LongMemoryStore {
  constructor({ dataDir, now = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.now = now;
    this.db = null;
    this.cache = null;      // 召回用的内存索引（条目数 ≤ maxEntries，常驻没压力）
  }

  exists() {
    return Boolean(this.db) || fs.existsSync(longMemoryDatabasePath(this.dataDir));
  }

  /** create=false 时库不存在就返回 null（未启用过的实例不因"打开页面"而建库）。 */
  open({ create = true } = {}) {
    if (this.db) return this.db;
    const file = longMemoryDatabasePath(this.dataDir);
    if (!create && !fs.existsSync(file)) return null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        subject_id TEXT NOT NULL DEFAULT '',
        subject_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 3,
        source TEXT NOT NULL DEFAULT 'model',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_recalled_at INTEGER NOT NULL DEFAULT 0,
        recall_count INTEGER NOT NULL DEFAULT 0,
        embedding TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_chat ON memories(chat_key);
      CREATE TABLE IF NOT EXISTS extract_state (
        chat_key TEXT PRIMARY KEY,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER NOT NULL DEFAULT 0,
        last_result TEXT NOT NULL DEFAULT ''
      );
    `);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(file + suffix, 0o600); } catch { /* 尚未创建不强求 */ }
    }
    return this.db;
  }

  close() {
    try { this.db?.close(); } catch { /* 已关 */ }
    this.db = null;
    this.cache = null;
  }

  #all() {
    if (this.cache) return this.cache;
    const db = this.open({ create: false });
    if (!db) return [];
    this.cache = db.prepare('SELECT * FROM memories ORDER BY id').all().map((row) => {
      const entry = rowToEntry(row);
      let vector = null;
      try { vector = row.embedding ? JSON.parse(row.embedding) : null; } catch { vector = null; }
      return { ...entry, vector, tokens: tokenize(`${entry.content} ${entry.subjectName} ${entry.tags.join(' ')}`) };
    });
    return this.cache;
  }

  count() {
    const db = this.open({ create: false });
    if (!db) return 0;
    return Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n) || 0;
  }

  get(id) {
    const db = this.open({ create: false });
    if (!db) return null;
    return rowToEntry(db.prepare('SELECT * FROM memories WHERE id=?').get(Number(id)));
  }

  list({ chatKey = '', q = '', limit = 50, offset = 0 } = {}) {
    const db = this.open({ create: false });
    if (!db) return { total: 0, items: [], chats: [] };
    const where = [];
    const args = [];
    if (chatKey) { where.push('chat_key=?'); args.push(chatKey); }
    if (q) { where.push('(content LIKE ? OR subject_name LIKE ? OR tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM memories ${clause}`).get(...args).n) || 0;
    const items = db.prepare(`SELECT * FROM memories ${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, clampInt(limit, 1, 200, 50), clampInt(offset, 0, 1e9, 0)).map(rowToEntry);
    const chats = db.prepare('SELECT chat_key AS chatKey, COUNT(*) AS n FROM memories GROUP BY chat_key ORDER BY n DESC')
      .all().map((r) => ({ chatKey: r.chatKey, count: Number(r.n) || 0 }));
    return { total, items, chats };
  }

  /**
   * 写入一条。与同会话里高度相似（≥0.72）的旧条目合并成"更新"，避免同一件事被记十遍。
   * 返回 { entry, merged }。
   */
  add({ chatKey, content, subjectId = '', subjectName = '', tags = [], importance = 3, source = 'model', vector = null }, cfg = getConfig()) {
    const c = longMemoryConfig(cfg);
    const text = str(content, c.maxContentChars);
    if (!text) throw new Error('记忆内容为空');
    if (!/^(group|private):\d+$/.test(String(chatKey || ''))) throw new Error('会话 key 不合法');
    const db = this.open({ create: true });
    const now = this.now();
    const cleanTags = (Array.isArray(tags) ? tags : []).map((t) => str(t, 20)).filter(Boolean).slice(0, 6);
    const imp = clampInt(importance, 1, 5, 3);
    const similar = this.#all()
      .filter((e) => e.chatKey === chatKey)
      .map((e) => ({ e, sim: textSimilarity(e.content, text) }))
      .sort((a, b) => b.sim - a.sim)[0];
    if (similar && similar.sim >= 0.72) {
      db.prepare(`UPDATE memories SET content=?, importance=MAX(importance, ?), tags=?, updated_at=?,
        subject_id=CASE WHEN ?<>'' THEN ? ELSE subject_id END,
        subject_name=CASE WHEN ?<>'' THEN ? ELSE subject_name END,
        embedding=COALESCE(?, embedding) WHERE id=?`)
        .run(text, imp, JSON.stringify([...new Set([...similar.e.tags, ...cleanTags])].slice(0, 6)), now,
          str(subjectId, 32), str(subjectId, 32), str(subjectName, 40), str(subjectName, 40),
          vector ? JSON.stringify(vector) : null, similar.e.id);
      this.cache = null;
      return { entry: this.get(similar.e.id), merged: true };
    }
    const result = db.prepare(`INSERT INTO memories
      (chat_key, subject_id, subject_name, content, tags, importance, source, created_at, updated_at, embedding)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(chatKey, str(subjectId, 32), str(subjectName, 40), text, JSON.stringify(cleanTags), imp,
        str(source, 20) || 'model', now, now, vector ? JSON.stringify(vector) : null);
    this.cache = null;
    this.#evict(c.maxEntries);
    return { entry: this.get(Number(result.lastInsertRowid)), merged: false };
  }

  update(id, patch = {}, cfg = getConfig()) {
    const c = longMemoryConfig(cfg);
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      content: patch.content !== undefined ? str(patch.content, c.maxContentChars) : cur.content,
      importance: patch.importance !== undefined ? clampInt(patch.importance, 1, 5, cur.importance) : cur.importance,
      tags: Array.isArray(patch.tags) ? patch.tags.map((t) => str(t, 20)).filter(Boolean).slice(0, 6) : cur.tags,
      subjectName: patch.subjectName !== undefined ? str(patch.subjectName, 40) : cur.subjectName
    };
    if (!next.content) throw new Error('记忆内容为空');
    const contentChanged = next.content !== cur.content;
    this.db.prepare(`UPDATE memories SET content=?, importance=?, tags=?, subject_name=?, updated_at=?
      ${contentChanged ? ', embedding=NULL' : ''} WHERE id=?`)
      .run(next.content, next.importance, JSON.stringify(next.tags), next.subjectName, this.now(), Number(id));
    this.cache = null;
    return this.get(id);
  }

  setEmbedding(id, vector) {
    if (!this.db || !Array.isArray(vector)) return;
    this.db.prepare('UPDATE memories SET embedding=? WHERE id=?').run(JSON.stringify(vector), Number(id));
    this.cache = null;
  }

  remove(id) {
    const db = this.open({ create: false });
    if (!db) return false;
    const r = db.prepare('DELETE FROM memories WHERE id=?').run(Number(id));
    this.cache = null;
    return Number(r.changes) > 0;
  }

  missingEmbeddings(limit = 32) {
    const db = this.open({ create: false });
    if (!db) return [];
    return db.prepare('SELECT id, content FROM memories WHERE embedding IS NULL ORDER BY id DESC LIMIT ?')
      .all(limit).map((r) => ({ id: Number(r.id), content: r.content }));
  }

  #evict(maxEntries) {
    const n = this.count();
    if (n <= maxEntries) return;
    // 淘汰分 = 重要度 + 被想起次数的对数 + 新近度；最低的先走
    this.db.prepare(`DELETE FROM memories WHERE id IN (
      SELECT id FROM memories ORDER BY (importance * 2 + MIN(recall_count, 20) * 0.2) ASC,
        MAX(updated_at, last_recalled_at) ASC LIMIT ?)`).run(n - maxEntries);
    this.cache = null;
  }

  /** 可见性：scope=chat 只看本会话；global 时群聊里排除私聊来源。 */
  visibleTo(entry, chatKey, scope) {
    if (scope !== 'global') return entry.chatKey === chatKey;
    if (String(chatKey).startsWith('group:') && String(entry.chatKey).startsWith('private:')) return false;
    return true;
  }

  /**
   * 混合检索。queryVector 可选（有向量的条目才参与向量分）。
   * 返回 [{ entry, score }]，score 归一到 0~1 附近。
   */
  search(query, { chatKey, scope = 'chat', limit = 5, queryVector = null, minScore = 0 } = {}) {
    const all = this.#all().filter((e) => this.visibleTo(e, chatKey, scope));
    if (!all.length) return [];
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length && !queryVector) return [];
    // BM25（k1=1.2, b=0.75），df 只在可见集合里统计
    const N = all.length;
    const avgLen = all.reduce((s, e) => s + e.tokens.length, 0) / N || 1;
    const df = new Map();
    for (const e of all) for (const t of new Set(e.tokens)) df.set(t, (df.get(t) || 0) + 1);
    const now = this.now();
    let maxLex = 0;
    const scored = all.map((e) => {
      let lex = 0;
      if (qTokens.length) {
        const tf = new Map();
        for (const t of e.tokens) tf.set(t, (tf.get(t) || 0) + 1);
        for (const t of qTokens) {
          const f = tf.get(t) || 0;
          if (!f) continue;
          const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
          lex += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * e.tokens.length / avgLen));
        }
      }
      maxLex = Math.max(maxLex, lex);
      return { e, lex, vec: queryVector && e.vector ? cosine(queryVector, e.vector) : null };
    });
    const results = scored.map(({ e, lex, vec }) => {
      // 词法分：相对本次最高分归一，再用"命中词覆盖率"压一压（只撞上一个常见字的不算相关）
      const coverage = qTokens.length
        ? qTokens.filter((t) => e.tokens.includes(t)).length / qTokens.length
        : 0;
      const lexNorm = maxLex > 0 ? (lex / maxLex) * Math.min(1, coverage * 2) : 0;
      const relevance = vec === null ? lexNorm : (0.65 * Math.max(0, vec) + 0.35 * lexNorm);
      const ageDays = Math.max(0, (now - Math.max(e.updatedAt, e.lastRecalledAt)) / 86400000);
      const recency = Math.exp(-ageDays / 120);      // 4 个月半衰左右
      const score = relevance * (0.8 + 0.04 * e.importance + 0.06 * recency);
      return { entry: e, score };
    }).filter((r) => r.score > 0 && r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return results.map(({ entry, score }) => {
      const { vector, tokens, ...rest } = entry;
      return { entry: rest, score: Math.round(score * 1000) / 1000 };
    });
  }

  markRecalled(ids) {
    if (!this.db || !ids.length) return;
    const now = this.now();
    const stmt = this.db.prepare('UPDATE memories SET last_recalled_at=?, recall_count=recall_count+1 WHERE id=?');
    for (const id of ids) stmt.run(now, Number(id));
    // 不清 cache：召回统计只影响淘汰与新近度，延后一点生效无妨（省得每轮重建索引）
  }

  extractState(chatKey) {
    const db = this.open({ create: false });
    if (!db) return { lastMessageId: 0, lastRunAt: 0, lastResult: '' };
    const row = db.prepare('SELECT * FROM extract_state WHERE chat_key=?').get(chatKey);
    return {
      lastMessageId: Number(row?.last_message_id) || 0,
      lastRunAt: Number(row?.last_run_at) || 0,
      lastResult: row?.last_result || ''
    };
  }

  setExtractState(chatKey, { lastMessageId, lastResult }) {
    const db = this.open({ create: true });
    db.prepare(`INSERT INTO extract_state (chat_key, last_message_id, last_run_at, last_result) VALUES (?,?,?,?)
      ON CONFLICT(chat_key) DO UPDATE SET last_message_id=excluded.last_message_id,
      last_run_at=excluded.last_run_at, last_result=excluded.last_result`)
      .run(chatKey, Number(lastMessageId) || 0, this.now(), str(lastResult, 300));
  }
}

// ── 运行时：召回、自动提炼 ─────────────────────────────────────────────

const EXTRACT_PROMPT = [
  '你在帮一个 QQ 群聊机器人整理"长期记忆"。下面是一段聊天记录（"我"是机器人自己）。',
  '只挑出**过一周甚至一个月以后仍然值得记住**的信息，例如：',
  '- 群友的重要经历/计划/近况（考试、换工作、搬家、生日、养了只猫）；',
  '- 和机器人之间的约定、承诺、长期的梗与称呼；',
  '- 群里的重要事件与决定。',
  '不要记：寒暄、一次性的闲聊、表情包、已经过时的临时安排、对人的主观评价（那归人物印象管）、任何密码/联系方式/住址等隐私。',
  '每条用第三人称写成一句完整、可独立看懂的话（带上是谁，用聊天里的名字），≤60 字。',
  '只输出 JSON：{"memories":[{"content":"...","aboutUserId":"QQ号或空","aboutName":"名字或空","importance":1到5,"tags":["..."]}]}；没有值得记的就输出 {"memories":[]}。'
].join('\n');

export class LongMemoryRuntime {
  constructor({ dataDir, store = null, log = console.log, now = () => Date.now(), fetchFn = fetch, complete = chatCompletion } = {}) {
    this.memory = new LongMemoryStore({ dataDir, now });
    this.chatStore = store;
    this.log = log;
    this.now = now;
    this.fetchFn = fetchFn;
    this.complete = complete;
    this.timer = null;
    this.running = false;
    this.lastRun = null;
    this.extractTimes = [];
    this.embedBackfillRunning = false;
  }

  start() {
    this.stop();
    const c = longMemoryConfig();
    if (!c.enabled) return;
    this.memory.open({ create: true });
    if (c.autoExtract) {
      const ms = c.extractIntervalMinutes * 60_000;
      this.timer = setInterval(() => {
        this.extractDue().catch((error) => this.log(`[long-memory] 自动提炼出错：${error?.message ?? error}`));
      }, ms);
      if (this.timer.unref) this.timer.unref();
    }
    this.backfillEmbeddings().catch(() => { /* 向量补算失败不影响主流程 */ });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconfigure() { this.start(); }

  status() {
    const c = publicLongMemoryConfig();
    return {
      config: c,
      databaseExists: this.memory.exists(),
      count: this.memory.exists() ? this.memory.count() : 0,
      autoExtractActive: Boolean(this.timer),
      running: this.running,
      lastRun: this.lastRun,
      embeddingReady: embeddingReady()
    };
  }

  async #queryVector(text, signal) {
    if (!embeddingReady()) return null;
    try {
      const [vec] = await embedTexts([text], { fetchFn: this.fetchFn, signal });
      return vec;
    } catch (error) {
      this.log(`[long-memory] 向量检索不可用，退回词法：${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  async save({ chatKey, content, subjectId, subjectName, tags, importance, source = 'model', signal = null }) {
    let vector = null;
    if (embeddingReady()) {
      try { [vector] = await embedTexts([content], { fetchFn: this.fetchFn, signal }); } catch { vector = null; }
    }
    return this.memory.add({ chatKey, content, subjectId, subjectName, tags, importance, source, vector });
  }

  async search(query, { chatKey, limit = 5, signal = null, minScore = 0 } = {}) {
    const c = longMemoryConfig();
    const queryVector = await this.#queryVector(query, signal);
    return this.memory.search(query, { chatKey, scope: c.scope, limit, queryVector, minScore });
  }

  /** 给提示词用：按本轮触发消息召回最相关的几条，格式化成一段。没启用/没命中返回空串。 */
  async promptContext({ chatKey, triggerEntries = [], signal = null } = {}) {
    const c = longMemoryConfig();
    if (!c.enabled || !c.autoRecall || !this.memory.exists()) return '';
    const query = (triggerEntries || [])
      .filter((m) => !m.self)
      .map((m) => `${m.senderName || ''} ${m.text || ''}`)
      .join(' ')
      .slice(-600);
    if (!query.trim()) return '';
    const hits = await this.search(query, { chatKey, limit: c.recallTopK, signal, minScore: c.recallMinScore });
    if (!hits.length) return '';
    this.memory.markRecalled(hits.map((h) => h.entry.id));
    const lines = hits.map(({ entry }) => {
      const day = new Date(entry.createdAt + 8 * 3600_000).toISOString().slice(0, 10);
      return `- #${entry.id}（${day}）${sanitizeUserText(entry.content)}`;
    });
    return `【长期记忆·可能相关】以下是你以前记下的事（按相关度排序，只在确实相关时自然地用上，不要生硬复述"我记得…"，也不要向别人透露私聊里的事）：\n${lines.join('\n')}`;
  }

  /** 后台补算缺向量的条目（开启向量检索后，把老条目补齐）。 */
  async backfillEmbeddings() {
    if (this.embedBackfillRunning || !embeddingReady() || !this.memory.exists()) return 0;
    this.embedBackfillRunning = true;
    let done = 0;
    try {
      for (let round = 0; round < 20; round += 1) {
        const batch = this.memory.missingEmbeddings(32);
        if (!batch.length) break;
        const vectors = await embedTexts(batch.map((b) => b.content), { fetchFn: this.fetchFn });
        batch.forEach((b, i) => this.memory.setEmbedding(b.id, vectors[i]));
        done += batch.length;
      }
    } catch (error) {
      this.log(`[long-memory] 向量补算中断：${String(error?.message ?? error).slice(0, 160)}`);
    } finally {
      this.embedBackfillRunning = false;
    }
    return done;
  }

  #extractBudgetOk() {
    const c = longMemoryConfig();
    const now = this.now();
    this.extractTimes = this.extractTimes.filter((t) => now - t < 3600_000);
    if (this.extractTimes.length >= c.extractMaxPerHour) return false;
    this.extractTimes.push(now);
    return true;
  }

  /** 扫描所有（或白名单内）会话，攒够新消息的就提炼一次。 */
  async extractDue() {
    const c = longMemoryConfig();
    if (!c.enabled || !c.autoExtract || this.running || !this.chatStore) return { skipped: true };
    const chats = c.extractChats.length ? c.extractChats : (this.chatStore.listChats?.() || []);
    const results = [];
    this.running = true;
    try {
      for (const chatKey of chats) {
        const st = this.memory.extractState(chatKey);
        const fresh = this.chatStore.recent(chatKey, { limit: 400, readOnly: true, afterId: st.lastMessageId });
        if (fresh.filter((m) => !m.self).length < c.extractMinMessages) continue;
        if (!this.#extractBudgetOk()) { results.push({ chatKey, skipped: '本小时提炼次数已用完' }); break; }
        results.push({ chatKey, ...(await this.extractChat(chatKey, { messages: fresh })) });
      }
    } finally {
      this.running = false;
    }
    this.lastRun = { at: this.now(), results };
    return { ok: true, results };
  }

  /** 对一个会话做一次提炼（控制台「立即提炼」也走这里）。 */
  async extractChat(chatKey, { messages = null, signal = null } = {}) {
    if (!this.chatStore) throw new Error('消息存储不可用');
    const st = this.memory.extractState(chatKey);
    const rows = messages || this.chatStore.recent(chatKey, { limit: 400, readOnly: true, afterId: st.lastMessageId });
    const usable = rows.filter((m) => String(m?.text || '').trim());
    if (!usable.length) return { ok: true, added: 0, merged: 0, note: '没有新消息' };
    const lastId = Math.max(...rows.map((m) => Number(m.id) || 0), st.lastMessageId);
    const lines = [];
    let used = 0;
    for (const m of usable.slice(-240)) {
      const who = m.self ? '我' : `${sanitizeUserText(m.senderName || m.senderId)}(${m.senderId})`;
      const line = `${who}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 160)}`;
      if (used + line.length > 9000) break;
      lines.push(line);
      used += line.length;
    }
    const r = await this.complete({
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: lines.join('\n') }
      ],
      temperature: 0.2,
      signal,
      purpose: 'write'
    });
    const parsed = repairJsonObject(String(r?.message?.content || ''));
    const list = Array.isArray(parsed?.memories) ? parsed.memories.slice(0, 12) : [];
    let added = 0; let merged = 0;
    for (const item of list) {
      const content = str(item?.content, 200);
      if (!content) continue;
      try {
        const out = await this.save({
          chatKey,
          content,
          subjectId: /^\d{5,12}$/.test(String(item?.aboutUserId || '')) ? String(item.aboutUserId) : '',
          subjectName: str(item?.aboutName, 40),
          tags: Array.isArray(item?.tags) ? item.tags : [],
          importance: item?.importance,
          source: 'extract',
          signal
        });
        if (out.merged) merged += 1; else added += 1;
      } catch { /* 单条坏数据跳过 */ }
    }
    const summary = `新增 ${added} 条、合并 ${merged} 条（读了 ${rows.length} 条消息）`;
    this.memory.setExtractState(chatKey, { lastMessageId: lastId, lastResult: summary });
    this.log(`[long-memory] ${chatKey} 提炼完成：${summary}`);
    return { ok: true, added, merged, read: rows.length };
  }
}

// ── 工具（给聊天模型）────────────────────────────────────────────────

export function longMemoryToolDefs(getRuntime) {
  const available = ({ cfg }) => longMemoryConfig(cfg).enabled;
  return [
    {
      name: 'long_memory_save',
      extension: 'longMemory',
      available,
      description: '把一件值得长期记住的事写进你的长期记忆（约定、群友的重要近况/计划、群里的重要事件、长期的梗）。'
        + '写成一句第三人称、脱离上下文也看得懂的话（带上是谁）。寒暄、一次性闲聊、隐私信息（密码/住址/联系方式）不要记。'
        + '同一件事再记一次会自动合并更新，不会重复。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的事，≤60 字为宜，例如"阿杰 11 月 20 日考研，说考完请大家吃饭"' },
          aboutUserId: { type: ['string', 'integer'], description: '可选：主要关于哪位群友（QQ 号）' },
          importance: { type: 'integer', description: '1~5，越重要越不容易被淘汰，默认 3' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：短标签，如 ["考试","约定"]' }
        },
        required: ['content']
      },
      async execute(ctx, args) {
        try {
          const rt = getRuntime();
          if (!rt) return err('长期记忆未初始化');
          const aboutId = String(args.aboutUserId ?? '').replace(/\D/g, '');
          const name = aboutId
            ? (ctx.store?.recent?.(ctx.chatKey, { limit: 200 })?.filter((m) => String(m.senderId) === aboutId).at(-1)?.senderName || '')
            : '';
          const { entry, merged } = await rt.save({
            chatKey: ctx.chatKey,
            content: args.content,
            subjectId: aboutId,
            subjectName: name,
            tags: args.tags,
            importance: args.importance,
            source: 'model',
            signal: ctx.signal
          });
          return ok({ saved: true, id: entry.id, merged, note: merged ? '和已有的一条合并更新了' : '已记下。不用告诉群友"我记住了"，除非对方要求你记。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'long_memory_search',
      extension: 'longMemory',
      available,
      description: '在你的长期记忆里搜以前记下的事（提示词里自动带的只是最相关的几条；想确认细节、或群友问"你还记得…吗"时用它）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找什么，例如"阿杰 考试"' },
          limit: { type: 'integer', description: '最多返回几条，默认 6' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const rt = getRuntime();
          if (!rt) return err('长期记忆未初始化');
          const hits = await rt.search(str(args.query, 200), {
            chatKey: ctx.chatKey, limit: clampInt(args.limit, 1, 15, 6), signal: ctx.signal, minScore: 0.05
          });
          rt.memory.markRecalled(hits.map((h) => h.entry.id));
          if (!hits.length) return ok({ results: [], note: '没找到相关的记忆。别硬编，照实说不记得就好。' });
          return ok({
            results: hits.map(({ entry, score }) => ({
              id: entry.id,
              content: entry.content,
              about: entry.subjectName || entry.subjectId || '',
              date: new Date(entry.createdAt + 8 * 3600_000).toISOString().slice(0, 10),
              score
            }))
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'long_memory_forget',
      extension: 'longMemory',
      available,
      description: '删掉一条记错了或对方要求忘掉的长期记忆（id 来自【长期记忆】或 long_memory_search 结果里的 #数字）。只能删当前会话记下的。',
      parameters: {
        type: 'object',
        properties: { id: { type: ['integer', 'string'], description: '记忆 id' } },
        required: ['id']
      },
      async execute(ctx, args) {
        try {
          const rt = getRuntime();
          if (!rt) return err('长期记忆未初始化');
          const id = Number(String(args.id ?? '').replace(/\D/g, ''));
          const entry = rt.memory.get(id);
          if (!entry || entry.chatKey !== ctx.chatKey) return err(`当前会话里没有 #${id} 这条记忆`);
          rt.memory.remove(id);
          return ok({ removed: true, id });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    }
  ];
}

// ── 控制台路由 ───────────────────────────────────────────────────────

export function registerLongMemoryRoutes(router, deps = {}) {
  // 显式取别名而不是解构参数：ops scan 的未定义调用扫描器不认识解构参数（见 console/router.js）
  const json = deps.json;
  const readBody = deps.readBody;
  const getRuntime = deps.getRuntime;
  const keyEndpointAllowed = deps.keyEndpointAllowed || (() => true);
  router.add('GET', '/api/ext/long-memory', async (req, res, params, url) => {
    const rt = getRuntime();
    const q = str(url.searchParams.get('q'), 100);
    const chatKey = str(url.searchParams.get('chatKey'), 64);
    const offset = clampInt(url.searchParams.get('offset'), 0, 1e9, 0);
    return json(res, 200, { ok: true, status: rt.status(), ...rt.memory.list({ chatKey, q, offset, limit: 50 }) });
  });
  router.add('POST', '/api/ext/long-memory/config', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const config = saveLongMemoryConfig(body?.config || body);
      getRuntime().reconfigure();
      return json(res, 200, { ok: true, config, status: getRuntime().status() });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/long-memory/search', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const chatKey = str(body.chatKey, 64);
    if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: '请选择一个会话' });
    try {
      const hits = await getRuntime().search(str(body.query, 200), { chatKey, limit: 10 });
      return json(res, 200, { ok: true, results: hits });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/long-memory', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const out = await getRuntime().save({
        chatKey: str(body.chatKey, 64),
        content: body.content,
        subjectId: str(body.subjectId, 32).replace(/\D/g, ''),
        subjectName: str(body.subjectName, 40),
        tags: Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，\s]+/).filter(Boolean),
        importance: body.importance,
        source: 'console'
      });
      return json(res, 200, { ok: true, ...out });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('PATCH', /^\/api\/ext\/long-memory\/(\d+)$/, async (req, res, params) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      const entry = getRuntime().memory.update(Number(params[1]), body);
      if (!entry) return json(res, 404, { ok: false, error: '没有这条记忆' });
      return json(res, 200, { ok: true, entry });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/ext\/long-memory\/(\d+)$/, async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝。' });
    if (url.searchParams.get('confirm') !== '1') return json(res, 409, { ok: false, error: '删除需要 confirm=1' });
    const removed = getRuntime().memory.remove(Number(params[1]));
    return json(res, removed ? 200 : 404, { ok: removed });
  });
  router.add('POST', '/api/ext/long-memory/extract', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const chatKey = str(body.chatKey, 64);
    if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: '请选择一个会话' });
    if (!longMemoryConfig().enabled) return json(res, 400, { ok: false, error: '长期记忆未启用' });
    try {
      return json(res, 200, await getRuntime().extractChat(chatKey));
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/ext/long-memory/test-embedding', async (req, res) => {
    try {
      const started = Date.now();
      const [vec] = await embedTexts(['连通性测试：今天天气不错']);
      const backfilled = await getRuntime().backfillEmbeddings();
      return json(res, 200, { ok: true, dims: vec.length, ms: Date.now() - started, backfilled });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
}
