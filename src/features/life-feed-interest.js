// 生活层的兴趣画像：人设 topics + 群聊近 N 天高频词。
// 刻意不调模型、不建向量库：v1 先用可解释的词频打分，队列质量靠观察再调。
import fs from 'node:fs';

const INTERESTS_FILE = new URL('../../roles/interests.json', import.meta.url);

const STOPWORDS = new Set([
  '这个', '那个', '什么', '就是', '不是', '可以', '我们', '你们', '他们', '然后', '还是',
  '一个', '没有', '现在', '今天', '明天', '真的', '感觉', '知道', '觉得', '因为', '所以',
  '但是', '如果', '已经', '时候', '一下', '这么', '那么', '自己', '东西', '有点', '应该',
  '可能', '比较', '还有', '不过', '这种', '那种', '怎么', '为什么', '哪里', '这里', '那里',
  '出来', '起来', '看到', '说的', '话说', '哈哈', '哈哈哈', 'emmm', 'the', 'and', 'for',
  'with', 'this', 'that', 'you', 'are', 'was', 'have', 'has', '但是', '而且', '或者'
]);

/** 当前人设的兴趣库（roles/interests.json）。读不到给空，不挡觅食。 */
export function loadPersonaTopics(templateId = '') {
  try {
    const raw = JSON.parse(fs.readFileSync(INTERESTS_FILE, 'utf8'));
    const hit = templateId && raw?.[templateId] ? raw[templateId] : null;
    return Array.isArray(hit?.topics) ? hit.topics.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 中文二元组 + 英文/数字词；URL 和标点先剥掉。 */
export function tokenize(text) {
  const source = String(text || '');
  const terms = [];
  for (const run of source.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const term = run.slice(i, i + 2);
      if (!STOPWORDS.has(term)) terms.push(term);
    }
  }
  const latin = source.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  for (const word of latin) {
    if (!STOPWORDS.has(word)) terms.push(word);
  }
  return terms;
}

/**
 * 结构化播报（天气/行情类的键值行）不该当成"群友兴趣"：它们会让一个词在画像里
 * 刷到几十倍权重，最后搜索词只剩「天气」。这里用两个通用信号拦一下，不做具体站点/命令匹配。
 */
export function looksLikeStructuredReport(text) {
  const source = String(text || '');
  if (!source) return false;
  if (/\bwttr\b/i.test(source)) return true;
  const compact = source.replace(/\s+/g, '');
  if (compact.length >= 20) {
    const digits = (compact.match(/[0-9]/g) || []).length;
    if (digits / compact.length >= 0.16) return true;
  }
  const fields = (source.match(/气温|体感|湿度|风速|气压|降水|日出|日落|紫外线|空气质量|AQI/gi) || []).length;
  return fields >= 3;
}

/**
 * @returns {{terms: Array<{term:string,weight:number}>, personaTopics: string[], searchTerms: string[], generatedAt: number}}
 * weight 只表示“相对更该关注”，不是概率；打分时按 6 倍放大。
 * searchTerms 只取人设 topics + 显式关键词：群聊高频词用于排序，不直接拿去搜 B 站，
 * 否则一个刷天气的群会让整个候选队列变成天气预报。
 */
export function buildInterestProfile({
  store,
  chatKeys = [],
  personaTemplateId = '',
  extraKeywords = [],
  now = Date.now(),
  days = 7,
  maxTerms = 40
} = {}) {
  const counts = new Map();
  const bump = (term, weight) => {
    const key = String(term || '').trim().toLowerCase();
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + weight);
  };

  const personaTopics = loadPersonaTopics(personaTemplateId);
  for (const topic of personaTopics) bump(topic, 3);
  for (const keyword of extraKeywords) bump(keyword, 2);

  const since = now - Math.max(1, days) * 86400000;
  for (const chatKey of chatKeys) {
    let rows = [];
    // includeSelf:false：机器人自己的播报/回复不能反过来变成"群友兴趣"的来源
    try { rows = store?.recent?.(chatKey, { limit: 800, includeSelf: false }) || []; } catch { rows = []; }
    for (const message of rows) {
      if (Number(message?.ts) < since) continue;
      if (looksLikeStructuredReport(message?.text)) continue;
      const text = String(message?.text || '').slice(0, 500);
      for (const term of tokenize(text)) bump(term, 1);
    }
  }

  const terms = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, maxTerms))
    .map(([term, weight]) => ({ term, weight }));
  const searchTerms = [...new Set([...personaTopics, ...extraKeywords]
    .map((term) => String(term || '').trim())
    .filter(Boolean))].slice(0, 6);
  return { terms, personaTopics, searchTerms, generatedAt: now };
}
