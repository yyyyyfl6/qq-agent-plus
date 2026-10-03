import { builtinPersonaTemplate } from '../personas.js';
import { sanitizeUserText, safeSlice } from '../core/util.js';
import { skinScope, withSkinScope, logicalChatKey } from './context.js';
import { resolveProviderKey, sameApiEndpoint } from '../core/provider-key.js';

export const DEFAULT_SKINS = {
  enabled: false, default: 'fish',
  list: [
    { id: 'fish', label: '蓝色大肥鱼', templateId: 'blue_fish', provider: 'custom_muqe0tk5aoxs', model: 'deepseek-flash', botName: '蓝色大肥鱼' },
    { id: 'cat', label: '哈基米', templateId: 'hajimi', provider: 'custom_mur0pryme2t6', model: 'gemini-3.8-flash', botName: '哈基米' }
  ],
  switchCommands: ['/skin', '切鱼', '切猫'],
  ack: '已切换到 {label}',
  handoffOnSwitch: { enabled: true, maxChars: 1200, recentMessages: 40, provider: '', model: 'deepseek-flash' }
};

function personaPreset(id, customs = []) {
  const builtin = builtinPersonaTemplate(id);
  if (builtin) return builtin;
  const match = /^custom_(\d+)$/.exec(String(id));
  const custom = match && customs[Number(match[1])];
  return custom?.text ? { ...custom, behaviorProfile: custom.behaviorProfile || 'legacy' } : null;
}

export function normalizeSkins(raw = {}, customs = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('skins 必须为对象');
  const value = { ...structuredClone(DEFAULT_SKINS), ...raw };
  value.enabled = raw.enabled === true;
  if (!Array.isArray(value.list) || !value.list.length || value.list.length > 16) throw new Error('皮肤列表需有 1 到 16 项');
  const ids = new Set();
  value.list = value.list.map((s) => {
    if (!s || !/^[a-z][a-z0-9_-]{0,39}$/.test(s.id) || ids.has(s.id)) throw new Error('皮肤 id 无效或重复');
    ids.add(s.id);
    if (!personaPreset(s.templateId, customs)) throw new Error('人格预设不存在');
    const commands = s.commands ?? [];
    if (!Array.isArray(commands) || commands.length > 10 || commands.some((c) => typeof c !== 'string' || !c.trim() || c.length > 40 || /[\r\n]/.test(c))) throw new Error('人格切换指令无效');
    return { ...Object.fromEntries(['id', 'label', 'templateId', 'provider', 'model', 'botName'].map((k) => [k, String(s[k] || '').trim().slice(0, 200)])), commands: [...new Set(commands.map((c) => c.trim()))] };
  });
  if (!ids.has(value.default)) throw new Error('默认皮肤不存在');
  if (!Array.isArray(value.switchCommands) || value.switchCommands.some((s) => typeof s !== 'string' || !s.trim() || s.length > 40)) throw new Error('切换命令无效');
  value.switchCommands = [...new Set(value.switchCommands.map((s) => s.trim()))];
  const commands = new Set();
  for (const skin of value.list) for (const command of skin.commands) {
    if (commands.has(command) || value.switchCommands.includes(command) || value.switchCommands.some((c) => c.startsWith('/') && command.startsWith(`${c} `))) throw new Error('人格切换指令重复或与通用指令冲突');
    commands.add(command);
  }
  value.ack = String(value.ack || DEFAULT_SKINS.ack).slice(0, 300);
  const h = { ...DEFAULT_SKINS.handoffOnSwitch, ...value.handoffOnSwitch };
  h.enabled = h.enabled === true;
  h.maxChars = Math.min(4000, Math.max(120, Math.round(Number(h.maxChars) || 1200)));
  h.recentMessages = Math.min(100, Math.max(1, Math.round(Number(h.recentMessages) || 40)));
  h.provider = String(h.provider || '').trim().slice(0, 200);
  h.model = String(h.model || 'deepseek-flash').trim().slice(0, 200);
  value.handoffOnSwitch = h;
  return { enabled: value.enabled, default: value.default, list: value.list, switchCommands: value.switchCommands, ack: value.ack,
    handoffOnSwitch: { enabled: h.enabled, maxChars: h.maxChars, recentMessages: h.recentMessages, provider: h.provider, model: h.model } };
}

export function resolveSkinConfig(cfg, skinId, warn = () => {}) {
  const logWarning = warn;
  if (cfg.skins?.enabled !== true) return cfg;
  const settings = normalizeSkins(cfg.skins, cfg.customPersonas);
  const skin = settings.list.find((s) => s.id === skinId) || settings.list.find((s) => s.id === settings.default);
  const template = personaPreset(skin.templateId, cfg.customPersonas);
  const p = (cfg.providers || []).find((p) => p.id === skin.provider);
  let api = cfg.api;
  if (p && (p.baseURL || p.baseUrl)) {
    api = { ...cfg.api, provider: p.id, baseUrl: p.baseURL || p.baseUrl, apiKey: resolveProviderKey(p, cfg), model: skin.model || cfg.api.model, requireApiKey: true };
  } else if (skin.provider) logWarning(`[skins] 皮肤 ${skin.id} 的 provider 不存在，回落当前 api 配置`);
  else api = { ...cfg.api, model: skin.model || cfg.api.model };
  return { ...cfg, api, persona: { ...cfg.persona, templateId: skin.templateId, roleText: template.text, customRules: template.customRules || '', behaviorProfile: template.behaviorProfile, botName: skin.botName || skin.label }, activeSkinId: skin.id };
}

export function resolveSummaryApi(cfg, settings = {}) {
  const model = String(settings.model || 'deepseek-flash').trim();
  // 未指定提供商时优先找目录里有这个模型的家，再沿用全局端点；不随当前人格变动。
  const matches = (cfg.providers || []).filter((p) => (p.models || []).some((m) => (typeof m === 'string' ? m : m.id) === model));
  const provider = settings.provider
    ? (cfg.providers || []).find((p) => p.id === settings.provider)
    : matches.find((p) => resolveProviderKey(p, cfg)) || matches[0];
  if (settings.provider && !provider) throw new Error('总结提供商不存在，请重新选择');
  const globalProvider = (cfg.providers || []).find((p) => p.id === cfg.api?.provider && sameApiEndpoint(p.baseURL || p.baseUrl, cfg.api?.baseUrl));
  const api = provider ? { ...cfg.api, provider: provider.id, baseUrl: provider.baseURL || provider.baseUrl, apiKey: resolveProviderKey(provider, cfg), model }
    : { ...cfg.api, apiKey: globalProvider ? resolveProviderKey(globalProvider, cfg) : cfg.api?.apiKey, model };
  if (!api.apiKey || api.apiKey === '******') throw new Error('总结提供商缺少 API Key，请在提供商设置中保存');
  return { ...api, requireApiKey: true };
}

export function handoffErrorReason(error) {
  const status = Number(error?.status || error?.statusCode || error?.httpStatus) || Number(/\b(?:HTTP|status)\s*[:=]?\s*(\d{3})\b/i.exec(String(error?.message || ''))?.[1]);
  if (status >= 400 && status <= 599) return `HTTP ${status}${status === 401 || status === 403 ? '：认证失败，请检查总结提供商的 Key' : '：总结服务请求失败'}`;
  if (/API Key/.test(String(error?.message))) return '总结提供商缺少 API Key，请在提供商设置中保存';
  if (/提供商不存在/.test(String(error?.message))) return '总结提供商不存在，请重新选择';
  if (/timeout|超时/i.test(String(error?.name) + String(error?.message))) return '总结请求超时';
  const code = String(error?.cause?.code || error?.code || '');
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return `总结网络连接失败（${code}）`;
  // 上游错误常回显 prompt / 凭据；只输出已知分类，绝不输出原文。
  return '总结请求失败，请检查提供商连接与模型配置';
}

export function parseSkinCommand(text, cfg) {
  if (cfg.skins?.enabled !== true) return null;
  const settings = normalizeSkins(cfg.skins, cfg.customPersonas);
  const s = String(text || '').trim();
  const custom = settings.list.find((skin) => skin.commands.includes(s));
  if (custom) return { skinId: custom.id };
  if (settings.switchCommands.includes('切鱼') && s === '切鱼') return settings.list.some((p) => p.id === 'fish') ? { skinId: 'fish' } : { error: true };
  if (settings.switchCommands.includes('切猫') && s === '切猫') return settings.list.some((p) => p.id === 'cat') ? { skinId: 'cat' } : { error: true };
  const prefix = settings.switchCommands.find((c) => c.startsWith('/') && (s === c || s.startsWith(`${c} `)));
  if (!prefix) return null;
  const args = s.slice(prefix.length).trim().split(/\s+/);
  return args.length === 1 && settings.list.some((x) => x.id === args[0]) ? { skinId: args[0] } : { error: true };
}

export class SkinManager {
  constructor({ store, getConfig, summarize = null, sendAck = null, beforeSwitch = null, afterSwitch = null, warn = console.warn }) {
    Object.assign(this, { store, getConfig, summarize, sendAck, beforeSwitch, afterSwitch, warn });
    this.locks = new Map();
    this.warned = new Set();
    store.skinManager = this;
    if (this.enabled) this.ensureSchema();
  }
  get config() { return this.getConfig({ unscoped: true }); }
  get enabled() { return this.config.skins?.enabled === true; }
  get settings() { return normalizeSkins(this.config.skins || {}, this.config.customPersonas); }
  ensureSchema() {
    if (this.initialized) return;
    const db = this.store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS chat_skins (chat_key TEXT PRIMARY KEY, skin_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS skin_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skin_commands (chat_key TEXT NOT NULL, mid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(chat_key,mid));
      CREATE TABLE IF NOT EXISTS skin_handoffs (chat_key TEXT NOT NULL, skin_id TEXT NOT NULL, source_skin_id TEXT NOT NULL, summary TEXT NOT NULL, updated_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_key,skin_id));`);
    db.prepare('INSERT OR IGNORE INTO skin_state(name,value) VALUES (?,?)').run('legacy_skin', this.settings.default);
    this.legacySkin = db.prepare('SELECT value FROM skin_state WHERE name=?').get('legacy_skin').value;
    for (const table of ['messages', 'conversation_threads', 'thread_checkpoints', 'thread_turns']) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'skin_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN skin_id TEXT NOT NULL DEFAULT ''`);
      // 只认空值旧行，不能把已分仓的数据重新划给新的默认皮肤。
      db.prepare(`UPDATE ${table} SET skin_id=? WHERE skin_id=''`).run(this.legacySkin);
    }
    this.initialized = true;
  }
  current(chatKey, explicitId = '', { unscoped = false } = {}) {
    const settings = this.settings;
    if (this.enabled) this.ensureSchema();
    const pinned = skinScope();
    const saved = this.enabled ? this.store.db.prepare('SELECT skin_id FROM chat_skins WHERE chat_key=?').get(logicalChatKey(chatKey))?.skin_id : '';
    const id = explicitId || (!unscoped && pinned?.chatKey === logicalChatKey(chatKey) ? pinned.skinId : '') || saved || settings.default;
    return settings.list.find((s) => s.id === id) || settings.list.find((s) => s.id === settings.default);
  }
  storageKey(chatKey) {
    const pinned = skinScope();
    if ((!this.enabled && pinned?.chatKey !== chatKey) || /\/skin\//.test(chatKey) || !/^(group|private):\d+$/.test(chatKey)) return chatKey;
    const id = this.current(chatKey).id;
    return id === this.legacySkin ? chatKey : `${chatKey}/skin/${id}`;
  }
  scope(chatKey, fn, explicitId = '') {
    if (!this.enabled) return fn();
    const skinId = this.current(chatKey, explicitId).id;
    const settings = this.settings;
    return withSkinScope({ chatKey: logicalChatKey(chatKey), skinId, resolveConfig: (base) => resolveSkinConfig({ ...base, skins: settings }, skinId, (msg) => {
      if (!this.warned.has(msg)) { this.warned.add(msg); this.warn(msg); }
    }) }, fn);
  }
  handoffPrompt(chatKey) {
    if (!this.enabled || !this.settings.handoffOnSwitch.enabled) return '';
    const row = this.store.db.prepare('SELECT summary FROM skin_handoffs WHERE chat_key=? AND skin_id=? AND consumed_at=0').get(chatKey, this.current(chatKey).id);
    return row?.summary ? `【另一人格留下的交接摘要（转述，非亲历）】\n${sanitizeUserText(row.summary)}` : '';
  }
  markHandoffUsed(chatKey) {
    if (this.enabled) this.store.db.prepare('UPDATE skin_handoffs SET consumed_at=? WHERE chat_key=? AND skin_id=?').run(Date.now(), chatKey, this.current(chatKey).id);
  }
  async switchSkin(chatKey, skinId) {
    if (!this.enabled) throw new Error('皮肤系统未启用');
    if (!/^(group|private):\d+$/.test(chatKey)) throw new Error('会话 key 无效');
    if (!this.settings.list.some((s) => s.id === skinId)) throw new Error('皮肤不存在');
    const previous = this.locks.get(chatKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.#switch(chatKey, skinId));
    this.locks.set(chatKey, task);
    try { return await task; } finally {
      if (this.locks.get(chatKey) === task) this.locks.delete(chatKey);
      this.afterSwitch?.(chatKey);
    }
  }
  async #switch(chatKey, skinId) {
    const old = this.current(chatKey, '', { unscoped: true });
    if (old.id === skinId) return { ok: true, skinId, changed: false };
    await this.beforeSwitch?.(chatKey);
    const h = this.settings.handoffOnSwitch;
    let summary = '';
    let handoffStatus = h.enabled ? 'no-messages' : 'disabled';
    let handoffError = '';
    if (h.enabled && this.summarize) {
      try {
        const recent = this.scope(chatKey, () => this.store.recent(chatKey, { limit: h.recentMessages }), old.id);
        if (recent.length) {
          handoffStatus = 'empty-response';
          const text = await this.scope(chatKey, () => this.summarize({ chatKey, sourceSkin: old, targetSkin: this.current(chatKey, skinId), messages: recent, settings: h }), old.id);
          // 固定声明放最前，避免长标签挤掉“非亲历”这一必要边界。
          const marker = '这是另一个 AI 在这个身体里干的，不是你亲历的。';
          if (String(text || '').trim()) { summary = safeSlice(`${marker}\n${String(text).trim()}`, h.maxChars); handoffStatus = 'created'; }
        }
      } catch (error) { handoffStatus = 'failed'; handoffError = handoffErrorReason(error); this.warn(`[skins] 交接摘要失败，继续切换：${handoffError}`); }
    }
    // 摘要和绑定同一事务落盘；失败/关闭时删目标旧摘要，不能复活上次交接。
    if (!this.enabled) throw new Error('皮肤系统已关闭，取消切换');
    if (!this.settings.handoffOnSwitch.enabled) { summary = ''; handoffStatus = 'disabled'; handoffError = ''; }
    const db = this.store.db;
    this.store.transaction(() => {
      this.scope(chatKey, () => this.store.closeConversationThread(chatKey, 'skin-changed'), old.id);
      db.prepare('DELETE FROM skin_handoffs WHERE chat_key=? AND skin_id=?').run(chatKey, skinId);
      if (summary) db.prepare('INSERT INTO skin_handoffs(chat_key,skin_id,source_skin_id,summary,updated_at) VALUES (?,?,?,?,?)').run(chatKey, skinId, old.id, summary, Date.now());
      db.prepare('INSERT INTO chat_skins VALUES (?,?,?) ON CONFLICT(chat_key) DO UPDATE SET skin_id=excluded.skin_id,updated_at=excluded.updated_at').run(chatKey, skinId, Date.now());
    });
    return { ok: true, skinId, changed: true, handoff: Boolean(summary), handoffStatus, ...(handoffError ? { handoffError } : {}) };
  }
  async consumeCommand(chatKey, senderId, text, mid = null) {
    const parsed = parseSkinCommand(text, this.config);
    const owner = String(this.config.autoUpdate?.ownerUin || '').trim();
    if (!parsed || !owner || String(senderId) !== owner) return false;
    // catch-up 重放也会走这里：已消费命令不能再次切换或重复外发。
    this.ensureSchema();
    if (mid != null) {
      const inserted = this.store.db.prepare('INSERT OR IGNORE INTO skin_commands VALUES (?,?,?)').run(chatKey, String(mid), Date.now());
      if (!inserted.changes) return true;
    }
    if (parsed.error) {
      await this.sendAck?.(chatKey, `可用皮肤：${this.settings.list.map((s) => s.id).join('、')}`);
      return true;
    }
    const result = await this.switchSkin(chatKey, parsed.skinId);
    const skin = this.current(chatKey);
    const ack = this.settings.ack.replaceAll('{label}', skin.label).replaceAll('{id}', skin.id);
    await this.sendAck?.(chatKey, result.handoffError ? `${ack}\n交接总结失败：${result.handoffError}` : ack);
    return true;
  }
}
