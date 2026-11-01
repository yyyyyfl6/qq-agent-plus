// 已保存密钥的「显示 / 隐藏」：设置页里所有"填过就看不见"的 Key / 令牌共用一套。
//
// 为什么单独一个模块：/api/config 下发的配置里密钥字段是**删掉**的（按字段名命中
// src/core/secret-keys.js 的 SECRET_KEY_PATTERN），所以明文只能向各自的受守卫端点回读，
// 每加一处密钥就要接一条端点 + 一个开关。这套逻辑原来长在 ui/pages/settings-bind.js 里，
// 该文件已顶到 max-lines 上限（1800），所以拆到这里。
//
// 与"正在输入"的密码框（登录令牌、SnowLuma 改密、新增搜索服务的 Key）不同：
// 那些没有已保存的值，用 ui/core/dom-util.js 的 bindPeekToggle（纯本地切 type）。
import { api } from '../core/api.js';
import { ASR_SERVICES } from '../core/constants.js';
import { $ } from '../core/dom.js';
import { asrSlotOf, hostOfUrl } from '../core/format.js';
import { state } from '../core/state.js';

// 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
// 所以「显示」必须向后端专用端点要明文，不能直接读 state.config）
const SEARCH_KEY_FIELDS = {
  'cfg-ds-searchkey': 'deepseek',
  'cfg-zhipu-key': 'zhipu',
  'cfg-bocha-key': 'bocha',
  'cfg-baidu-key': 'baidu',
  'cfg-metaso-key': 'metaso',
  'cfg-doubao-key': 'doubao',
  'cfg-tavily-key': 'tavily',
  'cfg-google-key': 'google'
};

/**
 * 前端点「显示」时向后端要真实 Key。
 * 说明：这些端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
 */
async function fetchRealKey(inputId) {
  if (inputId === 'cfg-apikey') {
    const pid = state.config?.api?.provider;
    if (pid) {
      const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
      return String(r.apiKey || '');
    }
    const r = await api('/api/api-key');
    return String(r.apiKey || '');
  }
  if (inputId === 'cfg-asr-key' || inputId === 'cfg-asr-secretid' || inputId === 'cfg-asr-secretkey') {
    const field = { 'cfg-asr-key': 'apiKey', 'cfg-asr-secretid': 'secretId', 'cfg-asr-secretkey': 'secretKey' }[inputId];
    // 带上表单**当前选中**的槽位（与切换预设时的掩码同源）：刚切换、还没保存时，
    // 服务端按已保存配置解析会把上一家的明文显示在新服务名下（2026-10-02 全量审查）。
    const item = ASR_SERVICES.find((x) => x.id === String($('#cfg-asr-service')?.value || ''));
    const slot = item ? asrSlotOf(item.provider, $('#cfg-asr-baseurl')?.value || '') : '';
    const r = await api(`/api/asr-key?field=${encodeURIComponent(field)}${slot ? `&slot=${encodeURIComponent(slot)}` : ''}`);
    return String(r.apiKey || '');
  }
  if (inputId === 'cfg-obtoken' || inputId === 'cfg-obhttptoken') {
    const field = inputId === 'cfg-obtoken' ? 'ws' : 'http';
    const r = await api(`/api/onebot-key?field=${encodeURIComponent(field)}`);
    return String(r.token || '');
  }
  if (inputId === 'cfg-img-key') {
    // 同款：把表单里当前填的地址主机带上（空 = 跟随聊天模型，服务端按"当前这家"回显）
    const host = hostOfUrl($('#cfg-img-baseurl')?.value || '');
    const r = await api(`/api/imagegen/key${host ? `?host=${encodeURIComponent(host)}` : ''}`);
    return String(r.apiKey || '');
  }
  if (inputId === 'cfg-tts-key') {
    // 语音合成的 Key 按服务分家（火山/豆包/MiniMax 各一把），所以要把当前选中的那家带上
    const service = String($('#cfg-tts-service')?.value || '').trim();
    const r = await api(`/api/tts/key?service=${encodeURIComponent(service)}`);
    return String(r.apiKey || '');
  }
  const field = SEARCH_KEY_FIELDS[inputId];
  if (field) {
    const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
    return String(r.apiKey || '');
  }
  return '';
}

/**
 * 把设置页里所有密钥输入框的「显示 / 隐藏」接上（幂等：同一个按钮只接一次）。
 *
 * hideTo：隐藏时输入框该回到什么值。默认 '******'（服务端把"掩码"当"保持不变"）；
 *   **OneBot 令牌例外**：那两个字段的"保持不变"是**空串**，服务端不认 '******'
 *   （真存进去会把令牌改成字面量 ******，见 ui/pages/settings-save.js 的同款兜底），
 *   所以 hideTo 给空串。
 * note：取不到明文时把原因写进这个提示元素（例如"这一家还没存过 Key"）。
 *   **不配也有提示位**：没配 note 的开关会在它所在的字段块里现挂一个 `.key-toggle-note`
 *   （见 resolveNoteEl）。原先只有 TTS 配了 note，其余 14 个取明文失败时点一下毫无反应 ——
 *   2026-10-01 第六轮审查。
 * 不读 input.type 判断当前状态（见下），也不在隐藏时再向端点要一次明文。
 */
const KEY_TOGGLES = [
  { btn: 'cfg-apikey-toggle', input: 'cfg-apikey' },
  { btn: 'cfg-ds-searchkey-toggle', input: 'cfg-ds-searchkey' },
  { btn: 'cfg-zhipu-key-toggle', input: 'cfg-zhipu-key' },
  { btn: 'cfg-bocha-key-toggle', input: 'cfg-bocha-key' },
  { btn: 'cfg-baidu-key-toggle', input: 'cfg-baidu-key' },
  { btn: 'cfg-metaso-key-toggle', input: 'cfg-metaso-key' },
  { btn: 'cfg-doubao-key-toggle', input: 'cfg-doubao-key' },
  { btn: 'cfg-tavily-key-toggle', input: 'cfg-tavily-key' },
  { btn: 'cfg-google-key-toggle', input: 'cfg-google-key' },
  { btn: 'cfg-asr-key-toggle', input: 'cfg-asr-key' },
  { btn: 'cfg-asr-secretid-toggle', input: 'cfg-asr-secretid' },
  { btn: 'cfg-asr-secretkey-toggle', input: 'cfg-asr-secretkey' },
  { btn: 'cfg-obtoken-toggle', input: 'cfg-obtoken', hideTo: '' },
  { btn: 'cfg-obhttptoken-toggle', input: 'cfg-obhttptoken', hideTo: '' },
  { btn: 'cfg-img-reveal-key-btn', input: 'cfg-img-key' },
  // 语音合成原先自带一对「显示 / 隐藏」按钮（settings-voice.js 里的旧实现），
  // 2026-10-01 并入这里：那对按钮的"隐藏"会把用户刚粘进去的新 Key 盖成 ******，
  // 而 ****** 在服务端是"保持不变"—— 等于静默丢弃他刚输入的值。
  { btn: 'tts-reveal-key-btn', input: 'cfg-tts-key', note: 'tts-key-hint' }
];

function bindKeyToggles() {
  for (const entry of KEY_TOGGLES) {
    const btn = $(`#${entry.btn}`);
    // 设置页每次重渲染都会给新元素重新调用本函数；同一个按钮上若已接过就跳过
    // （标记落在按钮上，重渲染后按钮是新的、标记自然消失）。
    if (!btn || btn.dataset.keyToggleBound === '1') continue;
    btn.dataset.keyToggleBound = '1';
    // 监听器本身是 async 并 await 处理函数：渲染测试要 await 这个返回值才看得到结果
    // （写成"发出去不管"的话，用例会读到还没写完的 DOM，表现为"点了没反应"）。
    btn.addEventListener('click', async () => {
      await handleKeyToggle(entry).catch(() => { /* 取不到就维持原样 */ });
    });
  }
}

/**
 * 点一下按钮：在**点击时**重新取 DOM 节点，而不是绑定时捕获 —— 设置页会整段重渲染
 * （切换分区、保存后刷新），绑定时捕获到的可能已经是脱离文档的旧节点，表现为
 * "点了没反应 / 字段没变"（2026-10-01 实测：渲染用例里就是这样红的）。
 */
/**
 * 「显示」取回的明文按输入框缓存：隐藏时要拿它比对"用户是不是改过"，
 * 有缓存就不必再向受守卫端点要一次 —— 每次回读都是一次"把明文密钥投到前端"的动作。
 */
const revealedValues = new Map();
/** 「显示」之前框里是什么（掩码、空串、或用户已经输了一半的新 Key）：隐藏时还原它。 */
const preShowValues = new Map();

/**
 * 提示位：配了 note 就用模板里的元素；没配的当场挂一个。
 *
 * 为什么不在模板里给 15 个开关各补一个 `<div class="hint" id="…">`：模板散在五个页面，
 * 补 id 只是把"以后新加密钥又忘了配提示"的老问题复制一遍；现挂天然覆盖所有开关，
 * 且随模板重渲染一起重建（同一个字段块里只留一个，用类名去重）。
 * 字段块取 `.field`；没有 `.field` 的布局退回输入框的直接父节点（提示会贴着那一行显示）。
 * 渲染测试的 DOM 垫片没有真正的父子关系（closest 恒 null）：退化到按 id 取，
 * 垫片对同一 selector 返回同一个元素，写入照样能被断言。
 */
function resolveNoteEl(inputId, configuredId) {
  if (configuredId) {
    const byId = $(`#${configuredId}`);
    if (byId) return byId;
  }
  const input = $(`#${inputId}`);
  const host = input?.closest?.('.field') || input?.parentElement || null;
  if (host && typeof document.createElement === 'function' && typeof host.appendChild === 'function') {
    const existing = typeof host.querySelector === 'function' ? host.querySelector('.key-toggle-note') : null;
    if (existing) return existing;
    const slot = document.createElement('div');
    slot.className = 'hint key-toggle-note';
    host.appendChild(slot);
    return slot;
  }
  return $(`#${inputId}-note`);
}

async function handleKeyToggle({ btn: btnId, input: inputId, hideTo = '******', note = '' }) {
  const input = $(`#${inputId}`);
  const btn = $(`#${btnId}`);
  if (!input || !btn) return;
  const noteEl = resolveNoteEl(inputId, note);
  // 显示/隐藏的判据用按钮上的标记，**不读 input.type** —— 渲染测试用的 DOM 垫片
  // （test/render-test.mjs）不把 type="password" 属性映射成 .type 属性，读它永远得到
  // undefined，于是"显示"会走进隐藏分支（2026-10-01 实测踩到）。标记落在按钮上，
  // 设置页重渲染后按钮是新的、标记自然清零。
  const show = btn.dataset.revealed !== '1';
  if (show) {
    const before = input.value || '';
    const known = revealedValues.get(inputId) ?? '';
    // 用户在这个框里输了一半（既不是空、也不是掩码、也不是上次显示出来的那串明文）时，
    // 只切明文让他看清自己输的，**不要**用服务端回读的值盖掉 —— 那是未保存的用户输入。
    const typedByUser = Boolean(before) && before !== '******' && before !== known;
    if (typedByUser) {
      preShowValues.set(inputId, before);
      input.type = 'text';
      btn.textContent = '隐藏';
      btn.dataset.revealed = '1';
      return;
    }
    // 先把明文取回来**再**翻按钮状态（2026-10-01 审查）：原来是先翻再 await，端点 401 /
    // 网络失败时按钮已经写着「隐藏」、框里却还是掩码，用户会以为"显示成功了但没值"，
    // 再点一下走的是隐藏分支、更莫名其妙。取不到就什么都不动，只把原因写进提示。
    let real;
    try {
      real = await fetchRealKey(inputId);
    } catch (error) {
      if (noteEl) noteEl.textContent = `读取失败：${String(error?.message || error)}`;
      return;
    }
    preShowValues.set(inputId, before);
    revealedValues.set(inputId, real);
    input.value = real;
    input.type = 'text';
    btn.textContent = '隐藏';
    btn.dataset.revealed = '1';
    if (noteEl) noteEl.textContent = real ? '' : '这一家还没有保存过 Key';
    return;
  }
  // 切回密码态
  const current = input.value || '';
  const real = revealedValues.get(inputId) ?? '';
  const before = preShowValues.get(inputId) ?? '';
  revealedValues.delete(inputId);
  preShowValues.delete(inputId);
  input.type = 'password';
  if (current !== real) {
    // 显示期间内容被改过（用户粘了新 Key，或本来就是他自己输的）→ 原样保留。
    // 这里**不能**无脑写 hideTo：掩码在服务端是"保持不变"，盖下去等于把刚输入的新 Key
    // 静默丢弃（旧实现就是这么干的，2026-10-01 审查）。
    input.value = current;
  } else if (real) {
    input.value = hideTo;     // 没改过、确实取回过明文 → 掩码（OneBot 是空串）
  } else {
    input.value = before;     // 什么都没取回 → 还原显示前的样子
  }
  btn.textContent = '显示';
  btn.dataset.revealed = '0';
}

export { bindKeyToggles, fetchRealKey };
