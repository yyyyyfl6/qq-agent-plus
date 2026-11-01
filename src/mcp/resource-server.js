// MCP resources 服务端：把本机数据以只读 resource 暴露给外部 MCP 客户端（stdio）。
// 范围刻意收窄：全局人物记忆 + 梗库 + 提醒清单 —— 都是"读一读没风险"的数据；
// 不暴露会话记录、配置、凭据。所有内容过 sanitizeDeep（外部消费者也是模型的上下文）。
//
// 协议：JSON-RPC over stdio（initialize / resources/list / resources/read），
// 零依赖。启动方：src/mcp/resource-server.mjs（管理员在 MCP 客户端里配 command 即可）。
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import { pathToFileURL } from 'node:url';
import { createLineDecoder, encodeMessage } from '../plugins/protocol.js';
import { sanitizeDeep } from '../tools/tools-core.js';

const MAX_RESOURCE_BYTES = 256 * 1024;

function iso(ms) {
  const n = Number(ms) || 0;
  return n ? new Date(n).toISOString() : undefined;
}

/** 资源清单（静态注册； uri → 读函数）。read 返回 { text, mimeType }。 */
export function createResourceRegistry({ memory = null, getMemes = null, getReminders = null } = {}) {
  // 注入点先落本地 const（ops scan --strict 只认 const/let 声明；同 capabilities.js 的约定）
  const memoryOf = memory;
  const memesOf = getMemes;
  const remindersOf = getReminders;
  const resources = [];
  const readOf = new Map();

  const register = (uri, name, description, mimeType, read) => {
    resources.push({ uri, name, description, mimeType });
    readOf.set(uri, read);
  };

  if (memoryOf && typeof memoryOf.members === 'function') {
    register('qq-agent://memory/people', '全局人物记忆',
      '机器人对所有群友的长期印象（全局共享、只读摘要；不含会话交接原文）', 'application/json',
      () => {
        const people = (memoryOf.members('') || []).slice(0, 200).map((p) => ({
          userId: p.userId,
          name: p.name || '',
          note: p.note || '',
          interactions: p.interactions || 0,
          lastInteractionAt: iso(p.lastInteractionAt),
          impressions: (p.impressions || []).slice(0, 20).map((x) => ({
            content: x.content || '', origin: x.origin || '', at: iso(x.at)
          })),
          updatedAt: iso(p.updatedAt)
        }));
        return { people, count: people.length };
      });
  }

  if (memesOf && typeof memesOf === 'function') {
    register('qq-agent://memes', '群梗库',
      '各会话登记的梗/黑话（词条→含义），含使用统计', 'application/json',
      () => {
        const stats = memesOf.stats?.() ?? {};
        return { stats, memes: memesOf() };
      });
  }

  if (remindersOf && typeof remindersOf === 'function') {
    register('qq-agent://reminders', '待触发提醒',
      '当前所有待触发的定时/周期提醒（只读）', 'application/json',
      () => ({ reminders: remindersOf() }));
  }

  return {
    list: () => ({ resources: resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })) }),
    read: (uri) => {
      const read = readOf.get(String(uri || ''));
      if (!read) return null;
      const body = read();
      const text = JSON.stringify(sanitizeDeep(body));
      return {
        contents: [{
          uri: String(uri),
          mimeType: 'application/json',
          text: text.length > MAX_RESOURCE_BYTES ? `${text.slice(0, MAX_RESOURCE_BYTES)}…(截断)` : text
        }]
      };
    }
  };
}

/** stdio JSON-RPC 服务：initialize / resources/list / resources/read / ping。 */
export function startResourceServer({ registry, input = process.stdin, output = process.stdout } = {}) {
  const write = (message) => {
    try { output.write(encodeMessage(message)); } catch { /* 对端关了就算了 */ }
  };
  const onLine = (line) => {
    let message = null;
    if (typeof line === 'string') { try { message = JSON.parse(line); } catch { return; } }
    else if (line && typeof line === 'object') message = line;
    else return;
    if (!message || message.id === undefined || message.id === null) return;
    const { id, method, params } = message;
    if (method === 'initialize') {
      write({
        id,
        result: {
          protocolVersion: String(params?.protocolVersion || '2024-11-05'),
          capabilities: { resources: { subscribe: false } },
          serverInfo: { name: 'qq-agent-resources', version: '1.0.0' }
        }
      });
      return;
    }
    if (method === 'resources/list') {
      write({ id, result: registry.list() });
      return;
    }
    if (method === 'resources/read') {
      const result = registry.read(String(params?.uri || ''));
      if (!result) write({ id, error: { code: -32602, message: `未知资源：${params?.uri || '(空)'}` } });
      else write({ id, result });
      return;
    }
    if (method === 'ping') { write({ id, result: {} }); return; }
    write({ id, error: { code: -32601, message: `不支持的方法：${method || '(空)'}` } });
  };
  const decoder = createLineDecoder({ onMessage: onLine });
  const onData = (chunk) => decoder.push(chunk);
  input.on('data', onData);
  return {
    close() { input.off?.('data', onData); },
    /** 测试钩子：直接喂一行 */
    feed(line) { onLine(line); }
  };
}

// ── CLI 入口：node src/mcp/resource-server.js ─────────────────────────────
// 只在直接运行本文件时启动 stdio 服务（被 import 时不动 stdin/stdout）。
const isMain = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const { MemoryStore } = await import('../memory/memory-global.js');
  const { listMemes } = await import('../memes/store.js');
  const fsMod = await import('node:fs');
  const remindersFile = path.join(DATA_DIR, 'reminders.json');
  const readReminders = () => {
    try {
      const raw = JSON.parse(fsMod.readFileSync(remindersFile, 'utf8'));
      return (Array.isArray(raw?.items) ? raw.items : [])
        .filter((x) => x && x.status === 'pending')
        .map((x) => ({ id: x.id, chatKey: x.chatKey, at: x.at, text: x.text, repeat: x.repeat?.kind || null }));
    } catch { return []; }
  };
  const MemoryStoreCtor = MemoryStore;
  const listMemesFn = listMemes;
  const registry = createResourceRegistry({
    memory: new MemoryStoreCtor(),
    getMemes: () => listMemesFn(''),
    getReminders: readReminders
  });
  startResourceServer({ registry });
}
