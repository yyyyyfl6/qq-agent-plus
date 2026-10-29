import { getConfig } from './config.js';

/**
 * 屏蔽名单兜底过滤：屏蔽生效前已存档的历史消息，也不能再进模型或工具结果。
 * 入口拦截只管"新消息"，这里管"老库存"。机器人自己的发言（self）不过滤。
 * 跨会话共享时按消息自己的群号取名单，不能只按当前会话过滤 —— 提示词与
 * get_recent_messages 必须同一口径，否则翻页能绕过提示词里的过滤。
 */
export function filterBlockedHistory(messages, chatKey, { crossScope = false } = {}) {
  const [kind, id] = String(chatKey || '').split(':');
  if (crossScope) {
    const blockedSets = new Map(Object.entries(getConfig().blocklist || {})
      .map(([group, list]) => [String(group), new Set((Array.isArray(list) ? list : []).map(String))]));
    return messages.filter((m) => {
      if (m.self) return true;
      const [mKind, groupId] = String(m.chatKey || '').split(':');
      if (mKind !== 'group' || !groupId) return true;
      return !blockedSets.get(String(groupId))?.has(String(m.senderId));
    });
  }
  if (kind === 'group' && id) {
    const blocked = new Set((getConfig().blocklist?.[id] || []).map(String));
    if (blocked.size) return messages.filter((m) => m.self || !blocked.has(String(m.senderId)));
  }
  return messages;
}
