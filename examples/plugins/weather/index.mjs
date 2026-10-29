// 官方插件：天气（走 Open-Meteo，公开接口、不需要 Key）。
//
// 群里另一类高频问题："明天冷不冷""周末会不会下雨"。这个插件取当前天气与未来三天的
// 最高/最低温与降水概率，整理成模型能直接讲给人听的几行。
//
// 为什么选它：不需要 Key（很多天气 API 都要，而"要 Key"对小白用户是一道坎）、
// 只读、且顺手演示了 **config 能力**（默认城市写在自己那段配置里，插件读得到、改不了别人的）。
//
// 配置（可选）：plugins.settings.weather.defaultCity，默认 Beijing。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
let settings = {};
let requestSeq = 0;
const pending = new Map();

const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

async function getJson(url) {
  const result = await callHost('cap.http.request', { url, method: 'GET' });
  const status = Number(result?.status) || 0;
  if (status !== 200) return { error: `天气服务返回 HTTP ${status || '?'}` };
  try { return { data: JSON.parse(String(result?.body ?? '')) }; } catch { return { error: '天气服务返回的不是 JSON' }; }
}

const CJK_RE = /[㐀-鿿]/;

/**
 * 城市名 → 经纬度。
 * ⚠️ Open-Meteo 的地理编码**只有中国城市的常用中文名**：`东京` 会匹配到江苏的一个村子、
 * `纽约`/`首尔` 直接没有结果（2026-10-17 实测）。所以中文查询一律随结果带一句提醒，
 * 让模型自己去核对省/国家 —— 否则它会拿"东京 江苏 中国"的天气当成东京讲给群里。
 */
async function locate(city) {
  const cjk = CJK_RE.test(city);
  const found = await getJson(`${GEO}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
  if (found.error) return found;
  const hit = Array.isArray(found.data?.results) ? found.data.results[0] : null;
  if (!hit) {
    return {
      error: cjk
        ? `查不到城市「${city}」。中文名只对中国城市可靠 —— 境外城市请改用英文名（例如 Tokyo / New York / Seoul）再试`
        : `查不到城市「${city}」的坐标（换个写法试试）`
    };
  }
  return {
    place: { name: hit.name || city, country: hit.country || '', admin: hit.admin1 || '', lat: hit.latitude, lon: hit.longitude },
    cjk
  };
}

const WEATHER_TEXT = {
  0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨（弱）', 53: '毛毛雨', 55: '毛毛雨（强）',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨（弱）', 67: '冻雨（强）',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨（弱）', 81: '阵雨', 82: '阵雨（强）', 85: '阵雪（弱）', 86: '阵雪（强）',
  95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴冰雹'
};

const tools = {
  async current(args) {
    const city = String(args?.city || settings.defaultCity || 'Beijing').trim();
    const located = await locate(city);
    if (located.error) return { error: located.error };
    const { place, cjk } = located;
    const url = `${FORECAST}?latitude=${place.lat}&longitude=${place.lon}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=4';
    const forecast = await getJson(url);
    if (forecast.error) return forecast;
    const data = forecast.data || {};
    const current = data.current || {};
    const daily = data.daily || {};
    const days = Array.isArray(daily.time) ? daily.time.map((date, i) => ({
      date,
      text: WEATHER_TEXT[daily.weather_code?.[i]] || `天气代码 ${daily.weather_code?.[i] ?? '?'}`,
      max: daily.temperature_2m_max?.[i] ?? null,
      min: daily.temperature_2m_min?.[i] ?? null,
      rainChance: daily.precipitation_probability_max?.[i] ?? null
    })) : [];
    return {
      place: `${place.name}${place.admin ? ` ${place.admin}` : ''}${place.country ? ` ${place.country}` : ''}`,
      now: {
        temp: current.temperature_2m ?? null,
        feelsLike: current.apparent_temperature ?? null,
        text: WEATHER_TEXT[current.weather_code] || `天气代码 ${current.weather_code ?? '?'}`,
        humidity: current.relative_humidity_2m ?? null,
        wind: current.wind_speed_10m ?? null,
        precipitation: current.precipitation ?? null
      },
      // 从**明天**起取三天：`now` 已经给了今天的实况，而用户问「明天冷不冷」时不该先塞一条今天的。
      // 请求里 forecast_days=4，所以下标 1..3 一定是拿得到的。
      // 今天这一条单独给：`days` 是"明天起"，而「今天要带伞吗」问的是今天剩下的时间
      today: days[0] || null,
      days: days.slice(1, 4),
      note: '数据来自 Open-Meteo（公开接口，不需要 Key）；时间按该城市所在时区。'
        + (cjk ? ' 中文城市名由 Open-Meteo 匹配：它只对中国城市可靠，请核对结果里的省/国家；境外城市请改用英文名（如 Tokyo）。' : '')
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
