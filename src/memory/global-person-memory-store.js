import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { backupPersonBeforeConsolidation } from './memory-consolidation-backup.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const validChat = (v) => /^(group|private):\d+$/.test(String(v || ''));
const chatKeyFromDir = (name) => {
  const m = /^(group|private)_(\d+)$/.exec(String(name || ''));
  return m ? `${m[1]}:${m[2]}` : '';
};
const memberFileName = (userId, name = '') => {
  const id = String(userId ?? '').trim();
  if (id) return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  const safe = String(name || 'unknown').replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
};
const memberKey = (userId, name = '') => String(userId || '').trim() || `_n_${memberFileName('', name)}`;
const globalMemberFile = (userId, name = '', memoryDir = MEMORY_DIR) => path.join(memoryDir, 'people', memberFileName(userId, name));

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch (error) {
    // 文件在但读不了（坏 JSON 等）：静默返回 fallback 的话，随后同路径的写入会把它直接
    // 覆盖掉，用户再也查不出人物印象为什么没了。留档成 .broken-<时间戳>（与 reminders /
    // group-game 同口径；2026-10-12 审查）。ENOENT（首次运行没有文件）是正常的。
    if (error?.code !== 'ENOENT') {
      console.error(`[memory-global] 读取 ${file} 失败，本次跳过，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处，至少不覆盖 */ }
    }
    return fallback;
  }
}
function writeJson(file, value) {
  // 人物印象是隐私正文：目录 0700 / 文件 0600（与 consolidation-backup、identity 库同一口径）。
  // 原来不带 mode，按 umask 022 落成 0644，多用户主机上任意本地用户可读。
  // rename 后显式 chmod：btrfs（部分 NAS）上 writeFileSync 的 mode 会丢失（Issue #11）。
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600, flush: true });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
function sourceKeys(value, fallback = '') {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (!validChat(s) || seen.has(s)) return;
    seen.add(s); out.push(s);
  };
  if (Array.isArray(value)) value.forEach(add);
  add(fallback);
  return out;
}
function emptyRelationship() {
  return { interactions: 0, warmth: 0, lastInteractionAt: 0 };
}
function normalizeRelationship(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyRelationship();
  return {
    interactions: Math.max(0, Number(raw.interactions) || 0),
    warmth: Math.min(100, Math.max(-100, Number(raw.warmth) || 0)),
    lastInteractionAt: Math.max(0, Number(raw.lastInteractionAt) || 0)
  };
}
/** 关系只按"实际互动次数"分档，避免用温度数值制造看不懂的差异。 */
export function relationshipLabel(interactions) {
  const n = Math.max(0, Number(interactions) || 0);
  if (n >= 50) return '很熟';
  if (n >= 20) return '熟';
  if (n >= 5) return '有点熟';
  return '刚认识';
}
function emptyMember(userId = '', name = '') {
  return { version: 2, userId: String(userId || ''), name: String(name || ''), impressions: [], sourceChatKeys: [], updatedAt: 0, lastConsolidatedAt: 0, relationship: emptyRelationship() };
}
// origin：这条印象是怎么来的 —— 'model'（机器人自己 memory_append 记的）、
// 'consolidated'（记忆整理/提炼改写的）、'manual'（控制台手动编辑的）；
// 老数据没有这个字段，保持空串，UI 上显示成"早先"。
export const IMPRESSION_ORIGINS = ['model', 'consolidated', 'manual'];
function normalizeOrigin(raw) {
  const value = String(raw ?? '').trim();
  return IMPRESSION_ORIGINS.includes(value) ? value : '';
}

function normalizeEntry(raw, fallbackChatKey = '') {
  const content = clean(raw?.content ?? raw);
  if (!content) return null;
  const createdAt = Number(raw?.createdAt) || Date.now();
  return {
    content,
    createdAt,
    lastObservedAt: Math.max(createdAt, Number(raw?.lastObservedAt) || 0),
    origin: normalizeOrigin(raw?.origin),
    sourceChatKeys: sourceKeys(raw?.sourceChatKeys, raw?.sourceChatKey || fallbackChatKey)
  };
}
function mergeEntry(member, entry) {
  const old = member.impressions.find((x) => x.content === entry.content);
  if (!old) {
    member.impressions.push({ ...entry, sourceChatKeys: [...entry.sourceChatKeys] });
    return;
  }
  // 同一句话再被记一次：正文没变，来源也不该被改写（手动写的那条别被标成自动）
  old.createdAt = Math.min(Number(old.createdAt) || entry.createdAt, entry.createdAt);
  old.lastObservedAt = Math.max(Number(old.lastObservedAt) || old.createdAt, entry.lastObservedAt || entry.createdAt);
  old.sourceChatKeys = sourceKeys([...(old.sourceChatKeys || []), ...(entry.sourceChatKeys || [])]);
}
function normalizeMember(raw = {}, userId = '', name = '', fallbackChatKey = '') {
  const member = emptyMember(raw.userId ?? userId, raw.name ?? name);
  member.updatedAt = Number(raw.updatedAt) || 0;
  member.lastConsolidatedAt = Number(raw.lastConsolidatedAt) || 0;
  member.sourceChatKeys = sourceKeys(raw.sourceChatKeys, fallbackChatKey);
  member.relationship = normalizeRelationship(raw.relationship);
  for (const item of Array.isArray(raw.impressions) ? raw.impressions : []) {
    const entry = normalizeEntry(item, fallbackChatKey);
    if (entry) mergeEntry(member, entry);
  }
  member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...member.impressions.flatMap((x) => x.sourceChatKeys || [])]);
  member.impressions.sort((a, b) => (a.lastObservedAt || a.createdAt) - (b.lastObservedAt || b.createdAt));
  return member;
}
function mergeMember(target, incoming) {
  if (!target.userId && incoming.userId) target.userId = incoming.userId;
  if (incoming.name && (!target.name || incoming.updatedAt >= target.updatedAt)) target.name = incoming.name;
  for (const entry of incoming.impressions) mergeEntry(target, entry);
  target.sourceChatKeys = sourceKeys([...target.sourceChatKeys, ...incoming.sourceChatKeys]);
  const a = normalizeRelationship(target.relationship);
  const b = normalizeRelationship(incoming.relationship);
  const newer = b.lastInteractionAt >= a.lastInteractionAt ? b : a;
  target.relationship = {
    interactions: Math.max(a.interactions, b.interactions),
    warmth: newer.warmth,
    lastInteractionAt: Math.max(a.lastInteractionAt, b.lastInteractionAt)
  };
  target.updatedAt = Math.max(target.updatedAt || 0, incoming.updatedAt || 0);
  target.lastConsolidatedAt = Math.max(target.lastConsolidatedAt || 0, incoming.lastConsolidatedAt || 0);
}
function archive(src, rel, memoryDir = MEMORY_DIR) {
  try {
    if (!fs.existsSync(src)) return;
    const dst = path.join(memoryDir, 'backups', 'global-people-v1', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
    fs.renameSync(src, dst);
  } catch (error) { console.warn('[memory] 归档旧人物记忆失败:', error?.message ?? error); }
}

const DEFAULT_MAX_IMPRESSIONS = 50;
const DEFAULT_RETENTION_DAYS = 0;

export function memoryLimits() {
  const cfg = getConfig().memory || {};
  const max = Math.max(5, Math.min(200, Math.round(Number(cfg.maxImpressionsPerPerson) || DEFAULT_MAX_IMPRESSIONS)));
  const days = Math.max(0, Math.min(3650, Math.round(Number(cfg.impressionRetentionDays ?? DEFAULT_RETENTION_DAYS) || 0)));
  return { max, days };
}

function trimMember(member, now = Date.now(), limits = memoryLimits()) {
  const before = member.impressions?.length || 0;
  const retentionMs = limits.days > 0 ? limits.days * 86400000 : 0;
  const keep = (member.impressions || []).filter((entry) => {
    if (normalizeOrigin(entry.origin) === 'manual') return true;
    const observed = Number(entry.lastObservedAt) || Number(entry.createdAt) || 0;
    return !(retentionMs > 0 && observed > 0 && now - observed > retentionMs);
  });
  if (keep.length > limits.max) {
    const manual = keep.filter((entry) => normalizeOrigin(entry.origin) === 'manual');
    const auto = keep
      .filter((entry) => normalizeOrigin(entry.origin) !== 'manual')
      .sort((a, b) => (Number(b.lastObservedAt || b.createdAt) || 0) - (Number(a.lastObservedAt || a.createdAt) || 0));
    member.impressions = [...manual, ...auto.slice(0, Math.max(0, limits.max - manual.length))]
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  } else {
    member.impressions = keep;
  }
  if (member.impressions.length !== before) member.updatedAt = now;
  return member.impressions.length !== before;
}

export class GlobalPersonMemoryStore {
  constructor({ onLegacyState = null, memoryDir = MEMORY_DIR } = {}) {
    this.memoryDir = memoryDir;
    this.people = null;
    this.onLegacyState = typeof onLegacyState === 'function' ? onLegacyState : null;
  }
  #persist(member) {
    member.version = 2;
    member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...member.impressions.flatMap((x) => x.sourceChatKeys || [])]);
    writeJson(globalMemberFile(member.userId, member.name, this.memoryDir), member);
  }
  #load() {
    const map = new Map();
    try {
      for (const file of fs.readdirSync(path.join(this.memoryDir, 'people'))) {
        if (!file.endsWith('.json')) continue;
        const raw = readJson(path.join(path.join(this.memoryDir, 'people'), file));
        if (!raw) continue;
        const member = normalizeMember(raw, raw.userId, raw.name);
        map.set(memberKey(member.userId, member.name), member);
      }
    } catch { /* no global dir yet */ }
    return map;
  }
  #merge(map, incoming) {
    const key = memberKey(incoming.userId, incoming.name);
    const member = map.get(key) || emptyMember(incoming.userId, incoming.name);
    mergeMember(member, incoming);
    map.set(key, member);
  }
  #migrateSingle(chatKey, file, map) {
    const old = readJson(file);
    if (!old) return;
    this.onLegacyState?.(chatKey, old);
    const notes = getConfig().memberNotes || {};
    const byName = Object.fromEntries(Object.entries(notes).filter(([, name]) => name).map(([qq, name]) => [String(name), String(qq)]));
    for (const item of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
      const content = clean(item?.content);
      if (!content) continue;
      const target = String(item?.target || '').trim();
      const userId = String(item?.userId || '').trim() || (/^\d{5,15}$/.test(target) ? target : (byName[target] || ''));
      this.#merge(map, normalizeMember({
        userId, name: target || userId, sourceChatKeys: [chatKey], updatedAt: Number(item?.createdAt) || Date.now(),
        impressions: [{ content, createdAt: Number(item?.createdAt) || Date.now(), sourceChatKeys: [chatKey] }]
      }, userId, target, chatKey));
    }
  }
  #ensure() {
    if (this.people) return this.people;
    const map = this.#load();
    const marker = readJson(path.join(this.memoryDir, '_global_people_v1.json'));
    if (!marker?.completed) {
      const archives = [];
      let names = [];
      try { names = fs.readdirSync(this.memoryDir); } catch { names = []; }
      for (const name of names) {
        const full = path.join(this.memoryDir, name);
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isFile()) {
          const m = /^(group|private)_(\d+)\.json$/.exec(name);
          if (!m) continue;
          const chatKey = `${m[1]}:${m[2]}`;
          this.#migrateSingle(chatKey, full, map);
          archives.push([full, path.join('legacy-single', name)]);
          continue;
        }
        if (!stat.isDirectory()) continue;
        const chatKey = chatKeyFromDir(name);
        if (!chatKey) continue;
        let files = []; try { files = fs.readdirSync(full); } catch { continue; }
        for (const file of files) {
          if (!file.endsWith('.json') || file.startsWith('_')) continue;
          const src = path.join(full, file);
          const raw = readJson(src);
          if (!raw) continue;
          this.#merge(map, normalizeMember(raw, raw.userId, raw.name, chatKey));
          archives.push([src, path.join(name, file)]);
        }
      }
      for (const member of map.values()) this.#persist(member);
      writeJson(path.join(this.memoryDir, '_global_people_v1.json'), { version: 1, completed: true, migratedAt: Date.now(), people: map.size });
      for (const [src, rel] of archives) archive(src, rel, this.memoryDir);
    }
    this.people = map;
    return map;
  }
  /** 清理过期/超量的自动印象；manual 永远保留。返回实际删除条数。 */
  pruneExpired({ now = Date.now() } = {}) {
    const map = this.#ensure();
    const limits = memoryLimits();
    let removed = 0;
    let touched = 0;
    for (const member of map.values()) {
      const before = member.impressions?.length || 0;
      if (!trimMember(member, now, limits)) continue;
      removed += Math.max(0, before - member.impressions.length);
      touched += 1;
      this.#persist(member);
    }
    return { removed, touched, limits };
  }

  listSourceChats() {
    const out = new Set();
    for (const member of this.#ensure().values()) for (const key of member.sourceChatKeys) out.add(key);
    return [...out];
  }
  members(sourceChatKey = '') {
    const source = String(sourceChatKey || '').trim();
    return [...this.#ensure().values()]
      .filter((m) => m.impressions.length && (!source || m.sourceChatKeys.includes(source)))
      .map((m) => structuredClone(m))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  stats() {
    const limits = memoryLimits();
    let entries = 0;
    let manual = 0;
    let oldest = 0;
    let newest = 0;
    let bytes = 0;
    let people = 0;
    for (const member of this.#ensure().values()) {
      if (!member.impressions?.length) continue;
      people += 1;
      bytes += Buffer.byteLength(JSON.stringify(member));
      for (const entry of member.impressions) {
        entries += 1;
        if (normalizeOrigin(entry.origin) === 'manual') manual += 1;
        const at = Number(entry.createdAt) || 0;
        if (at > 0 && (!oldest || at < oldest)) oldest = at;
        if (at > newest) newest = at;
      }
    }
    return { people, entries, manual, oldestAt: oldest, newestAt: newest, bytes, limits };
  }
  get(userId) {
    const uid = String(userId || '').trim();
    return structuredClone(this.#ensure().get(uid) || emptyMember(uid));
  }
  /**
   * 记一次互动（只更新已经有印象的人，不为陌生人建档案）。
   * 关系温度只影响提示词里的一行标签，不参与检索/排序。
   */
  noteInteraction(userId, { at = Date.now(), delta = 0.5 } = {}) {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    const map = this.#ensure();
    const member = map.get(uid);
    if (!member || !member.impressions?.length) return null;
    const rel = normalizeRelationship(member.relationship);
    rel.interactions += 1;
    rel.lastInteractionAt = Math.max(rel.lastInteractionAt, Number(at) || Date.now());
    rel.warmth = Math.min(100, Math.max(-100, rel.warmth + (Number(delta) || 0)));
    member.relationship = rel;
    member.updatedAt = Date.now();
    this.#persist(member);
    return structuredClone(rel);
  }
  append(chatKey, userId, name, content, createdAt = Date.now(), origin = 'model', lastObservedAt = 0) {
    const map = this.#ensure();
    const key = memberKey(userId, name);
    const member = map.get(key) || emptyMember(userId, name);
    const now = Date.now();
    // lastObservedAt 默认取当下（"现在又看到了一次"）；只有把遗留记录并进来时才传它的旧时间 ——
    // 否则那条一年前的印象会被当成今天观察到的：日期前缀显示成今天、按新旧挑最近 3 条时挤掉真正新的、
    // "90 天没再观察到就删"的规则也永远不成立。
    const entry = normalizeEntry({
      content, createdAt, lastObservedAt: Number(lastObservedAt) || now, origin, sourceChatKeys: [chatKey]
    }, chatKey);
    if (!entry) return null;
    mergeEntry(member, entry);
    member.userId = String(userId || member.userId || '');
    member.name = String(name || member.name || member.userId || '');
    member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, chatKey]);
    member.updatedAt = now;
    trimMember(member, now);
    this.#persist(member); map.set(memberKey(member.userId, member.name), member);
    return structuredClone(entry);
  }
  /**
   * 把一批"只有名字、没有 QQ 号"的遗留印象并到反查出来的那个人名下。
   * 走 append（合并）而不是 replace：对方名下可能已经有印象，整份替换会把它们冲掉。
   */
  adoptImpressions(chatKey, userId, name, entries = []) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) return 0;
    let adopted = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const content = clean(entry?.content ?? entry, 300);
      if (!content) continue;
      const source = sourceKeys(entry?.sourceChatKeys)[0] || String(chatKey || '');
      // 连同"最后一次观察到"的旧时间一起搬过来（缺了就退回 createdAt）：并记录 ≠ 重新观察到
      const observed = Number(entry?.lastObservedAt) || Number(entry?.createdAt) || 0;
      const saved = this.append(source, uid, name, content, Number(entry?.createdAt) || Date.now(), String(entry?.origin || ''), observed);
      if (saved) adopted += 1;
    }
    return adopted;
  }
  replace(chatKey, userId, name, contents, { origin = 'consolidated' } = {}) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensure();
    const old = map.get(uid) || emptyMember(uid, name);
    const finalName = clean(name, 60) || old.name || uid;
    const now = Date.now();
    const incoming = (Array.isArray(contents) ? contents : [contents])
      .map((x) => clean(x)).filter(Boolean).slice(0, memoryLimits().max);
    const hadSource = old.sourceChatKeys.includes(String(chatKey || '').trim());
    let member;
    if (old.impressions.length && !hadSource) {
      // A globally known person can appear in a new chat before that chat has ever written memory.
      // Consolidation treats such a person as "new" for the chat. Merge the newly extracted
      // impressions instead of replacing the person's existing global memory.
      member = structuredClone(old);
      member.userId = uid;
      member.name = finalName;
      member.updatedAt = now;
      member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, chatKey]);
      for (const content of incoming) {
        mergeEntry(member, {
          content,
          createdAt: now,
          lastObservedAt: now,
          origin: normalizeOrigin(origin),
          sourceChatKeys: sourceKeys([chatKey])
        });
      }
    } else {
      const sources = sourceKeys([...old.sourceChatKeys, ...old.impressions.flatMap((x) => x.sourceChatKeys || []), chatKey]);
      // 内容没变的条目沿用旧时间戳 —— 整理只是"改写/合并"，不是"重新观察到"。
      // 以前这里一律赋 now：每次整理都把全部印象的年龄刷成当天，展示端的日期前缀
      // 变成"上次整理日期"，"90 天没再观察到就删"这类规则也永远不成立。
      const previous = new Map((old.impressions || []).map((e) => [String(e.content), e]));
      member = {
        version: 2, userId: uid, name: finalName, sourceChatKeys: sources,
        updatedAt: now, lastConsolidatedAt: old.lastConsolidatedAt || 0,
        // 关系是独立于"印象正文"的计数：整理只改写印象，不该把聊过多少次清零。
        relationship: normalizeRelationship(old.relationship),
        impressions: incoming.map((content) => {
          const prev = previous.get(String(content));
          const createdAt = Number(prev?.createdAt) || now;
          // 每条印象**自己**的来源要如实：正文原样保留的沿用旧来源，新写/改写过的只算这次整理的会话。
          // 原来这里一律写全体来源的并集：整理一次之后，每条印象都声称"来自所有会话"，
          // 于是"删掉某人在某个群的印象"（clearPersonSource / clearSource）就永远删不掉了。
          const prevSources = prev ? sourceKeys(prev.sourceChatKeys) : [];
          return {
            content,
            createdAt,
            lastObservedAt: Math.max(createdAt, Number(prev?.lastObservedAt) || 0),
            // 正文没变就沿用旧来源（整理原样保留的一条，不该被记成"整理改写的"）
            origin: prev ? normalizeOrigin(prev.origin) : normalizeOrigin(origin),
            sourceChatKeys: prevSources.length ? prevSources : sourceKeys([chatKey])
          };
        })
      };
    }
    // 同名的人不止一个时，"只有名字"的旧条目到底是谁的就说不准了：
    // 不能借整理的机会把它并进随便哪个人（重名会互相污染），留给人工处理。
    const sameNamePeople = [...map.values()].filter((m) =>
      m.name === finalName && /^\d{1,15}$/.test(String(m.userId || '').trim())).length;
    for (const [key, candidate] of [...map.entries()]) {
      if (key === uid || candidate.name !== finalName) continue;
      // 有真 QQ 号的是另一个人（重名也一样），不动它
      if (/^\d{1,15}$/.test(String(candidate.userId || '').trim())) continue;
      if (sameNamePeople > 1) continue;
      // 同名但没 QQ 号的旧条目（含早期把名字本身当 id 存的）：印象必须先并进来再删文件。
      // 原来只并了 sourceChatKeys 就 rmSync，那份历史印象会静默消失，而且不在"整理前快照"的覆盖范围内（快照按数字 uid 找）。
      for (const entry of (candidate.impressions || [])) {
        const content = String(entry?.content || '').trim();
        if (!content) continue;
        if ((member.impressions || []).some((v) => v.content === content)) continue;
        member.impressions.push({ ...entry, sourceChatKeys: sourceKeys(entry?.sourceChatKeys) });
      }
      member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...candidate.sourceChatKeys]);
      // 先把合并结果落盘、删旧文件前再拍一份快照：原来 rm 在前、#persist 在循环外，
      // 落盘一旦失败（磁盘满/权限），已删掉的旧印象就静默消失且无快照可回滚。
      this.#persist(member);
      try { backupPersonBeforeConsolidation(candidate, { memoryDir: this.memoryDir, sourceChatKey: '', at: Date.now(), reason: 'merge-absorb' }); } catch { /* 备份失败不阻断 */ }
      try { fs.rmSync(globalMemberFile(candidate.userId, candidate.name, this.memoryDir), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
      map.delete(key);
    }
    trimMember(member, now);
    this.#persist(member); map.set(uid, member);
    return structuredClone(member);
  }
  removeMember(userId) {
    const uid = String(userId || '').trim();
    const map = this.#ensure(); const member = map.get(uid);
    if (!member) return false;
    // 破坏性删除前留一份快照（与整理前快照同一套目录，可回滚）
    try { backupPersonBeforeConsolidation(member, { memoryDir: this.memoryDir, sourceChatKey: '', at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ }
    map.delete(uid); try { fs.rmSync(globalMemberFile(member.userId, member.name, this.memoryDir), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
    return true;
  }
  remove({ userId = '', target = '', content = '', sourceChatKey = '' } = {}) {
    const map = this.#ensure();
    const uid = String(userId || '').trim();
    const name = String(target || '').trim();
    const scope = String(sourceChatKey || '').trim();
    // 只按名字匹配时，重名不敢猜：宁可一条都不删，也不能把同名那个人的全部记忆删掉
    if (!uid && name) {
      const hits = [...map.values()].filter((m) =>
        (m.name || m.userId) === name && (!scope || sourceKeys(m.sourceChatKeys).includes(scope)));
      if (hits.length !== 1) return false;
    }
    let removed = false;
    for (const [key, member] of [...map.entries()]) {
      if (scope && !sourceKeys(member.sourceChatKeys).includes(scope)) continue;
      const match = uid ? member.userId === uid : name ? (member.name || member.userId) === name : true;
      if (!match) continue;
      // 快照要在**清空之前**打：原来放在清空之后，backupPersonBeforeConsolidation 见到空列表
      // 直接返回 null，等于从来没备份过 —— 删掉的东西再也找不回来。
      const before = structuredClone(member);
      if (content) {
        const n = member.impressions.length;
        // 带来源范围时按**条目自己的来源**过滤：这条内容只出现在别的会话的话，不该被这次删掉
        member.impressions = member.impressions.filter((x) =>
          x.content !== content || (scope && !sourceKeys(x.sourceChatKeys).includes(scope)));
        removed ||= member.impressions.length !== n;
      } else if (scope) {
        // 按 userId/target 删但带了会话范围：只摘这个会话来源的条目，别把私聊/别的群一起清空
        const n = member.impressions.length;
        member.impressions = member.impressions.filter((x) =>
          !sourceKeys(x.sourceChatKeys).includes(scope));
        removed ||= member.impressions.length !== n;
      } else { member.impressions = []; removed = true; }
      // 摘掉印象后要重算成员级来源：否则这个人还会声称"来自 A 群"，而他在 A 群已经没有印象了
      //（members(chatKey) / consolidationState 会把他算进 A 群；2026-10-13 全项目审查 P3）。
      member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys || []));
      // 只要真删掉了东西就留快照，不限于"整条被删空"：这个人还有别的来源时，
      // 被摘掉的那几条同样再也回不来 —— 而控制台文案承诺的是"服务端会留可回滚快照"。
      // before 是动手前的克隆；它本来就是空列表时，备份函数自己会返回 null 不落盘。
      if (removed) { try { backupPersonBeforeConsolidation(before, { memoryDir: this.memoryDir, sourceChatKey: scope, at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ } }
      if (!member.impressions.length) {
        map.delete(key); try { fs.rmSync(globalMemberFile(member.userId, member.name, this.memoryDir), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
      } else { member.updatedAt = Date.now(); this.#persist(member); }
      if (uid || name) break;
    }
    return removed;
  }
  clearSource(chatKey) {
    const source = String(chatKey || '').trim(); const map = this.#ensure();
    for (const [key, member] of [...map.entries()]) {
      if (!member.sourceChatKeys.includes(source)) continue;
      // 快照必须在**清空之前**打（backupPersonBeforeConsolidation 见到空列表直接返回 null）；
      // 放在下面那段之后等于从来没备份过 —— 与 remove() 同一处坑，这次一起按同一写法处理。
      const before = structuredClone(member);
      let touched = false;
      for (const entry of member.impressions) {
        if (!(entry.sourceChatKeys || []).includes(source)) continue;
        entry.sourceChatKeys = entry.sourceChatKeys.filter((x) => x !== source);
        touched = true;
      }
      member.impressions = member.impressions.filter((x) => x.sourceChatKeys.length);
      member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys));
      member.updatedAt = Date.now();
      // 同上：这个人还有别的来源时也要留快照 —— 被摘掉的那几条一样回不来
      if (touched) { try { backupPersonBeforeConsolidation(before, { memoryDir: this.memoryDir, sourceChatKey: source, at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ } }
      if (!member.impressions.length) {
        map.delete(key); try { fs.rmSync(globalMemberFile(member.userId, member.name, this.memoryDir), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
      } else this.#persist(member);
    }
  }
  /** 只清掉某个人在某个会话里的印象：控制台"按群删除某个成员"的语义。 */
  clearPersonSource(userId, chatKey) {
    const uid = String(userId || '').trim();
    const source = String(chatKey || '').trim();
    const map = this.#ensure();
    const member = map.get(uid);
    if (!member || !source) return false;
    // 同上：先留快照再动 member
    const before = structuredClone(member);
    let touched = false;
    for (const entry of member.impressions) {
      if (!(entry.sourceChatKeys || []).includes(source)) continue;
      entry.sourceChatKeys = entry.sourceChatKeys.filter((x) => x !== source);
      touched = true;
    }
    member.impressions = member.impressions.filter((x) => (x.sourceChatKeys || []).length);
    member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys));
    member.updatedAt = Date.now();
    // 有东西被摘掉就留快照（不只是整条删空）：这个人还有别的来源时，删掉的同样回不来
    if (touched) { try { backupPersonBeforeConsolidation(before, { memoryDir: this.memoryDir, sourceChatKey: source, at: Date.now(), reason: 'manual-delete' }); } catch { /* 备份失败不阻断 */ } }
    if (!member.impressions.length) {
      map.delete(uid);
      try { fs.rmSync(globalMemberFile(member.userId, member.name, this.memoryDir), { force: true }); } catch { /* 有意忽略：删残留文件失败仅造成文件残留，数据已先留快照可回滚 */ }
    } else this.#persist(member);
    return touched;
  }

  markConsolidated(userIds, at = Date.now()) {
    const map = this.#ensure();
    for (const uid of userIds || []) {
      const member = map.get(String(uid || '').trim());
      if (!member) continue;
      member.lastConsolidatedAt = Number(at) || Date.now(); this.#persist(member);
    }
  }
}
