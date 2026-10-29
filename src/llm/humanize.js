// 反 AI 味：只处理"一眼像助手"的固定说法，不改写正常内容。
// 这里是纯函数，发送工具在真正发出去之前调用；是否拦截由 humanize.antiAi.blockSevere 决定。

const SEVERE_RULES = [
  {
    label: 'AI 自指',
    // 只吃"作为一个 AI / 身为语言模型"这类独立从句；"作为一个 AI 产品经理"不是自指，不能误删。
    re: /(?:作为|身为)(?:一个)?(?:AI|人工智能|语言模型|智能助手)(?:(?:语言模型|助手|机器人)?[，,。！？!?]|$)/gi
  },
  {
    label: 'AI 免责',
    re: /我(?:只)?是(?:一个)?(?:AI|人工智能|语言模型|智能助手)(?:(?:语言模型|助手|机器人)?[，,。！？!?]|$)/gi
  },
  {
    label: '客服收尾',
    re: /希望(?:这|以上)?(?:些|个|段)?(?:回答|内容|信息|建议)?(?:能)?对你(?:有所|有)?帮助[。！!]?/g
  },
  {
    label: '英文 AI 自指',
    re: /as an? (?:AI|artificial intelligence|language model)[^.!?\n]*[.!?]?/gi
  }
];

const SOFT_RULES = [
  [/首先[，,]\s*/g, ''],
  [/其次[，,]\s*/g, '然后，'],
  [/最后[，,]\s*/g, ''],
  [/总之[，,]\s*/g, '反正，'],
  [/综上所述[，,]\s*/g, ''],
  [/总的来说[，,]\s*/g, ''],
  [/需要注意的是[，,]\s*/g, ''],
  [/值得一提的是[，,]\s*/g, ''],
  [/值得注意的一点是[，,]\s*/g, ''],
  [/需要指出的是[，,]\s*/g, '']
];

function matchesOf(text, rule) {
  const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
  const re = new RegExp(rule.source, flags);
  return String(text).match(re) || [];
}

/** 返回命中的 AI 味片段；severity=severe 的句子通常需要重写，不是删几个词能救的。 */
export function findAiTells(text) {
  const source = String(text ?? '');
  const out = [];
  for (const rule of SEVERE_RULES) {
    for (const match of matchesOf(source, rule.re)) {
      out.push({ severity: 'severe', label: rule.label, match });
    }
  }
  for (const [re] of SOFT_RULES) {
    for (const match of matchesOf(source, re)) {
      out.push({ severity: 'soft', label: '助手连接词', match });
    }
  }
  return out;
}

/** 梗密度档位；配置里手改坏了按 normal 处理，不把整段提示词弄丢。 */
export const MEME_USE_LEVELS = ['off', 'light', 'normal', 'heavy'];

export function normalizeMemeUseLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  return MEME_USE_LEVELS.includes(level) ? level : 'normal';
}

/**
 * 本轮注入 user 消息的梗密度提示（不拼 system，避免改设置就让前缀缓存失效）。
 * 只在拟人化表达总开关打开时生效；技术/学习/情绪严肃场景的“不用梗”仍由系统提示兜底。
 */
export function memeDensityPrompt(cfg) {
  if (cfg?.humanize?.enabled !== true) return '';
  const level = normalizeMemeUseLevel(cfg?.humanize?.memeUse?.level);
  if (level === 'off') {
    return '【梗密度】关闭：这轮不要主动用网络梗；别人用梗时只按含义理解，不接梗、不复读。';
  }
  if (level === 'light') {
    return '【梗密度】克制：优先接住对方刚用的梗，不主动抛新梗；一轮最多一个，不解释、不复读。';
  }
  if (level === 'heavy') {
    return '【梗密度】活跃：闲聊里可以更主动地带梗，但别硬塞；一轮最多一个；技术、学习、情绪严肃场景仍不用。';
  }
  return '【梗密度】正常：对方用梗先接住；话题贴合时可以主动用一次；一轮最多一个，不解释、不复读，不贴合就不用。';
}

/**
 * 去掉固定 AI 味说法。正常聊天基本不受影响；删完只剩空串时返回空串，由调用方决定是否补一句。
 * @returns {{text:string, tells:Array, changed:boolean, severe:boolean}}
 */
export function humanizeText(text, { enabled = true, soft = true } = {}) {
  const source = String(text ?? '');
  if (!enabled) return { text: source, tells: [], changed: false, severe: false };
  const tells = findAiTells(source);
  // 没命中就原样返回：普通消息里的双空格、制表符、代码缩进都不该被顺手改掉。
  if (!tells.length) return { text: source, tells, changed: false, severe: false };
  let out = source;
  for (const rule of SEVERE_RULES) out = out.replace(rule.re, '');
  // grounded（自然可靠）档保留"首先/其次"这类结构词：那是该档要的可靠表达。
  if (soft) for (const [re, replacement] of SOFT_RULES) out = out.replace(re, replacement);
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？!?,.;；：:])/g, '$1')
    .trim();
  return {
    text: out,
    tells,
    changed: out !== source,
    severe: tells.some((tell) => tell.severity === 'severe')
  };
}
