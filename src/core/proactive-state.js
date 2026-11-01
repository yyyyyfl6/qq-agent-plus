// 主动开话题的"上次判定时间"：群聊和私聊各记一份；per-chat 模式下每个会话再各记一份。
//
// 旧版只有一个全局 lastAttemptAt，群聊和私聊共用同一次机会：群的机会可能被私聊占掉，
// 反过来也一样。现在两个范围各自排程、各自掷骰、各自记录，互不占用。
// per-chat 模式把每个会话的时间放进 `chats`，群/私聊范围共用一次机会的模式继续用 group/private。
//
// 状态文件保持向后兼容：旧格式 `{lastAttemptAt: 123}` 读出来会同时作为群聊和私聊的
// 上次判定时间，升级后的第一轮不会因为"没有记录"而额外多开一次话题。
import fs from 'node:fs';

const MAX_CHAT_ENTRIES = 2000;
const CHAT_RETENTION_MS = 60 * 86400000;

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = raw?.lastAttemptAt;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const chats = value.chats && typeof value.chats === 'object' && !Array.isArray(value.chats) ? value.chats : {};
      return {
        group: Number(value.group) || 0,
        private: Number(value.private) || 0,
        chats: Object.fromEntries(Object.entries(chats)
          .map(([key, ts]) => [key, Number(ts) || 0])
          .filter(([key, ts]) => /^(group|private):\d+$/.test(key) && ts > 0))
      };
    }
    const legacy = Number(value) || 0;
    return { group: legacy, private: legacy, chats: {} };
  } catch {
    return { group: 0, private: 0, chats: {} };
  }
}

function writeState(file, state) {
  try {
    const now = Date.now();
    const chats = Object.entries(state.chats || {})
      .filter(([, ts]) => now - Number(ts) < CHAT_RETENTION_MS)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, MAX_CHAT_ENTRIES);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      lastAttemptAt: { group: Number(state.group) || 0, private: Number(state.private) || 0, chats: Object.fromEntries(chats) }
    }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 写不进去也不影响正常发言 */ }
}

/** 读状态文件；损坏/缺失按 0 处理。旧数字格式迁移成两个范围共用。 */
export function readProactiveAttempts(file) {
  const state = readState(file);
  return { group: state.group, private: state.private };
}

/** 读完整状态（含 per-chat 时间）。 */
export function readProactiveState(file) {
  return readState(file);
}

/** 只更新一个范围，另一个范围与 per-chat 记录保持不变；原子写，避免半个 JSON 落盘。 */
export function writeProactiveAttempt(file, scope, ts) {
  const state = readState(file);
  state[scope === 'private' ? 'private' : 'group'] = Number(ts) || Date.now();
  writeState(file, state);
}

/** per-chat 模式：只更新指定会话的时间，保留群/私聊范围记录和其它会话。 */
export function writeProactiveChatAttempt(file, chatKey, ts) {
  const key = String(chatKey || '').trim();
  if (!/^(group|private):\d+$/.test(key)) return;
  const state = readState(file);
  state.chats[key] = Number(ts) || Date.now();
  writeState(file, state);
}

/** 批量写多个会话的判定时间：per-chat 模式一次 tick 读/写一次，避免 N 个群写 N 次文件。 */
export function writeProactiveChatAttempts(file, chatKeys, ts) {
  const keys = [...new Set((Array.isArray(chatKeys) ? chatKeys : []).map((key) => String(key || '').trim()))]
    .filter((key) => /^(group|private):\d+$/.test(key));
  if (!keys.length) return;
  const state = readState(file);
  const at = Number(ts) || Date.now();
  for (const key of keys) state.chats[key] = at;
  writeState(file, state);
}
