import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from '../memory/memory.js';
import { bindGlobalMemoryStore } from '../memory/memory-runtime-integration.js';
import { skinScope } from './context.js';

const methods = ['getHandoff', 'setHandoff', 'clearHandoff', 'formatHandoffForPrompt', 'append', 'members', 'getMember', 'query', 'editMemberImpression', 'replaceMember', 'replaceMemberForConsolidation', 'adoptImpressions', 'removeMember', 'remove', 'clear', 'formatForPrompt', 'consolidationState', 'markConsolidated', 'replaceConsolidated'];

/** 记忆工具、Identity 注入、手工编辑和后台整合共用这一个路由入口。 */
export class SkinMemoryStore {
  constructor({ legacy, skins, memoryDir }) {
    Object.assign(this, { legacy, skins, memoryDir });
    this.stores = new Map();
    for (const name of methods) this[name] = (chatKey, ...args) => {
      const key = chatKey || skinScope()?.chatKey || '';
      return this.forChat(key)[name](key, ...args);
    };
    bindGlobalMemoryStore(this);
  }
  forChat(chatKey, skinId = '') {
    if ((!this.skins.enabled && skinScope()?.chatKey !== chatKey) || !chatKey) return this.legacy;
    if (!/^(group|private):\d+$/.test(chatKey)) throw new Error('会话 key 无效');
    const id = this.skins.current(chatKey, skinId).id;
    const key = `${chatKey}/${id}`;
    if (this.stores.has(key)) return this.stores.get(key);
    const root = path.join(this.memoryDir, chatKey.replace(':', '_'), 'skins', id);
    this.#migrateDefault(chatKey, id, root);
    const store = new MemoryStore({ memoryDir: root, bindIdentity: false });
    this.stores.set(key, store);
    return store;
  }
  #migrateDefault(chatKey, skinId, root) {
    if (skinId !== this.skins.legacySkin || fs.existsSync(path.join(root, '_skin_migrated.json'))) return;
    const dirname = chatKey.replace(':', '_');
    const oldDir = path.join(this.memoryDir, dirname);
    const destination = path.join(root, dirname);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    // 复制而不移动：关闭或回滚时仍能读取完整旧仓；只复制明确的旧文件，避免递归复制 skins。
    for (const filename of ['_meta.json', '_handoff.json']) {
      const source = path.join(oldDir, filename);
      const target = path.join(destination, filename);
      if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
    }
    const people = path.join(root, 'people');
    fs.mkdirSync(people, { recursive: true, mode: 0o700 });
    // 全局印象已是上游真相源，按来源分发；不能凭老目录是否存在判断有没有数据。
    for (const person of this.legacy.members(chatKey)) {
      const file = String(person.userId || '')
        ? (/^\d+$/.test(person.userId) ? `${person.userId}.json` : `u_${person.userId.replace(/[^a-z0-9_]/gi, '_')}.json`)
        : `_n_${String(person.name || 'unknown').replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40)}.json`;
      const target = path.join(people, file);
      if (fs.existsSync(target)) continue;
      const impressions = person.impressions.filter((e) => e.sourceChatKeys?.includes(chatKey)).map((e) => ({ ...e, sourceChatKeys: [chatKey] }));
      fs.writeFileSync(target, JSON.stringify({ ...person, sourceChatKeys: [chatKey], impressions }), { mode: 0o600, flush: true });
    }
    const oldBackups = path.join(this.memoryDir, 'backups', dirname);
    if (fs.existsSync(oldBackups)) for (const file of fs.readdirSync(oldBackups).filter((f) => f.endsWith('.json'))) {
      let member;
      try { member = JSON.parse(fs.readFileSync(path.join(oldBackups, file), 'utf8')); } catch { continue; }
      const impressions = (member.impressions || []).filter((i) => !i.sourceChatKeys?.length || i.sourceChatKeys.includes(chatKey)).map((i) => ({ ...i, sourceChatKeys: [chatKey] }));
      const target = path.join(root, 'backups', dirname, file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify({ ...member, sourceChatKeys: [chatKey], impressions }), { mode: 0o600, flush: true });
    }
    const history = path.join(this.memoryDir, 'backups', 'consolidation');
    if (fs.existsSync(history)) for (const person of fs.readdirSync(history, { withFileTypes: true })) {
      if (!person.isDirectory()) continue;
      for (const file of fs.readdirSync(path.join(history, person.name)).filter((f) => f.endsWith('.json'))) {
        let snapshot;
        try { snapshot = JSON.parse(fs.readFileSync(path.join(history, person.name, file), 'utf8')); } catch { continue; }
        const member = snapshot.person;
        if (!member?.impressions?.some((i) => i.sourceChatKeys?.includes(chatKey))) continue;
        // 备份也是记忆：保留本会话历史，但不能把别的会话的全局印象带进皮肤仓。
        const impressions = member.impressions.filter((i) => i.sourceChatKeys?.includes(chatKey)).map((i) => ({ ...i, sourceChatKeys: [chatKey] }));
        const target = path.join(root, 'backups', 'consolidation', person.name, file);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify({ ...snapshot, person: { ...member, sourceChatKeys: [chatKey], impressions } }), { mode: 0o600, flush: true });
      }
    }
    fs.writeFileSync(path.join(root, '_skin_migrated.json'), JSON.stringify({ version: 1, chatKey, skinId, at: Date.now(), originalPreserved: true }), { mode: 0o600, flush: true });
  }
  listChats() {
    if (!this.skins.enabled) return this.legacy.listChats();
    const keys = new Set([...this.legacy.listChats(), ...this.skins.store.listChats()]);
    try {
      for (const name of fs.readdirSync(this.memoryDir)) {
        if (/^(group|private)_\d+$/.test(name)) keys.add(name.replace('_', ':'));
      }
    } catch { /* 首次启用还没有记忆目录 */ }
    return [...keys];
  }
  globalMembers() {
    const key = skinScope()?.chatKey;
    return key ? this.forChat(key).globalMembers() : this.legacy.globalMembers();
  }
}
