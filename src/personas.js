import { readFileSync } from 'node:fs';

export function normalizeBehaviorProfile(value) {
  const profile = value ?? 'legacy';
  // legacy = 原版群友、grounded = 自然可靠、card = 角色卡优先。
  // card：平台只保留安全与工具/记忆等机制，语气、节奏、句式交给角色卡（Issue #40）。
  if (!['legacy', 'grounded', 'card'].includes(profile)) throw new Error('Invalid persona behavior profile');
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
//   roles/lezi-ren.md                乐子人（抽象梗王），legacy 档：接梗翻新、不踩人、见好就收。
//   roles/sunba.md                   孙吧大肥鱼（抽象乐子人），legacy 档：孙吧/抽象底色，
//                                    认爹反杀只是绝活之一，只钓玩得起的人，不碰身份。
//   roles/xuexi-dazi.md              学习搭子（资料整理），grounded 档：拆任务、查资料、不代写。
//
// 新增卡时的约定：正文只写在 roles/ 下，用真实工具名，别引用旧架构专属指令；
// test/personas.test.mjs 会检查"roles/ 下的每个文件都已登记"。
//
// 用相对模块 URL 读取，不依赖启动工作目录；部署时必须带上 roles/（完整同步会包含）。
const readRole = (file) => readFileSync(new URL(`../roles/${file}`, import.meta.url), 'utf8').trim();

// 每张卡的声音参数（气泡长度/条数/间隔）：让"卡里写的短句"和实际发出去的长度一致。
// 文件缺失或某项写坏都回落默认值 —— 声音参数只是发送节奏，不该让整张卡加载失败。
const DEFAULT_VOICE = { maxChars: 60, maxBubbles: 3, pauseMs: [600, 1800] };
const VOICE_PROFILES = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL('../roles/voice-profiles.json', import.meta.url), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
})();

function normalizeVoice(profile) {
  if (!profile || typeof profile !== 'object') return { ...DEFAULT_VOICE, pauseMs: [...DEFAULT_VOICE.pauseMs] };
  const maxChars = Number(profile.maxChars);
  const maxBubbles = Number(profile.maxBubbles);
  const pause = Array.isArray(profile.pauseMs) ? profile.pauseMs.map(Number).filter(Number.isFinite) : [];
  const pauseMs = pause.length >= 2
    ? [Math.max(0, Math.min(pause[0], pause[1])), Math.min(30000, Math.max(pause[0], pause[1]))]
    : [...DEFAULT_VOICE.pauseMs];
  return {
    maxChars: Number.isFinite(maxChars) ? Math.max(10, Math.min(2000, Math.round(maxChars))) : DEFAULT_VOICE.maxChars,
    maxBubbles: Number.isFinite(maxBubbles) ? Math.max(1, Math.min(8, Math.round(maxBubbles))) : DEFAULT_VOICE.maxBubbles,
    pauseMs
  };
}

export const PERSONAS = {
  blue_fish: { name: '蓝色大肥鱼', behaviorProfile: 'legacy', text: readRole('blue-fish.md') },
  hajimi: { name: '哈基米', behaviorProfile: 'legacy', text: readRole('hajimi.md') },
  xiaojingyu: {
    name: '小鲸鱼（默认）',
    behaviorProfile: 'legacy',
    text: readRole('xiaojingyu.md'),
    voice: normalizeVoice(VOICE_PROFILES.xiaojingyu)
  },
  duzui_sunyou: {
    name: '损友（毒舌吐槽）',
    behaviorProfile: 'legacy',
    text: readRole('duzui-sunyou.md'),
    voice: normalizeVoice(VOICE_PROFILES.duzui_sunyou)
  },
  wenrou_peiliao: {
    name: '温柔陪聊（知心）',
    behaviorProfile: 'grounded',
    text: readRole('wenrou-peiliao.md'),
    voice: normalizeVoice(VOICE_PROFILES.wenrou_peiliao)
  },
  jishu_zhai: {
    name: '技术宅（自建服务）',
    behaviorProfile: 'grounded',
    text: readRole('jishu-zhai.md'),
    voice: normalizeVoice(VOICE_PROFILES.jishu_zhai)
  },
  maoniang: {
    name: '猫娘（二次元）',
    behaviorProfile: 'legacy',
    text: readRole('maoniang.md'),
    voice: normalizeVoice(VOICE_PROFILES.maoniang)
  },
  lezi_ren: {
    name: '乐子人（抽象梗王）',
    behaviorProfile: 'legacy',
    text: readRole('lezi-ren.md'),
    voice: normalizeVoice(VOICE_PROFILES.lezi_ren)
  },
  sunba: {
    name: '孙吧大肥鱼（抽象乐子人）',
    behaviorProfile: 'legacy',
    text: readRole('sunba.md'),
    voice: normalizeVoice(VOICE_PROFILES.sunba)
  },
  xuexi_dazi: {
    name: '学习搭子（资料整理）',
    behaviorProfile: 'grounded',
    text: readRole('xuexi-dazi.md'),
    voice: normalizeVoice(VOICE_PROFILES.xuexi_dazi)
  }
};

/** 当前生效的人设对应的声音参数；自定义卡（没有 templateId）返回 null，走平台默认。 */
export function voiceForPersona(persona) {
  const id = String(persona?.templateId || '').trim();
  if (!id) return null;
  return builtinPersonaTemplate(id)?.voice || null;
}

/** 内置卡 id 列表（控制台与校验用）。 */
export const PERSONA_TEMPLATE_IDS = Object.keys(PERSONAS);

/** 按 id 取内置卡；不是内置 id（自定义卡、空值）返回 null。 */
export function builtinPersonaTemplate(id) {
  const key = String(id ?? '').trim();
  return Object.prototype.hasOwnProperty.call(PERSONAS, key) ? PERSONAS[key] : null;
}

/**
 * 按会话解析出生效的人设：全局 `persona` + `personaPerChat[chatKey]` 覆盖。
 *
 * 覆盖字段都是"决定口吻"的那几项；没写的继承全局。指定了内置卡（templateId）时，
 * 正文与档位以卡为准（否则会出现"猫娘的正文 + 全局的 legacy 档"这种混合体）；
 * 卡 id 认不出来时回落全局正文，避免整个提示词被换空。
 *
 * 纯函数：不读写磁盘，调用方（编排器）每轮按 chatKey 取一次即可。
 */
export function resolvePersona(cfg, chatKey) {
  const base = cfg?.persona && typeof cfg.persona === 'object' ? cfg.persona : {};
  if (cfg?.skins?.enabled && cfg?.activeSkinId) return base;
  const key = String(chatKey || '');
  const overlay = key && cfg?.personaPerChat && typeof cfg.personaPerChat === 'object'
    ? cfg.personaPerChat[key]
    : null;
  if (!overlay || typeof overlay !== 'object') return base;
  const merged = { ...base, ...overlay };
  const templateId = String(overlay.templateId || '').trim();
  if (templateId) {
    const template = builtinPersonaTemplate(templateId);
    if (template) {
      merged.roleText = template.text;
      // 档位跟着卡走是"猫娘正文 + legacy 档"那种混合体的防线；但角色卡优先是管理员的
      // 全局选择（只想留安全/机制），按群换一张内置卡不应该把整个群悄悄退回平台语气。
      if (overlay.behaviorProfile === undefined && base.behaviorProfile !== 'card') {
        merged.behaviorProfile = template.behaviorProfile || 'legacy';
      }
    } else {
      merged.roleText = base.roleText;
    }
  }
  return merged;
}

/**
 * 内置卡绑定：只要实例还绑着内置卡（persona.templateId），就按 roles/*.md 的正文刷新副本。
 *
 * 背景：实例里存的是角色正文的**副本**（persona.roleText）。卡文件改了副本不会自己更新，
 * 以前必须在控制台重选一次卡才生效，"改完卡没生效"因此被反复当成 bug 报上来。
 * 现在的约定：卡文件是唯一来源 —— 控制台选卡时把模板 id 一起存下来
 * （手写正文或选自定义卡会清空 id），载入配置时发现正文与文件不一致就按文件刷新。
 *
 * 只刷正文，不碰 behaviorProfile：档位（legacy / grounded / card）是实例自己的行为开关，
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

/**
 * 按群人设里的卡 id 校验：认不出的 id 清掉（运行时回落全局正文），
 * 免得实例一直挂着一个永远不会生效的绑定。
 */
export function applyPersonaPerChatTemplates(cfg) {
  const perChat = cfg?.personaPerChat;
  if (!perChat || typeof perChat !== 'object') return;
  for (const [key, entry] of Object.entries(perChat)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.templateId || '').trim();
    if (!id) continue;
    if (!builtinPersonaTemplate(id)) {
      delete entry.templateId;
      // 只看"还有没有别的白名单字段"，别自己再列一遍 —— 漏掉 participation /
      // behaviorProfile 会把用户单独设过的偏好一起删掉（2026-10-18 审查 P2）
      if (!Object.keys(entry).length) delete perChat[key];
    }
  }
}
