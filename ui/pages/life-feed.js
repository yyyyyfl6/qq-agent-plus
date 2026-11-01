// 设置 → 见闻（生活层）：开关、觅食参数、候选队列与手动操作。
// 渲染函数由 settings.js 的分区表调用；按钮走事件委托，状态单独拉 /api/life-feed/status。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';
import { renderGroupChecklist } from './moments.js';

// render-test 的 vm 沙箱没有 queueMicrotask（浏览器与 happy-dom 有）：统一走这条兜底。
const defer = (fn) => (typeof queueMicrotask === 'function' ? queueMicrotask(fn) : Promise.resolve().then(fn));

function fmtTime(value) {
  const ts = Number(value) || 0;
  return ts > 0 ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function fmtDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const min = Math.floor(total / 60);
  return min > 0 ? `${min} 分钟` : `${total} 秒`;
}

function fmtPlay(count) {
  const value = Number(count) || 0;
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return String(value);
}

function setResult(text, error = false) {
  const node = $('#lifefeed-action-result');
  if (!node) return;
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #c0392b)' : '';
}

async function loadStatus() {
  const box = $('#lifefeed-status');
  if (!box) return;
  try {
    const data = await api('/api/life-feed/status');
    const limits = data?.limits || {};
    for (const [selector, key] of [
      ['#cfg-lifefeed-interval', 'forageIntervalMinutes'],
      ['#cfg-lifefeed-offers', 'maxOffersPerDay'],
      ['#cfg-lifefeed-max-per-forage', 'maxPerForage'],
      ['#cfg-lifefeed-max-candidates', 'maxCandidates'],
      ['#cfg-lifefeed-min-duration', 'minDurationSec'],
      ['#cfg-lifefeed-max-duration', 'maxDurationSec']
    ]) {
      const node = $(selector);
      const bound = limits[key];
      if (!node || !bound) continue;
      node.min = String(bound.min);
      node.max = String(bound.max);
    }
    box.textContent = data.enabled
      ? `已开启 · 候选 ${data.candidateCount} 条 · 今日自动 ${data.todayAutoOffers ?? data.todayOffers}/${data.maxOffersPerDay}`
        + `${data.todayManualOffers ? ` · 手动 ${data.todayManualOffers}` : ''}`
        + ` · 上次觅食 ${fmtTime(data.lastForageAt)} · 下次 ${fmtTime(data.nextForageAt)}`
        + (data.lastError ? ` · 上次错误：${data.lastError}` : '')
      : '未开启（保存开关后才会创建状态与定时器）';
    const list = $('#lifefeed-candidates');
    if (!list) return;
    const rows = Array.isArray(data.candidates) ? data.candidates : [];
    list.innerHTML = rows.length ? rows.map((item) => `
      <div class="asset-row" data-lifefeed-row="${esc(item.id)}">
        <div class="asset-row-main">
          <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
          <small>${esc(item.up || '未知 UP')} · 播放 ${fmtPlay(item.play)} · ${fmtDuration(item.duration)} · 分数 ${Number(item.score) || 0}${item.offeredAt ? ' · 已领取' : ''}</small>
        </div>
        <div class="asset-row-actions">
          <button type="button" class="btn btn-small" data-lifefeed-share="${esc(item.id)}">分享</button>
          <button type="button" class="btn btn-small" data-lifefeed-dismiss="${esc(item.id)}">丢弃</button>
        </div>
      </div>`).join('') : '<div class="hint">队列是空的：开启后等一次觅食，或点「立刻觅食」。</div>';
  } catch (error) {
    box.textContent = `读取失败：${error?.message || error}`;
  }
}

async function onAction(event) {
  const forage = event.target?.closest?.('#lifefeed-forage');
  const refresh = event.target?.closest?.('#lifefeed-refresh');
  const clear = event.target?.closest?.('#lifefeed-clear');
  const share = event.target?.closest?.('[data-lifefeed-share]');
  const dismiss = event.target?.closest?.('[data-lifefeed-dismiss]');

  if (refresh) {
    await loadStatus();
    return;
  }
  if (clear) {
    if (!(await askForConfirmation('清空全部候选？已分享记录、去重记录和反馈权重都会保留。'))) return;
    clear.disabled = true;
    try {
      const result = await api('/api/life-feed/clear', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setResult(`已清空 ${result.removed ?? 0} 条候选`);
      await loadStatus();
    } catch (error) {
      setResult(`清空失败：${error?.message || error}`, true);
    } finally {
      clear.disabled = false;
    }
    return;
  }
  if (forage) {
    if (!(await askForConfirmation('现在去 B 站觅食一次？会发起外部请求。'))) return;
    forage.disabled = true;
    setResult('正在觅食…');
    try {
      const result = await api('/api/life-feed/forage', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setResult(`觅食完成：新增 ${result.added ?? 0} 条，候选 ${result.candidates ?? 0} 条`, result.ok !== true);
    } catch (error) {
      setResult(`觅食失败：${error?.message || error}`, true);
    } finally {
      forage.disabled = false;
      await loadStatus();
    }
    return;
  }
  if (dismiss) {
    try {
      await api('/api/life-feed/dismiss', {
        method: 'POST', body: JSON.stringify({ bvid: dismiss.dataset.lifefeedDismiss })
      });
      setResult('已丢弃这条候选');
      await loadStatus();
    } catch (error) {
      setResult(`丢弃失败：${error?.message || error}`, true);
    }
    return;
  }
  if (share) {
    const chatKey = String($('#cfg-lifefeed-chat')?.value || '');
    if (!chatKey) {
      setResult('没有可分享的白名单群：先在「聊天白名单」里加群', true);
      return;
    }
    if (!(await askForConfirmation(`让机器人现在在 ${chatKey} 分享这条见闻？会走一次主动发言。`))) return;
    share.disabled = true;
    try {
      await api('/api/life-feed/share', {
        method: 'POST',
        body: JSON.stringify({ confirm: true, chatKey, bvid: share.dataset.lifefeedShare })
      });
      setResult('已交给主动发言链路；模型会用自己的语气说，不想说也会照常沉默');
      await loadStatus();
    } catch (error) {
      setResult(`分享失败：${error?.message || error}`, true);
    } finally {
      share.disabled = false;
    }
  }
}

function renderLifeFeedSection(c) {
  const cfg = c.lifeFeed || {};
  const selectedGroups = Array.isArray(cfg.groups) ? cfg.groups : [];
  const allowedGroups = Array.isArray(c.allow?.groups) ? c.allow.groups : [];
  const chatOptions = allowedGroups.length
    ? allowedGroups.map((id) => `<option value="group:${esc(id)}">群 ${esc(id)}</option>`).join('')
    : '<option value="">（没有白名单群）</option>';

  defer(() => {
    const root = document.getElementById('settings-lifefeed');
    if (!root) return;
    if (root.dataset.bound !== '1') {
      root.dataset.bound = '1';
      root.addEventListener('click', onAction);
    }
    void renderGroupChecklist('cfg-lifefeed-groups-box', selectedGroups);
    void loadStatus();
  });

  return `
    <div id="settings-lifefeed">
      <h3>生活层 · 见闻</h3>
      <p class="hint">机器人每隔几小时自己去 B 站看看，把候选存进队列；主动发言时可以用自己的语气分享。
        默认关闭。分享复用现有发送链路：安静时段、暂停、观察模式、白名单与限速全部生效。</p>

      <div class="field-row">
        <div class="field"><label>运行开关</label>
          <label class="checkbox-row"><input type="checkbox" id="cfg-lifefeed-enabled"${cfg.enabled === true ? ' checked' : ''} /> <span>启用生活层</span></label>
        </div>
        <div class="field"><label>觅食间隔（分钟）</label>
          <input type="number" id="cfg-lifefeed-interval" value="${esc(cfg.forageIntervalMinutes ?? 360)}" />
        </div>
        <div class="field"><label>每天最多领取/分享</label>
          <input type="number" id="cfg-lifefeed-offers" value="${esc(cfg.maxOffersPerDay ?? 2)}" />
        </div>
      </div>

      <div class="field-row">
        <div class="field"><label>单次觅食上限</label>
          <input type="number" id="cfg-lifefeed-max-per-forage" value="${esc(cfg.maxPerForage ?? 30)}" />
        </div>
        <div class="field"><label>候选队列上限</label>
          <input type="number" id="cfg-lifefeed-max-candidates" value="${esc(cfg.maxCandidates ?? 200)}" />
        </div>
        <div class="field"><label>最短时长（秒）</label>
          <input type="number" id="cfg-lifefeed-min-duration" value="${esc(cfg.minDurationSec ?? 60)}" />
        </div>
        <div class="field"><label>最长时长（秒）</label>
          <input type="number" id="cfg-lifefeed-max-duration" value="${esc(cfg.maxDurationSec ?? 3600)}" />
        </div>
      </div>

      <div class="field-row">
        <div class="field"><label>额外关键词（逗号分隔）</label>
          <input type="text" id="cfg-lifefeed-extra" value="${esc((cfg.extraKeywords || []).join(', '))}" placeholder="例如：独立游戏, 深海" />
        </div>
        <div class="field"><label>排除关键词</label>
          <input type="text" id="cfg-lifefeed-exclude" value="${esc((cfg.excludeKeywords || []).join(', '))}" placeholder="例如：广告, 营销" />
        </div>
      </div>

      <div class="field">
        <label>从哪些群提炼兴趣（不勾 = 沿用聊天白名单）</label>
        <div id="cfg-lifefeed-groups-box" class="group-checklist"><span class="muted">正在读取群列表…</span></div>
      </div>

      <div class="field-row">
        <div class="field"><label>手动分享到</label>
          <select id="cfg-lifefeed-chat">${chatOptions}</select>
        </div>
      </div>

      <div class="asset-head-actions">
        <button type="button" class="btn btn-small" id="lifefeed-forage">立刻觅食</button>
        <button type="button" class="btn btn-small" id="lifefeed-clear">清空候选</button>
        <button type="button" class="btn btn-small" id="lifefeed-refresh">刷新状态</button>
        <span class="hint" id="lifefeed-action-result"></span>
      </div>
      <div class="hint" id="lifefeed-status">正在读取…</div>
      <div id="lifefeed-candidates"></div>
    </div>`;
}

export { renderLifeFeedSection };
