// 官方插件：汇率（Frankfurter 为主，open.er-api 兜底；两个都不需要 Key）。
//
// 群里问"100 美元是多少人民币"的频率极高，而这类问题最烦的是：同一个问题，模型随口编一个
// 汇率（数字看着像真的，但没人知道是哪天的）。这个插件把答案钉在一个可核对的公开源上，
// 并把**取数日期**一起返回 —— 群友至少知道这个数是什么时候的。
//
// 为什么是两家：Frankfurter 走欧洲央行数据、稳定但币种少（没有 TWD 这类）；open.er-api 币种全
// 但偶尔抽风。于是主用人家的、失败换兜底，并在结果里注明实际用了哪家。
//
// 配置（可选）：
//   plugins.settings.exchange-rate.frankfurterUrl —— 覆盖主接口根（默认 api.frankfurter.dev/v1）
//   plugins.settings.exchange-rate.erApiUrl        —— 覆盖兜底接口根（默认 open.er-api.com/v6/latest）
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const FRANKFURTER = 'https://api.frankfurter.dev/v1';
const ER_API = 'https://open.er-api.com/v6/latest';
const CODE_RE = /^[A-Za-z]{3}$/;

let settings = {};
let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力（这里是 cap.http.request）：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

async function getJson(url) {
  const result = await callHost('cap.http.request', { url, method: 'GET' });
  const status = Number(result?.status) || 0;
  if (status !== 200) return { error: `上游返回 HTTP ${status || '?'}（${url}）` };
  try { return { data: JSON.parse(String(result?.body ?? '')) }; }
  catch { return { error: '上游返回的不是 JSON' }; }
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 主源：Frankfurter（base=from, symbols=to）。返回 rate 或 { unsupported:true } / { error }。 */
async function fromFrankfurter(from, to) {
  const base = String(settings.frankfurterUrl || FRANKFURTER).replace(/\/+$/, '');
  const found = await getJson(`${base}/latest?base=${from}&symbols=${to}`);
  if (found.error) return { error: found.error };
  const rate = Number(found.data?.rates?.[to]);
  // 币种不在欧洲央行那套里时它不报错，只是 rates 里没有目标币 —— 当成"这家不支持"，交给兜底
  if (!Number.isFinite(rate) || rate <= 0) return { unsupported: true };
  return { rate, date: String(found.data?.date || ''), provider: 'Frankfurter（欧洲央行数据）' };
}

/** 兜底源：open.er-api（base 在路径里，rates 是全量表）。 */
async function fromErApi(from, to) {
  const base = String(settings.erApiUrl || ER_API).replace(/\/+$/, '');
  const found = await getJson(`${base}/${from}`);
  if (found.error) return { error: found.error };
  if (String(found.data?.result || '') !== 'success') {
    return { error: `兜底汇率源说：${String(found.data?.['error-type'] || '换算失败')}` };
  }
  const rate = Number(found.data?.rates?.[to]);
  if (!Number.isFinite(rate) || rate <= 0) return { unsupported: true };
  // 它给的是 Unix 秒，转成日期才方便告诉群友"这是哪天的"
  const stamp = Number(found.data?.time_last_update_unix);
  const date = Number.isFinite(stamp) ? new Date(stamp * 1000).toISOString().slice(0, 10) : '';
  return { rate, date, provider: 'open.er-api（ExchangeRate-API 公开层）' };
}

const tools = {
  async convert(args) {
    // 校验全部放在发请求之前：缺参数/坏货币码本地就报掉，不拿垃圾去打上游
    const amount = Number(args?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: `amount 要是一个正数，收到的是「${args?.amount}」` };
    }
    const from = String(args?.from ?? '').trim().toUpperCase();
    const to = String(args?.to ?? '').trim().toUpperCase();
    if (!CODE_RE.test(from)) return { error: `from 要是三字母货币代码（例如 USD），收到的是「${args?.from}」` };
    if (!CODE_RE.test(to)) return { error: `to 要是三字母货币代码（例如 CNY），收到的是「${args?.to}」` };

    // 同币种不必问上游（有些源对 base=symbols 会直接报错），本地给一个诚实的恒等结果
    if (from === to) {
      return { amount, from, to, rate: 1, result: round(amount, 4), date: '', provider: '同币种，未取汇率',
        note: '同币种不需要换算；汇率仅供参考，实际成交价以银行/平台为准。' };
    }

    // ⚠️ 主源**抛异常**（DNS 失败、超时、被宿主的网络守卫拦）也要走兜底：
    // 原来的写法只处理"返回了 {error}"，而最常见的"主源挂了"是 reject —— 那会让兜底永远跑不到。
    const attempt = async (fn) => {
      try { return await fn(from, to); } catch (error) { return { error: String(error?.message || error || '请求失败') }; }
    };
    let quote = await attempt(fromFrankfurter);
    let primaryError = quote.error || '';
    if (quote.unsupported || quote.error) {
      const fallback = await attempt(fromErApi);
      // 兜底也明说不行时：把**两家**的原因都带出来，而不是只留兜底那一句
      if (fallback.unsupported) {
        return {
          error: `${from} 与 ${to} 之间没有可用汇率（可能是币种代码写错，或该币种不在公开汇率表里）`
            + (primaryError ? `｜主源：${primaryError}` : '')
        };
      }
      if (fallback.error) {
        return { error: `两家汇率源都取不到：${primaryError ? `主源 ${primaryError}；` : ''}兜底 ${fallback.error}` };
      }
      quote = fallback;
    }

    return {
      amount,
      from,
      to,
      rate: round(quote.rate, 6),
      result: round(amount * quote.rate, 4),
      date: quote.date,
      provider: quote.provider,
      note: quote.date ? `汇率取自 ${quote.date}，仅供参考；实际成交价以银行/平台为准。` : '汇率仅供参考；实际成交价以银行/平台为准。'
    };
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
