// 生活层：定期觅食 B 站公开内容，存候选队列，供主动发言轮次挑选分享。
//
// 为什么不放插件：插件协议没有 llm/agent/wake 能力，拿不到人设与上下文，
// 也不能触发一轮 agent（见 docs/PLUGINS.md 的能力表）。所以觅食与候选队列在宿主，
// 分享复用现有 send_message，不新增发送通道。
import fs from 'node:fs';
import path from 'node:path';
import { buildInterestProfile } from './life-feed-interest.js';
import { forageBilibili, scoreCandidate } from './life-feed-source-bilibili.js';

const STATE_FILE = 'life-feed.json';
const CANDIDATE_TTL_MS = 7 * 86400000;
const SEEN_TTL_MS = 30 * 86400000;
const OFFER_TTL_MS = 7 * 86400000;
const MAX_RECORDS = 200;
const BACKOFF_MINUTES = [2, 4, 8, 16, 30];
// 设置边界集中在这里（服务端权威）：UI 不再各自写死一份，状态接口把这份 bounds 下发。
export const LIFE_FEED_BOUNDS = Object.freeze({
  forageIntervalMinutes: { min: 5, max: 10080 },
  maxCandidates: { min: 10, max: 10000 },
  maxPerForage: { min: 1, max: 500 },
  maxOffersPerDay: { min: 1, max: 500 },
  minDurationSec: { min: 0, max: 86400 },
  maxDurationSec: { min: 1, max: 86400 },
  extraKeywords: { min: 1, max: 200 },
  excludeKeywords: { min: 1, max: 200 },
  groups: { min: 1, max: 500 }
});

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cleanList(value, maxItems, maxChars) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list
    .map((item) => String(item || '').trim().slice(0, maxChars))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function dayKey(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now));
}

export function normalizedLifeFeedConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const B = LIFE_FEED_BOUNDS;
  const minDurationSec = clampInt(cfg.minDurationSec, B.minDurationSec.min, B.minDurationSec.max, 60);
  // 下限优先：用户把 min 设得比 max 大时，抬高 max，而不是悄悄把 min 降回去。
  const maxDurationSec = Math.max(minDurationSec, clampInt(cfg.maxDurationSec, B.maxDurationSec.min, B.maxDurationSec.max, 3600));
  return {
    enabled: cfg.enabled === true,
    graduated: cfg.graduated === true,
    sources: cleanList(cfg.sources, 4, 20).filter((source) => source === 'bilibili').length
      ? ['bilibili'] : ['bilibili'],
    forageIntervalMinutes: clampInt(cfg.forageIntervalMinutes, B.forageIntervalMinutes.min, B.forageIntervalMinutes.max, 360),
    maxCandidates: clampInt(cfg.maxCandidates, B.maxCandidates.min, B.maxCandidates.max, 200),
    maxPerForage: clampInt(cfg.maxPerForage, B.maxPerForage.min, B.maxPerForage.max, 30),
    maxOffersPerDay: clampInt(cfg.maxOffersPerDay, B.maxOffersPerDay.min, B.maxOffersPerDay.max, 2),
    minDurationSec: Math.min(minDurationSec, maxDurationSec),
    maxDurationSec: Math.max(minDurationSec, maxDurationSec),
    extraKeywords: cleanList(cfg.extraKeywords, B.extraKeywords.max, 20),
    excludeKeywords: cleanList(cfg.excludeKeywords, B.excludeKeywords.max, 20),
    groups: cleanList(cfg.groups, B.groups.max, 32)
  };
}

function emptyState() {
  return {
    version: 1,
    lastForageAt: 0,
    nextForageAt: 0,
    lastForageCount: 0,
    foraging: false,
    failStreak: 0,
    lastError: '',
    seen: [],
    candidates: [],
    offers: [],
    tagWeights: {},
    records: []
  };
}

function normalizeState(raw) {
  const state = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  state.seen = Array.isArray(state.seen) ? state.seen.filter((item) => item && item.id) : [];
  state.candidates = Array.isArray(state.candidates) ? state.candidates.filter((item) => item && item.id) : [];
  state.offers = Array.isArray(state.offers) ? state.offers.filter((item) => item && item.id) : [];
  state.records = Array.isArray(state.records) ? state.records.slice(0, MAX_RECORDS) : [];
  state.tagWeights = state.tagWeights && typeof state.tagWeights === 'object' ? state.tagWeights : {};
  // 进程在觅食中途退出：标记为 interrupted，下一次照常开始，不把半个队列当真。
  if (state.foraging) {
    state.foraging = false;
    state.lastError = state.lastError || 'interrupted：上次觅食未完成';
  }
  return state;
}

function publicCandidate(item) {
  return {
    id: item.id,
    source: item.source || '',
    via: item.via || '',
    title: item.title,
    up: item.up,
    upMid: item.upMid,
    duration: item.duration,
    play: item.play,
    tags: item.tags || [],
    cover: item.cover || '',
    url: item.url,
    desc: item.desc,
    score: item.score,
    addedAt: item.addedAt,
    offeredAt: item.offeredAt || 0
  };
}

export class LifeFeedManager {
  constructor({
    dataDir,
    store,
    config = () => ({}),
    fetchImpl,
    now = () => Date.now(),
    random = Math.random,
    log = () => {},
    stateFile = ''
  } = {}) {
    this.dataDir = dataDir;
    this.store = store;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.log = log;
    this.stateFile = stateFile || path.join(dataDir, STATE_FILE);
    this.state = emptyState();
    this.loaded = false;
    this.started = false;
    this.timer = null;
  }

  #cfg() {
    return normalizedLifeFeedConfig(this.config()?.lifeFeed);
  }

  #personaTemplateId() {
    return String(this.config()?.persona?.templateId || '').trim();
  }

  #chatKeys(cfg) {
    if (cfg.groups.length) {
      return cfg.groups.map((item) => (item.startsWith('group:') ? item : `group:${item}`)).slice(0, 20);
    }
    const allow = this.config()?.allow || {};
    const keys = (Array.isArray(allow.groups) ? allow.groups : [])
      .map((id) => `group:${id}`)
      .slice(0, 20);
    if (keys.length) return keys;
    if (allow.allowAllWhenEmpty !== true) return [];
    try {
      return (this.store?.listChats?.() || [])
        .map((chat) => String(chat?.chatKey || ''))
        .filter((key) => key.startsWith('group:'))
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  #intervalMs(cfg) {
    const base = cfg.forageIntervalMinutes * 60000;
    const jitter = 0.8 + this.random() * 0.4;
    return Math.round(base * jitter);
  }

  #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.state = normalizeState(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try { fs.renameSync(this.stateFile, `${this.stateFile}.broken-${this.now()}`); } catch { /* 忽略 */ }
        this.log(`[life-feed] 状态文件读不出来，已留档并重建：${error?.message || error}`);
      }
      this.state = emptyState();
    }
  }

  #save() {
    this.#load();
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.log(`[life-feed] 状态写盘失败：${error?.message || error}`);
    }
  }

  #prune(now) {
    const state = this.state;
    state.seen = state.seen.filter((item) => now - Number(item.at || 0) < SEEN_TTL_MS).slice(-2000);
    state.candidates = state.candidates.filter((item) => now - Number(item.addedAt || 0) < CANDIDATE_TTL_MS);
    state.offers = state.offers.filter((item) => now - Number(item.at || 0) < OFFER_TTL_MS).slice(-500);
    state.records = state.records.slice(0, MAX_RECORDS);
  }

  #schedule(delayMs) {
    this.#clearTimer();
    const delay = Math.max(60_000, Math.min(Number(delayMs) || 60_000, 7 * 86400000));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#tick();
    }, delay);
    this.timer.unref?.();
    return delay;
  }

  #clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async #tick() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      this.started = false;
      return;
    }
    await this.forageNow({ reason: 'schedule' });
    if (!this.started) return;
    const next = Number(this.state.nextForageAt) || (this.now() + this.#intervalMs(cfg));
    this.#schedule(next - this.now());
  }

  start() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      this.started = false;
      this.#clearTimer();
      return { active: false, nextForageAt: 0 };
    }
    this.#load();
    this.#prune(this.now());
    if (!this.state.nextForageAt) {
      // 第一次开启：1 分钟后先跑一次，让用户很快看到队列；之后按 interval。
      this.state.nextForageAt = this.now() + 60_000;
      this.#save();
    }
    this.started = true;
    this.#schedule(this.state.nextForageAt - this.now());
    return { active: true, nextForageAt: this.state.nextForageAt };
  }

  stop() {
    this.started = false;
    this.#clearTimer();
  }

  reconfigure() {
    const wasStarted = this.started;
    this.stop();
    if (!this.#cfg().enabled) return wasStarted ? this.status() : { active: false };
    return this.start();
  }

  status() {
    const cfg = this.#cfg();
    if (!cfg.enabled) {
      return {
        enabled: false,
        graduated: cfg.graduated,
        started: false,
        candidates: [],
        candidateCount: 0,
        todayOffers: 0,
        todayAutoOffers: 0,
        todayManualOffers: 0,
        maxOffersPerDay: cfg.maxOffersPerDay,
        limits: LIFE_FEED_BOUNDS,
        lastForageAt: 0,
        nextForageAt: 0,
        lastForageCount: 0,
        failStreak: 0,
        lastError: ''
      };
    }
    this.#load();
    const now = this.now();
    this.#prune(now);
    const day = dayKey(now);
    const todayOffers = this.state.offers.filter((item) => item.day === day);
    const todayManualOffers = todayOffers.filter((item) => item.manual === true).length;
    const todayAutoOffers = todayOffers.length - todayManualOffers;
    return {
      enabled: true,
      graduated: cfg.graduated,
      started: this.started,
      candidates: this.state.candidates
        .slice()
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, 30)
        .map(publicCandidate),
      candidateCount: this.state.candidates.length,
      todayOffers: todayOffers.length,
      todayAutoOffers,
      todayManualOffers,
      maxOffersPerDay: cfg.maxOffersPerDay,
      limits: LIFE_FEED_BOUNDS,
      lastForageAt: this.state.lastForageAt,
      nextForageAt: this.state.nextForageAt,
      lastForageCount: this.state.lastForageCount,
      failStreak: this.state.failStreak,
      lastError: this.state.lastError
    };
  }

  async forageNow({ reason = 'manual' } = {}) {
    const cfg = this.#cfg();
    if (!cfg.enabled) return { ok: false, error: '生活层没有开启' };
    this.#load();
    if (this.state.foraging) return { ok: false, error: '上一次觅食还没结束' };

    this.state.foraging = true;
    this.#save();
    const now = this.now();
    try {
      const profile = buildInterestProfile({
        store: this.store,
        chatKeys: this.#chatKeys(cfg),
        personaTemplateId: this.#personaTemplateId(),
        extraKeywords: cfg.extraKeywords,
        now
      });
      const pluginAdded = this.#ingestPluginInbox(profile, cfg, now);
      const items = await forageBilibili({
        profile,
        limit: cfg.maxPerForage,
        minDurationSec: cfg.minDurationSec,
        maxDurationSec: cfg.maxDurationSec,
        excludeKeywords: cfg.excludeKeywords,
        fetchImpl: this.fetchImpl,
        log: this.log
      });
      const added = pluginAdded + this.#merge(items, cfg, profile, now);
      this.state.lastForageAt = now;
      this.state.lastForageCount = added;
      this.state.nextForageAt = now + this.#intervalMs(cfg);
      this.state.failStreak = 0;
      this.state.lastError = '';
      this.state.foraging = false;
      this.#prune(now);
      this.#save();
      this.log(`[life-feed] ${reason} 觅食完成：新增 ${added} 条，候选 ${this.state.candidates.length} 条`);
      return { ok: true, added, candidates: this.state.candidates.length, nextForageAt: this.state.nextForageAt };
    } catch (error) {
      this.state.foraging = false;
      this.state.failStreak = Math.min(BACKOFF_MINUTES.length, Number(this.state.failStreak || 0) + 1);
      this.state.lastError = String(error?.message || error).slice(0, 300);
      const minutes = BACKOFF_MINUTES[Math.min(this.state.failStreak - 1, BACKOFF_MINUTES.length - 1)];
      this.state.nextForageAt = now + minutes * 60000;
      this.#save();
      this.log(`[life-feed] 觅食失败（连续 ${this.state.failStreak} 次，${minutes} 分钟后重试）：${this.state.lastError}`);
      return { ok: false, error: this.state.lastError, failStreak: this.state.failStreak, nextForageAt: this.state.nextForageAt };
    }
  }

  /**
   * 插件提交的见闻候选（cap.feed.publish 写到 data/life-feed-inbox/<id>.json）。
   * 插件不能调模型、不能发消息；这里只把它们并进队列，由正常的主动发言链路决定用不用。
   */
  #ingestPluginInbox(profile, cfg, now) {
    const inbox = path.join(this.dataDir, 'life-feed-inbox');
    let files = [];
    try { files = fs.readdirSync(inbox).filter((name) => name.endsWith('.json')); } catch { return 0; }
    const known = new Set([
      ...this.state.candidates.map((item) => item.id),
      ...this.state.seen.map((item) => item.id)
    ]);
    let added = 0;
    for (const name of files) {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(path.join(inbox, name), 'utf8')); } catch { continue; }
      const source = String(payload?.pluginId || name.replace(/\.json$/, ''));
      for (const item of Array.isArray(payload?.items) ? payload.items : []) {
        const id = String(item?.id || '').trim();
        if (!id || known.has(id)) continue;
        const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
        const score = scoreCandidate({
          title: item.title,
          desc: item.summary,
          tags,
          up: item.up,
          play: 0,
          pubdate: 0,
          duration: item.durationSec
        }, profile) + tags.reduce((sum, tag) => sum + (Number(this.state.tagWeights[tag]) || 0) * 2, 0);
        this.state.candidates.push({
          source: `plugin:${source}`,
          via: 'plugin',
          id,
          title: String(item.title || ''),
          desc: String(item.summary || ''),
          up: String(item.up || ''),
          upMid: '',
          duration: Number(item.durationSec) || 0,
          play: 0,
          pubdate: 0,
          tags,
          url: String(item.url || ''),
          score,
          addedAt: now
        });
        known.add(id);
        added += 1;
      }
    }
    if (added) {
      this.state.candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      this.state.candidates = this.state.candidates.slice(0, cfg.maxCandidates);
    }
    return added;
  }

  #merge(items, cfg, profile, now) {
    const known = new Set([
      ...this.state.candidates.map((item) => item.id),
      ...this.state.seen.map((item) => item.id)
    ]);
    // 队列层面也要有配额：只在 #pick 限 UP/标签的话，候选池早被同一种日更视频占满。
    const upCounts = new Map();
    const tagCounts = new Map();
    for (const candidate of this.state.candidates) {
      if (candidate.upMid) upCounts.set(candidate.upMid, (upCounts.get(candidate.upMid) || 0) + 1);
      for (const tag of candidate.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    let added = 0;
    for (const item of items) {
      if (known.has(item.id)) continue;
      if (item.upMid && (upCounts.get(item.upMid) || 0) >= 3) continue;
      const tags = item.tags || [];
      if (tags.some((tag) => (tagCounts.get(tag) || 0) >= 8)) continue;
      const tagBoost = tags.reduce((sum, tag) => sum + (Number(this.state.tagWeights[tag]) || 0) * 2, 0);
      const score = scoreCandidate(item, profile) + tagBoost;
      this.state.candidates.push({ ...item, score, addedAt: now });
      known.add(item.id);
      if (item.upMid) upCounts.set(item.upMid, (upCounts.get(item.upMid) || 0) + 1);
      for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      added += 1;
    }
    this.state.candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    this.state.candidates = this.state.candidates.slice(0, cfg.maxCandidates);
    return added;
  }

  #quotaLeft(cfg, day) {
    // 手动分享是用户自己点的，不占自动份额：否则点两次没发出去，自动分享当天就没了。
    const used = this.state.offers.filter((item) => item.day === day && item.manual !== true).length;
    return Math.max(0, cfg.maxOffersPerDay - used);
  }

  #pick({ count = 1, topic = '', manual = false } = {}) {
    const cfg = this.#cfg();
    const now = this.now();
    const day = dayKey(now);
    this.#load();
    if (!manual && this.#quotaLeft(cfg, day) <= 0) {
      return { error: `今天已经分享/领取 ${cfg.maxOffersPerDay} 次了，明天再继续` };
    }
    const offeredToday = new Set(this.state.offers.filter((item) => item.day === day).map((item) => item.id));
    const usedUp = new Set(this.state.offers.filter((item) => item.day === day).map((item) => item.upMid).filter(Boolean));
    const tagCounts = new Map();
    for (const offer of this.state.offers.filter((item) => item.day === day)) {
      for (const tag of offer.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const needle = String(topic || '').trim().toLowerCase();
    const picked = [];
    const sorted = this.state.candidates
      .filter((item) => !offeredToday.has(item.id))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    for (const item of sorted) {
      if (picked.length >= Math.max(1, count)) break;
      if (needle) {
        const haystack = `${item.title} ${item.desc} ${(item.tags || []).join(' ')}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      if (!manual) {
        if (item.upMid && usedUp.has(item.upMid)) continue;
        if ((item.tags || []).some((tag) => (tagCounts.get(tag) || 0) >= 2)) continue;
      }
      picked.push(item);
      if (item.upMid) usedUp.add(item.upMid);
      for (const tag of item.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    if (!picked.length) return { error: '队列里没有可分享的候选（可能都分享过或分数太低）' };

    for (const item of picked) {
      item.offeredAt = now;
      this.state.offers.push({
        day,
        id: item.id,
        upMid: item.upMid,
        tags: item.tags || [],
        at: now,
        manual
      });
      this.state.records.unshift({ at: now, action: manual ? 'manual-offer' : 'offer', id: item.id, day });
    }
    this.#prune(now);
    this.#save();
    return { items: picked.map(publicCandidate) };
  }

  next({ count = 2, topic = '', manual = false } = {}) {
    return this.#pick({ count, topic, manual });
  }

  takeForShare(id, { manual = true } = {}) {
    const cfg = this.#cfg();
    const now = this.now();
    const day = dayKey(now);
    this.#load();
    if (!manual && this.#quotaLeft(cfg, day) <= 0) {
      return { error: `今天已经分享 ${cfg.maxOffersPerDay} 次了` };
    }
    const item = this.state.candidates.find((candidate) => candidate.id === String(id || ''));
    if (!item) return { error: '这条候选不在队列里（可能已过期或已被分享）' };
    item.offeredAt = now;
    this.state.offers.push({ day, id: item.id, upMid: item.upMid, tags: item.tags || [], at: now, manual: manual === true });
    this.state.records.unshift({ at: now, action: 'manual-share', id: item.id, day });
    this.#prune(now);
    this.#save();
    return { item: publicCandidate(item) };
  }

  feedback({ id, action = 'skip', chatKey = '' } = {}) {
    const key = String(id || '').trim();
    const verb = ['shared', 'skip', 'more_like_this'].includes(action) ? action : 'skip';
    this.#load();
    const item = this.state.candidates.find((candidate) => candidate.id === key);
    if (!item) return { ok: false, error: '候选不存在' };
    if (verb === 'more_like_this') {
      for (const tag of item.tags || []) {
        this.state.tagWeights[tag] = Math.min(50, (Number(this.state.tagWeights[tag]) || 0) + 1);
      }
      this.state.records.unshift({ at: this.now(), action: 'more-like-this', id: key, chatKey });
      this.#save();
      return { ok: true, action: verb };
    }
    this.state.candidates = this.state.candidates.filter((candidate) => candidate.id !== key);
    this.state.seen.push({ id: key, at: this.now(), upMid: item.upMid || '' });
    this.state.records.unshift({ at: this.now(), action: verb, id: key, chatKey, day: dayKey(this.now()) });
    this.#prune(this.now());
    this.#save();
    return { ok: true, action: verb };
  }

  /** 按 id 取一条候选（分享工具用；不改变队列）。 */
  candidate(id) {
    this.#load();
    const item = this.state.candidates.find((entry) => entry.id === String(id || ''));
    return item ? publicCandidate(item) : null;
  }

  /** 清空候选队列（不动 seen / offers / 反馈权重）：用于画像或搜索词修正后立刻重来。 */
  clearCandidates() {
    this.#load();
    const removed = this.state.candidates.length;
    this.state.candidates = [];
    this.state.records.unshift({ at: this.now(), action: 'clear-candidates', removed });
    this.#save();
    return { ok: true, removed };
  }

  dismiss(id) {
    return this.feedback({ id, action: 'skip' });
  }
}
