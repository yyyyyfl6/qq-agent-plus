import { readFileSync } from 'node:fs';

export function normalizeBehaviorProfile(value) {
  const profile = value ?? 'legacy';
  if (!['legacy', 'grounded'].includes(profile)) throw new Error('Invalid persona behavior profile');
  return profile;
}

// 人设模板库：**角色卡正文的唯一来源是 roles/ 目录**，一张卡一个 markdown 文件，
// 这里只做登记（id → 文件 / 显示名 / 语气档位），不再把正文内联进代码。
//
//   roles/xiaojingyu.md              默认人设：原版 qq-bridge 的"小鲸鱼"角色卡。
//                                    已把其中旧架构专属指令（[SILENT]、qq_* MCP 工具名、
//                                    唤醒配置、空格分条等）适配为本程序的机制
//                                    （安静结束、send_message 数组分条、原生工具名），
//                                    人格与示例原样保留。
//   roles/duzui-sunyou.md            损友（毒舌吐槽），legacy 档：短句接梗、只损能开玩笑的事。
//   roles/wenrou-peiliao.md          温柔陪聊（知心），grounded 档：会听、不诊断、不承诺陪伴。
//   roles/jishu-zhai.md              技术宅（自建服务），grounded 档：先问关键信息、留出不确定。
//   roles/maoniang.md                猫娘（二次元），legacy 档：喵是每轮的底线（不是点缀），
//                                    傲娇只做调味、落点是"给了"，不擦边不病娇。
//
// 新增卡时的约定：正文只写在 roles/ 下，用真实工具名，别引用旧架构专属指令；
// test/personas.test.mjs 会检查"roles/ 下的每个文件都已登记"。
//
// 用相对模块 URL 读取，不依赖启动工作目录；部署时必须带上 roles/（完整同步会包含）。
const readRole = (file) => readFileSync(new URL(`../roles/${file}`, import.meta.url), 'utf8').trim();

export const PERSONAS = {
  blue_fish: { name: '蓝色大肥鱼', behaviorProfile: 'legacy', text: readRole('blue-fish.md') },
  hajimi: { name: '哈基米', behaviorProfile: 'legacy', text: readRole('hajimi.md') },
  xiaojingyu: {
    name: '小鲸鱼（默认）',
    behaviorProfile: 'legacy',
    text: readRole('xiaojingyu.md')
  },
  duzui_sunyou: {
    name: '损友（毒舌吐槽）',
    behaviorProfile: 'legacy',
    text: readRole('duzui-sunyou.md')
  },
  wenrou_peiliao: {
    name: '温柔陪聊（知心）',
    behaviorProfile: 'grounded',
    text: readRole('wenrou-peiliao.md')
  },
  jishu_zhai: {
    name: '技术宅（自建服务）',
    behaviorProfile: 'grounded',
    text: readRole('jishu-zhai.md')
  },
  maoniang: {
    name: '猫娘（二次元）',
    behaviorProfile: 'legacy',
    text: readRole('maoniang.md')
  }
};

/** 内置卡 id 列表（控制台与校验用）。 */
export const PERSONA_TEMPLATE_IDS = Object.keys(PERSONAS);

/** 按 id 取内置卡；不是内置 id（自定义卡、空值）返回 null。 */
export function builtinPersonaTemplate(id) {
  const key = String(id ?? '').trim();
  return Object.prototype.hasOwnProperty.call(PERSONAS, key) ? PERSONAS[key] : null;
}

/**
 * 内置卡绑定：只要实例还绑着内置卡（persona.templateId），就按 roles/*.md 的正文刷新副本。
 *
 * 背景：实例里存的是角色正文的**副本**（persona.roleText）。卡文件改了副本不会自己更新，
 * 以前必须在控制台重选一次卡才生效，"改完卡没生效"因此被反复当成 bug 报上来。
 * 现在的约定：卡文件是唯一来源 —— 控制台选卡时把模板 id 一起存下来
 * （手写正文或选自定义卡会清空 id），载入配置时发现正文与文件不一致就按文件刷新。
 *
 * 只刷正文，不碰 behaviorProfile：档位（legacy / grounded）是实例自己的行为开关，
 * 在控制台选卡时一起设置；这里悄悄改掉会让"只改档位"的调用被卡文件顶回去。
 *
 * 认不出的 id（老版本删掉/改过名的卡、外部手写进来的值）会被清成未绑定 ——
 * 否则实例会一直挂着一个永远不会生效的 id，控制台里也看不出为什么正文不跟着卡走。
 *
 * @returns {{id: string, name: string} | null} 发生刷新时返回卡信息，否则 null。
 */
export function applyPersonaTemplate(cfg) {
  const persona = cfg?.persona;
  if (!persona || typeof persona !== 'object') return null;
  const rawId = persona.templateId === undefined || persona.templateId === null
    ? ''
    : String(persona.templateId).trim();
  const template = builtinPersonaTemplate(rawId);
  if (!template) {
    if (rawId) persona.templateId = '';
    return null;
  }
  const nextText = String(template.text).trim();
  if (String(persona.roleText || '').trim() === nextText) return null;
  persona.roleText = nextText;
  return { id: rawId, name: template.name };
}
