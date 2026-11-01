// 趣味小功能（参考 AstrBot 插件市场里常见的 jrrp / 今日运势 / 塔罗牌）。
// 全部离线、零花费：结果由代码决定（"今日"类按 QQ 号 + 北京日期确定性生成，一天内问几次都一样），
// 模型只负责用自己的口吻说出来 —— 不让模型自己编数字，免得同一个人一会儿 90 一会儿 12。
import crypto from 'node:crypto';
import { getConfig, updateConfig } from '../core/config.js';
import { err, isPlainObject, ok, shanghaiDate, triggerSenderIdsOf } from './shared.js';

export const FUN_TOOLS_DEFAULTS = Object.freeze({
  enabled: false,
  jrrp: true,       // 今日人品
  fortune: true,    // 今日运势（吉凶 + 宜忌）
  tarot: true       // 塔罗牌
});

export function funToolsConfig(cfg = getConfig()) {
  const raw = isPlainObject(cfg?.funTools) ? cfg.funTools : {};
  return {
    enabled: raw.enabled === true,
    jrrp: raw.jrrp !== false,
    fortune: raw.fortune !== false,
    tarot: raw.tarot !== false
  };
}

export function saveFunToolsConfig(patch = {}) {
  const normalized = funToolsConfig({ funTools: { ...funToolsConfig(), ...(isPlainObject(patch) ? patch : {}) } });
  updateConfig({ funTools: normalized });
  return normalized;
}

/** 确定性"随机"：同一个种子永远得到同一串数。 */
function seeded(seed) {
  let counter = 0;
  return () => {
    const h = crypto.createHash('sha256').update(`${seed}#${counter++}`).digest();
    return h.readUInt32BE(0) / 0x100000000;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

export function jrrp(userId, ts = Date.now()) {
  const rand = seeded(`jrrp|${userId}|${shanghaiDate(ts)}`);
  // 轻微偏向中间值，两头稀有一点才有"今天欧/非"的惊喜
  const value = Math.round(((rand() + rand() + rand()) / 3) * 100);
  const level = value >= 95 ? '欧皇附体' : value >= 80 ? '很不错' : value >= 60 ? '还行' : value >= 40 ? '一般般' : value >= 15 ? '有点非' : '非酋本酋';
  return { date: shanghaiDate(ts), value, level };
}

const LUCK = [
  ['大吉', 6], ['中吉', 12], ['小吉', 18], ['吉', 20], ['末吉', 16], ['平', 14], ['凶', 9], ['大凶', 5]
];
const GOOD = ['摸鱼', '早睡', '喝奶茶', '打游戏', '表白', '写代码', '跑步', '整理房间', '看番', '出门散步', '吃顿好的', '给朋友发消息', '学新东西', '水群', '听歌', '拍照', '洗头', '复习', '刷题', '做饭'];
const BAD = ['熬夜', '冲动消费', '和人吵架', '立 flag', '空腹喝咖啡', '删库', '周五上线', '拖延', '吃太撑', '在群里发长语音', '借钱', '赌狗', '看恐怖片', '剪头发', '翻旧账', '忘带伞', '改需求', '跳过备份', '抬杠', '晚上点外卖'];

export function fortune(userId, ts = Date.now()) {
  const rand = seeded(`fortune|${userId}|${shanghaiDate(ts)}`);
  const total = LUCK.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  let luck = LUCK[0][0];
  for (const [name, w] of LUCK) { if ((r -= w) < 0) { luck = name; break; } }
  const good = new Set(); const bad = new Set();
  while (good.size < 2) good.add(pick(rand, GOOD));
  while (bad.size < 2) { const b = pick(rand, BAD); if (!good.has(b)) bad.add(b); }
  const colors = ['红色', '橙色', '黄色', '绿色', '青色', '蓝色', '紫色', '白色', '黑色', '粉色'];
  return {
    date: shanghaiDate(ts),
    luck,
    good: [...good],
    bad: [...bad],
    luckyNumber: 1 + Math.floor(rand() * 99),
    luckyColor: pick(rand, colors)
  };
}

const MAJOR_ARCANA = [
  ['愚者', '新的开始、冒险、天真', '鲁莽、迟疑、错失良机'],
  ['魔术师', '创造力、行动、资源到位', '空有想法、欺瞒、缺乏专注'],
  ['女祭司', '直觉、内省、静待时机', '忽视直觉、秘密外泄'],
  ['女皇', '丰盛、滋养、享受生活', '依赖、过度放纵'],
  ['皇帝', '秩序、掌控、稳定', '固执、控制欲过强'],
  ['教皇', '传统、学习、指引', '打破常规、教条束缚'],
  ['恋人', '选择、关系、心意相通', '犹豫不决、关系失衡'],
  ['战车', '意志、前进、胜利', '失控、方向混乱'],
  ['力量', '勇气、耐心、以柔克刚', '自我怀疑、急躁'],
  ['隐者', '独处、思考、寻找答案', '孤立、逃避'],
  ['命运之轮', '转机、好运、顺势而为', '时运不济、抗拒变化'],
  ['正义', '公平、因果、理性决断', '偏颇、逃避责任'],
  ['倒吊人', '换个角度、暂停、牺牲', '无谓的拖延、白白付出'],
  ['死神', '结束与新生、告别旧事', '抗拒改变、停滞'],
  ['节制', '平衡、调和、慢慢来', '失衡、过度'],
  ['恶魔', '诱惑、执念、欲望', '挣脱束缚、觉醒'],
  ['高塔', '突变、打破、意外', '躲过一劫、迟来的崩塌'],
  ['星星', '希望、治愈、灵感', '失望、信心不足'],
  ['月亮', '不安、迷雾、潜意识', '真相渐明、走出迷茫'],
  ['太阳', '快乐、成功、活力', '短暂低落、过度乐观'],
  ['审判', '觉醒、复盘、重新出发', '自我否定、犹豫不决'],
  ['世界', '圆满、达成、旅程完成', '差临门一脚、未竟之事']
];

export function drawTarot(count = 1, rand = Math.random) {
  const n = count === 3 ? 3 : 1;
  const deck = MAJOR_ARCANA.map((card, i) => ({ card, i }));
  const out = [];
  const positions = n === 3 ? ['过去', '现在', '未来'] : ['指引'];
  for (let k = 0; k < n; k += 1) {
    const idx = Math.floor(rand() * deck.length);
    const [{ card }] = deck.splice(idx, 1);
    const reversed = rand() < 0.5;
    out.push({ position: positions[k], name: card[0], orientation: reversed ? '逆位' : '正位', meaning: reversed ? card[2] : card[1] });
  }
  return out;
}

export function funToolDefs() {
  return [{
    name: 'daily_fun',
    extension: 'funTools',
    available: ({ cfg }) => funToolsConfig(cfg).enabled,
    description: '群友玩"今日人品 / jrrp""今日运势 / 抽签""塔罗牌 / 占卜"时用。结果由系统决定（今日类一天内固定），'
      + '你只负责用自己的口吻说出来、可以顺手调侃两句；不要自己编数字或换结果。userId 填要算的那个人的 QQ（一般是提问的人）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['jrrp', 'fortune', 'tarot'] },
        userId: { type: ['string', 'integer'], description: 'jrrp / fortune：算谁的（QQ 号）' },
        cards: { type: 'integer', enum: [1, 3], description: 'tarot：抽 1 张或 3 张（过去/现在/未来）' },
        question: { type: 'string', description: 'tarot：对方想问的事（可选，仅供你解读时参考）' }
      },
      required: ['kind']
    },
    async execute(ctx, args) {
      const c = funToolsConfig();
      const kind = String(args.kind || '');
      if (!c[kind]) return err(`「${kind}」这个玩法在控制台里关掉了`);
      const uid = String(args.userId ?? '').replace(/\D/g, '') || String(triggerSenderIdsOf(ctx).at(-1) || '');
      if (kind === 'jrrp') {
        if (!uid) return err('需要 userId');
        return ok({ userId: uid, ...jrrp(uid) });
      }
      if (kind === 'fortune') {
        if (!uid) return err('需要 userId');
        return ok({ userId: uid, ...fortune(uid) });
      }
      if (kind === 'tarot') {
        return ok({ question: String(args.question || '').slice(0, 100), cards: drawTarot(Number(args.cards) === 3 ? 3 : 1), note: '用轻松的口吻解读，别说得太玄乎，也别当真预言。' });
      }
      return err('未知玩法');
    }
  }];
}

export function registerFunToolsRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  router.add('GET', '/api/ext/fun-tools', async (req, res) => json(res, 200, {
    ok: true,
    config: funToolsConfig(),
    sample: { jrrp: jrrp('10000'), fortune: fortune('10000'), tarot: drawTarot(3) }
  }));
  router.add('POST', '/api/ext/fun-tools/config', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    try {
      return json(res, 200, { ok: true, config: saveFunToolsConfig(body?.config || body) });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
}
