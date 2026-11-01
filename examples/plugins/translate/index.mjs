// 官方插件：翻译（走 MyMemory 公开接口，不需要 Key）。
//
// 群里另一类天天出现的问题："这句英文什么意思""帮我翻成日语"。这个插件把它变成一个工具：
// 模型把原文与目标语言丢进来，拿回一句已经整理好的译文。
//
// 为什么选 MyMemory：**不需要 Key**（DeepL/百度/腾讯那几家都要，而"要 Key"对刚上手的人
// 是一道坎）、支持中英日韩这几个群里最常见的语言对、且是只读查询。
//
// 配置（可选）：plugins.settings.translate.defaultTo，模型没给 to 时用哪个目标语言，默认 zh-CN。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const ENDPOINT = 'https://api.mymemory.translated.net/get';
// 一次能翻多少：MyMemory 的 q 参数上限是 **500 字节**（官方 403 文案：MAX ALLOWED QUERY : 500
// CHARS，2026-10-17 实测 600 个 ASCII 字符就 403）。按 UTF-8 字节算 —— 中文一个字 3 字节，
// 所以「500 字」对中文其实是 166 字左右。本地先拦一道，免得拿一段字去打上游再收到英文报错。
//（原值写的是 1000「字」且按字符长度判断，500–1000 之间会漏到上游。）
const MAX_BYTES = 500;
const byteLength = (text) => Buffer.byteLength(String(text), 'utf8');

let settings = {};
let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力（这里是 cap.http.request）：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

/**
 * 把用户写的语言名/代码归一成 MyMemory 认的码。
 * 认不出来的“像语言码”的输入原样放行（MyMemory 支持的语言远不止这四种，写死白名单会挡掉合法用法）；
 * 完全不像语言码的（中文乱写、空串）返回 null，由调用方报错 —— 不拿坏参数去打上游。
 */
const LANG_ALIASES = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-CN', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-CN',
  cn: 'zh-CN', chinese: 'zh-CN', 中文: 'zh-CN', 汉语: 'zh-CN', 简体: 'zh-CN', 简体中文: 'zh-CN',
  en: 'en', 'en-us': 'en', 'en-gb': 'en', english: 'en', 英文: 'en', 英语: 'en',
  ja: 'ja', 'ja-jp': 'ja', jp: 'ja', japanese: 'ja', 日文: 'ja', 日语: 'ja',
  ko: 'ko', 'ko-kr': 'ko', kr: 'ko', korean: 'ko', 韩文: 'ko', 韩语: 'ko'
};

function normalizeLang(input) {
  const key = String(input ?? '').trim().toLowerCase();
  if (!key) return null;
  if (LANG_ALIASES[key]) return LANG_ALIASES[key];
  // 形如 xx 或 xx-YY 的语言码原样交给上游（MyMemory 的语言码很宽）
  return /^[a-z]{2}(?:-[a-z]{2,4})?$/.test(key) ? key : null;
}

/**
 * 没给 from 时按原文猜源语言。
 * 顺序有讲究：日语正文里也有汉字，所以先看假名再判汉字，否则日语会被误判成中文。
 */
function guessSource(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';      // 平假名/片假名
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';      // 谚文
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';   // 汉字
  return 'en';
}

const tools = {
  async text(args) {
    // 校验全部放在发请求之前：坏参数本地就报掉，不去打上游（省一次失败的网络往返）
    const raw = String(args?.text ?? '').trim();
    if (!raw) return { error: '要给我要翻译的文本（text 不能为空）' };
    // 上游按**字节**限长：中文一个字 3 字节，用字符数判断会放过超长请求
    if (byteLength(raw) > MAX_BYTES) {
      return { error: `一次最多翻 ${MAX_BYTES} 字节（约 ${Math.floor(MAX_BYTES / 3)} 个汉字或 ${MAX_BYTES} 个英文/数字），这段有 ${byteLength(raw)} 字节 —— 请分成几段再翻` };
    }

    // to 的优先级：调用参数 → 插件配置 → 默认 zh-CN。空串当"没给"处理。
    const toInput = String(args?.to ?? '').trim() || String(settings.defaultTo ?? '').trim();
    const to = toInput ? normalizeLang(toInput) : 'zh-CN';
    if (!to) return { error: `看不懂目标语言「${toInput}」（试试 zh-CN / en / ja / ko，或写“日语”“韩语”）` };

    const fromInput = String(args?.from ?? '').trim();
    const from = fromInput ? normalizeLang(fromInput) : guessSource(raw);
    if (!from) return { error: `看不懂源语言「${fromInput}」（试试 zh-CN / en / ja / ko）` };
    if (from === to) return { error: `源语言和目标语言都是 ${to} —— 请换一个目标语言（to）` };

    const url = `${ENDPOINT}?q=${encodeURIComponent(raw)}&langpair=${encodeURIComponent(`${from}|${to}`)}`;
    const result = await callHost('cap.http.request', { url, method: 'GET' });
    const status = Number(result?.status) || 0;
    if (status !== 200) return { error: `翻译服务返回 HTTP ${status || '?'}（稍后再试）` };

    let payload = null;
    try { payload = JSON.parse(String(result?.body ?? '')); }
    catch { return { error: '翻译服务返回的不是 JSON' }; }

    const translated = String(payload?.responseData?.translatedText ?? '').trim();
    // MyMemory 的坑：额度用尽/语言对非法时它**照样回 HTTP 200**，把原因写在 responseStatus
    // 与 responseDetails 里 —— 只看 HTTP 状态码会把错误文案当成译文发给群里。
    const upstreamStatus = Number(payload?.responseStatus) || 0;
    if (!translated || upstreamStatus >= 400) {
      const detail = String(payload?.responseDetails ?? '').trim();
      return { error: detail ? `翻译服务说：${detail}` : '翻译服务没有返回译文（换个语言对或稍后再试）' };
    }

    // 另一个坑（实测撞到）：它有时把原文**原样**返回（responseStatus 仍是 200、details 为空）。
    // 直接当成译文会把"没翻"讲成"翻完了"，所以这里显式标出来，让模型知道这句要留个心眼。
    const normalized = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const answer = {
      text: raw,
      translated,
      from,
      to,
      note: '数据来自 MyMemory 公开接口（不需要 Key，匿名有每日额度）。'
    };
    if (normalized(translated) === normalized(raw)) {
      answer.warning = '上游这次把原文原样返回了（没给出译文）—— 可能是这个语言对没被支持、或本次没匹配到翻译记忆，请勿当成翻译结果使用。';
    }
    return answer;
  }
};

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message?.method === 'callTool') {
        const fn = tools[message.params?.name];
        if (!fn) send({ id: message.id, error: { code: 'E_NO_TOOL', message: `没有这个工具：${message.params?.name}` } });
        else {
          Promise.resolve()
            .then(() => fn(message.params?.args ?? {}))
            .then((result) => send({ id: message.id, result }))
            .catch((error) => send({ id: message.id, error: { code: 'E_TOOL', message: String(error?.message || error) } }));
        }
      } else if (message?.method === 'init') {
        settings = message.params?.settings && typeof message.params.settings === 'object' ? message.params.settings : {};
        send({ id: message.id, result: { ok: true } });
      } else if (message?.method === 'ping') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'schedule') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'shutdown') {
        send({ id: message.id, result: {} });
        setTimeout(() => process.exit(0), 10);
      } else if (message?.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});
