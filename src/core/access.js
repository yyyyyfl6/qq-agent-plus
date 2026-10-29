import { getConfig } from './config.js';
import { isTimeActive } from './time-gate.js';
import { idList } from './list.js';

// 名单字段读成字符串数组的守卫集中到 list.js；这里保留导出，兼容既有调用方。
export { idList };

export function chatAllowed(chatKey, cfg = getConfig()) {
  const [kind, id] = String(chatKey).split(':');
  if (!['group', 'private'].includes(kind) || !/^\d+$/.test(id || '')) return false;
  const field = kind === 'group' ? 'groups' : 'private';
  if (idList(cfg.deny?.[field]).includes(id)) return false;
  const allow = idList(cfg.allow?.[field]);
  return allow.length ? allow.includes(id) : cfg.allowAllWhenEmpty === true;
}

export function canRun(chatKey) {
  const cfg = getConfig();
  return cfg.runtime?.mode === 'active' && !cfg.runtime?.paused
    && chatAllowed(chatKey, cfg) && isTimeActive(chatKey);
}

/**
 * 发送前置检查。
 *
 * `gameScoped`：**只**由群游戏管理器对"本局在册玩家"的私聊使用（报名 = 同意接收）——
 * 放宽的是 allow.private 这一条，**deny.private 仍然优先**（管理员屏蔽谁就发不进去），
 * 活跃时段/运行模式照旧。模型自己发消息（send_message / send_voice 工具）永远不带这个标记，
 * 所以"引擎文本只发给在册玩家"这条不变量不依赖模型自觉。
 */
export function assertCanSend(chatKey, signal, { gameScoped = false } = {}) {
  signal?.throwIfAborted();
  if (!isTimeActive(chatKey)) throw new Error('非活跃时间，禁止发送消息');
  const cfg = getConfig();
  const [kind, id] = String(chatKey).split(':');
  // /^\d+$/ 是有意收紧的：私聊命名空间在生产里就是 QQ 号，这道判据确保豁免只作用于它。
  // 副作用：非数字 id 的测试世界拿不到豁免（入站仍收得到行动，出站发不出身份/回执），
  // 排查时别把它当成"私聊白名单配错了"（2026-09-29 审查 P2）。
  if (gameScoped && kind === 'private' && /^\d+$/.test(id || '')) {
    if (cfg.runtime?.mode !== 'active' || cfg.runtime?.paused) {
      throw new Error('Send blocked: observe/paused mode or chat not allowed');
    }
    // 与 chatAllowed 同一口径：名单形状坏掉时按"空名单"处理，别在这里抛（这条在每次
    // 游戏作用域的私聊发送上，抛一次就等于那条链路静默坏掉）
    if (idList(cfg.deny?.private).includes(id)) {
      throw new Error('Send blocked: 该用户被管理员屏蔽（deny 优先于游戏豁免）');
    }
    return;
  }
  if (!canRun(chatKey)) throw new Error('Send blocked: observe/paused mode or chat not allowed');
}
