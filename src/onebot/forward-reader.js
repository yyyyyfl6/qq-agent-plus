// 合并转发的读取：先拿"转发资源 id"，再向 OneBot 要节点列表。
//
// 为什么要走资源 id（2026-09-21，SnowLuma v1.14.15 实测）：新收到的转发卡片用
// get_forward_msg({ message_id }) 查会返回 `retcode=100 download forward message
// payload is empty`，用卡片里的资源 id 查才能拿到内容。资源 id 从当前事件或 get_msg
// 现取，所以是新鲜的；存档里存的是消息 id（资源 id 会过期，不能存）。
//
// 但老适配器/老版本只认 message_id，所以资源 id 这条路失败（报错或空结果）时一律
// 回落 message_id —— 回落也失败才把错误抛出去，不至于把能读的场景读坏。
import { forwardIdFromData } from './onebot.js';

function nodes(result) {
  return Array.isArray(result?.messages) ? result.messages
    : Array.isArray(result?.data?.messages) ? result.data.messages : [];
}

/**
 * @param onebot  OneBot 客户端（只用它的 call）
 * @param messageId  转发卡片自己的 QQ 消息 id（存档里那个 #数字）
 * @param segments  可选：收消息时的原始段数组，有就直接从里面取资源 id
 */
export async function readForwardMessages(onebot, messageId, segments) {
  let message = segments;
  if (!Array.isArray(message)) {
    // 工具路径（读存档）只给了消息 id：get_msg 取回卡片拿到资源 id。
    // 取不到不算错误 —— 老适配器可能不支持 get_msg，直接走下面的兼容路径。
    try {
      const result = await onebot.call('get_msg', { message_id: Number(messageId) });
      message = result?.message ?? result?.data?.message;
    } catch { /* 兼容路径见文件头 */ }
  }
  const id = Array.isArray(message)
    ? message.map(forwardResIdFromSegment).find(Boolean)
    : null;
  if (id) {
    try {
      const messages = nodes(await onebot.call('get_forward_msg', { id: String(id) }));
      if (messages.length) return messages;
    } catch { /* 回落 message_id */ }
  }
  return nodes(await onebot.call('get_forward_msg', { message_id: Number(messageId) }));
}

/**
 * 从消息段里取「合并转发 / 聊天记录卡片」的资源 id。
 * - forward 段：data.id / res_id / forward_id / data_id（见 onebot.forwardIdFromData）
 * - json / xml 卡片：聊天记录卡片（app=com.tencent.multimsg）把资源 id 放在 meta.detail_1.resid，
 *   有的适配器塞在 data.data 的字符串 JSON/XML 里 —— 取到就能用 get_forward_msg({ id }) 读出来。
 *   取不到返回 null（卡片只留摘要，这是协议端给不给的问题，不是深度问题）。
 */
export function forwardResIdFromSegment(seg) {
  if (!seg) return null;
  if (seg.type === 'forward') return forwardIdFromData(seg.data);
  if (seg.type !== 'json' && seg.type !== 'xml') return null;
  const d = seg.data ?? {};
  const raw = typeof d.data === 'string' ? d.data
    : (d.data && typeof d.data === 'object' ? JSON.stringify(d.data) : '');
  const source = String(raw || '').trim();
  if (!source) return null;
  const match = /["']?resid["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})/i.exec(source);
  return match ? match[1] : null;
}

/** 按资源 id（不是消息 id）直接取节点：嵌套转发的内层与卡片记录都走它。 */
export async function readForwardNodesById(onebot, resId) {
  const id = String(resId ?? '').trim();
  if (!id) return [];
  try {
    const messages = nodes(await onebot.call('get_forward_msg', { id }));
    if (messages.length) return messages;
  } catch { /* 老适配器只认 message_id */ }
  // 这个入参是**资源 id，不是消息 id**：resid 常是非数字串，Number() 会得到 NaN 并以 null
  // 上 wire（等于白发一次请求，还把"取到但为空"误当失败）。只有纯数字时才值得当 message_id 再试
  //（2026-10-14 复审 P3）。
  if (!/^\d+$/.test(id)) return [];
  return nodes(await onebot.call('get_forward_msg', { message_id: Number(id) }));
}
