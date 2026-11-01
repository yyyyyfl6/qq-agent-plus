// 扩展功能的专属指令（与「切鱼 / 切猫」人格切换同一套形态）：
//   · 在唤醒模型**之前**消费：命中指令的消息不进模型、不花聊天 token，结果由代码直接回复；
//   · 指令词完整匹配（后面可跟空格 + 参数），可在各自页面里改；
//   · 同一条协议消息重复投递（补拉/重放）不会执行第二次。
//
// 群聊总结（chatSummary.commands，默认「/总结」「总结一下」）：
//   /总结            → 按默认条数总结并发到当前会话
//   /总结 200        → 最近 200 条
//   /总结 3h         → 最近 3 小时（也认「3小时」）
//   /总结 周末聚餐   → 其余文字当成"侧重点"
//   谁能用：chatSummary.commandAccess = everyone（默认，受每小时额度约束）| owner
//
// 大肥鱼桥（labBridge.commands，默认「/lab」「/大肥鱼」）：只认管理员本人；privateOnly 时只在私聊
//   /lab <任务>      → 派给实验室电脑，回一句"已派发 #N"，跑完自动回报
//   /lab             → 最近任务列表
//   /lab 结果 N      → 第 N 个任务的输出（也认 result）
//   /lab 取消 N      → 取消（也认 cancel）
//   /lab ping        → 测连通
//
// 陪伴（companion.commands，默认「/陪伴」）：只在私聊、只认陪伴对象本人或管理员
//   /陪伴 [状态|日程|日记 [日期/关键词]|日期]
import { getConfig } from '../core/config.js';
import { chatSummaryConfig } from './chat-summary.js';
import { clipOutput, labBridgeConfig, labBridgeConfigured } from './lab-bridge.js';
import { ownerUin } from './shared.js';
import { companionConfig } from './companion.js';

/** 文本是否以某个指令词开头（完整词：后面要么结束、要么是空白）。返回参数串或 null。 */
export function matchCommand(text, commands) {
  const s = String(text || '').trim();
  for (const raw of commands || []) {
    const cmd = String(raw || '').trim();
    if (!cmd) continue;
    if (s === cmd) return '';
    if (s.startsWith(cmd) && /\s/.test(s.charAt(cmd.length))) return s.slice(cmd.length).trim();
  }
  return null;
}

/** /总结 的参数：数字=条数，Nh/N小时=时长，其余=侧重点。 */
export function parseSummaryArgs(arg) {
  const out = { count: 0, hours: 0, focus: '' };
  const rest = [];
  for (const part of String(arg || '').split(/\s+/).filter(Boolean)) {
    let m;
    if (!out.count && !out.hours && (m = /^(\d{1,4})(条)?$/.exec(part))) out.count = Number(m[1]);
    else if (!out.count && !out.hours && (m = /^(\d{1,2})\s*(h|小时|个小时)$/i.exec(part))) out.hours = Number(m[1]);
    else rest.push(part);
  }
  out.focus = rest.join(' ').slice(0, 120);
  return out;
}

export class ExtensionCommands {
  constructor({ getRuntimes, send, log = console.log } = {}) {
    this.getRuntimes = getRuntimes;
    this.send = send;               // (chatKey, text) => Promise —— 宿主负责按当前人格分仓发送
    this.log = log;
    this.seen = new Map();          // chatKey|mid → ts（内存去重；派发类另有持久去重）
  }

  #dedupe(chatKey, mid) {
    if (mid == null) return false;
    const key = `${chatKey}|${mid}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 2000) {
      for (const k of [...this.seen.keys()].slice(0, 500)) this.seen.delete(k);
    }
    return false;
  }

  /** 命中并处理了返回 true（宿主据此不再把这条消息交给模型）。 */
  async consume(chatKey, senderId, text, mid = null) {
    const cfg = getConfig();
    const kind = String(chatKey).split(':')[0];
    const summary = chatSummaryConfig(cfg);
    const lab = labBridgeConfig(cfg);

    if (summary.enabled && summary.commands.length) {
      const arg = matchCommand(text, summary.commands);
      if (arg !== null) {
        if (summary.commandAccess === 'owner' && String(senderId) !== ownerUin(cfg)) return false;
        if (this.#dedupe(chatKey, mid)) return true;
        await this.#runSummary(chatKey, arg);
        return true;
      }
    }

    if (labBridgeConfigured(cfg) && lab.commands.length) {
      const arg = matchCommand(text, lab.commands);
      if (arg !== null) {
        // 非管理员 / 非私聊：当普通消息处理（和人格切换指令一样，不暴露指令存在）
        if (!ownerUin(cfg) || String(senderId) !== ownerUin(cfg)) return false;
        if (lab.privateOnly && kind !== 'private') return false;
        if (this.#dedupe(chatKey, mid)) return true;
        await this.#runLab(chatKey, senderId, arg, mid);
        return true;
      }
    }
    const comp = companionConfig(cfg);
    if (comp.enabled && comp.commands.length && kind === 'private') {
      const arg = matchCommand(text, comp.commands);
      const rt = this.getRuntimes()?.companion;
      if (arg !== null && rt && rt.commandAllowed(chatKey, senderId, comp)) {
        if (this.#dedupe(chatKey, mid)) return true;
        try {
          await this.#reply(chatKey, await rt.command(chatKey, arg));
        } catch (error) {
          await this.#reply(chatKey, `陪伴指令出错：${String(error?.message ?? error).slice(0, 120)}`);
        }
        return true;
      }
    }
    return false;
  }

  async #reply(chatKey, text) {
    try {
      await this.send(chatKey, text);
    } catch (error) {
      this.log(`[ext-commands] 回复失败：${error?.message ?? error}`);
    }
  }

  async #runSummary(chatKey, arg) {
    const rt = this.getRuntimes()?.chatSummary;
    if (!rt) return;
    const { count, hours, focus } = parseSummaryArgs(arg);
    try {
      const rec = await rt.summarize(chatKey, { count, hours, focus });
      await rt.send(chatKey, rec.text);
    } catch (error) {
      await this.#reply(chatKey, `总结不了：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  async #runLab(chatKey, senderId, arg, mid) {
    const rt = this.getRuntimes()?.labBridge;
    if (!rt) return;
    const name = labBridgeConfig().name;
    const [head, ...tail] = arg.split(/\s+/);
    const idArg = Number(String(tail[0] || '').replace(/\D/g, ''));
    try {
      if (!arg) {
        const tasks = rt.list(5);
        await this.#reply(chatKey, tasks.length
          ? `${name}最近的任务：\n${tasks.map((t) => `#${t.id} ${t.state} · ${t.prompt.slice(0, 40)}`).join('\n')}`
          : `${name}还没有任务。用法：${labBridgeConfig().commands[0]} <要做的事>`);
        return;
      }
      if (/^ping$/i.test(head) && !tail.length) {
        const r = await rt.ping();
        await this.#reply(chatKey, `${name}在线（${r.ms} ms）${r.info?.busy ? '，正在忙' : ''}`);
        return;
      }
      if (/^(结果|result|输出)$/i.test(head) && idArg) {
        const t = rt.get(idArg);
        await this.#reply(chatKey, t ? `#${t.id} ${t.state}\n${clipOutput(t.output || t.error || '（暂无输出）', 1500)}` : `没有任务 #${idArg}`);
        return;
      }
      if (/^(取消|cancel)$/i.test(head) && idArg) {
        const t = await rt.cancel(idArg);
        await this.#reply(chatKey, `#${t.id} 现在是 ${t.state}`);
        return;
      }
      // 持久去重：协议在服务重启后重放同一条消息时，内存去重已经丢了，按任务记录里的来源 mid 再挡一次
      if (mid != null && rt.list(200).some((t) => t.chatKey === chatKey && String(t.originMid || '') === String(mid))) return;
      const t = await rt.dispatch(arg, { chatKey, userId: String(senderId), via: 'qq', originMid: mid == null ? '' : String(mid) });
      if (t.state === 'failed') await this.#reply(chatKey, `派发失败：${t.error}`);
      else if (t.state === 'unknown') await this.#reply(chatKey, `#${t.id} 派发结果不确定：${t.error}`);
      else await this.#reply(chatKey, `🐟 已交给${name}（#${t.id}），跑完会把结果发回来`);
    } catch (error) {
      await this.#reply(chatKey, `大肥鱼桥出错：${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
}
