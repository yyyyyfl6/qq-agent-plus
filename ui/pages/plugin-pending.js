// 插件待批的全局入口：侧栏徽标 + 插件页顶部汇总条。
// 从 plugins.js 拆出来，避免那个文件突破 1800 行；只依赖 api/dom，不反向 import 插件页。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';

const JUMP_KEY = 'qa-plugin-pending-jump';
let bannerStatus = '';

/** 全局待批红点：侧栏「插件」按钮上的未批请求计数（跨插件汇总，审批是全局状态）。 */
async function refreshPendingBadge() {
  try {
    const data = await api('/api/plugins/pending-count');
    const n = Number(data?.count) || 0;
    document.querySelectorAll('[data-pending-badge]').forEach((node) => {
      node.textContent = n > 99 ? '99+' : String(n);
      node.style.display = n > 0 ? '' : 'none';
      node.setAttribute('aria-label', n > 0 ? `有 ${n} 条插件待批` : '没有插件待批');
      node.setAttribute('title', n > 0 ? `${n} 条插件待批，点击查看` : '');
    });
  } catch { /* 计数失败不影响页面 */ }
}

/** B 站写操作的目标（BV/av 号）变成可点击链接；其它目标原样显示。 */
function pendingTargetHref(target) {
  const t = String(target || '').trim();
  if (/^BV[0-9A-Za-z]{5,}$/.test(t)) return `https://www.bilibili.com/video/${t}`;
  if (/^av\d+$/i.test(t)) return `https://www.bilibili.com/video/${t.toLowerCase()}`;
  return '';
}

async function decidePending(pluginId, pendingId, decision) {
  try {
    const result = await api('/api/plugins/approval', {
      method: 'POST',
      body: JSON.stringify({ id: pluginId, pendingId, decision })
    });
    if (decision === 'reject') {
      bannerStatus = '已拒绝';
    } else if (result?.retry) {
      bannerStatus = result.retry.ok
        ? `已批准并执行：${String(result.retry.message || '成功')}`
        : `已批准；自动重试失败：${String(result.retry.message || '未知原因')}`;
    } else {
      bannerStatus = '已批准一次';
    }
    return true;
  } catch (error) {
    bannerStatus = `${decision === 'approve' ? '批准' : '拒绝'}失败：${String(error?.message || error)}`;
    return false;
  }
}

function bindBannerActions(box, list) {
  box.onclick = async (event) => {
    const approve = event.target?.closest?.('[data-pending-approve]');
    const reject = event.target?.closest?.('[data-pending-reject]');
    const all = event.target?.closest?.('[data-pending-reject-all]');
    if (!approve && !reject && !all) return;   // 其余点击交给 plugins.js 的 data-plugin-open
    event.preventDefault();
    event.stopPropagation();
    if (all) {
      if (!await askForConfirmation(`拒绝全部 ${list.length} 条待批请求？`)) return;
      for (const item of list) await decidePending(item.pluginId, item.id, 'reject');
    } else if (approve) {
      await decidePending(approve.dataset.pendingPlugin || '', approve.dataset.pendingApprove || '', 'approve');
    } else {
      await decidePending(reject.dataset.pendingPlugin || '', reject.dataset.pendingReject || '', 'reject');
    }
    await refreshPendingBadge();
    await loadPendingBanner();
  };
}

/** 插件页顶部的全量待批条；返回列表供调用方复用（失败返回空数组，不影响页面）。 */
async function loadPendingBanner() {
  const box = $('#plugins-pending-banner');
  if (!box) return [];
  try {
    const data = await api('/api/plugins/pending');
    const list = Array.isArray(data?.pending) ? data.pending : [];
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = '';
      return [];
    }
    const now = Date.now();
    const rows = list.slice(0, 20).map((item) => {
      const mins = Math.max(1, Math.round((Number(item.expiresAt) - now) / 60000));
      const warn = item.notify?.ok === false ? '<i class="ppb-warn">通知未送达</i>' : '';
      return `<div class="ppb-row">
        <button type="button" class="ppb-open" data-plugin-open="${esc(item.pluginId)}" data-pending-jump="1">
          <strong>${esc(item.pluginName)}</strong>
          <span>${esc(item.label)}${item.target ? ` → ${esc(item.target)}` : ''}</span>
          <em>剩 ${mins} 分</em>${warn}
        </button>
        <button type="button" class="ppb-act" data-pending-approve="${esc(item.id)}" data-pending-plugin="${esc(item.pluginId)}">批准</button>
        <button type="button" class="ppb-act" data-pending-reject="${esc(item.id)}" data-pending-plugin="${esc(item.pluginId)}">拒绝</button>
      </div>`;
    }).join('');
    box.hidden = false;
    box.innerHTML = `<div class="ppb-head"><b>${list.length} 条待批</b>
      <span>可直接批准/拒绝；点条目进入插件详情</span>
      ${list.length > 1 ? '<button type="button" class="ppb-act ppb-act-danger" data-pending-reject-all="1">全部拒绝</button>' : ''}</div>
      <div class="ppb-rows">${rows}</div>
      ${list.length > 20 ? `<div class="ppb-more">还有 ${list.length - 20} 条，进入插件页查看</div>` : ''}
      ${bannerStatus ? `<div class="ppb-status">${esc(bannerStatus)}</div>` : ''}`;
    bindBannerActions(box, list);
    // 从侧栏徽标点进来：自动打开第一条待批所在插件（click 由 plugins.js 的委托处理）
    let jump = false;
    try {
      jump = sessionStorage.getItem(JUMP_KEY) === '1';
      sessionStorage.removeItem(JUMP_KEY);
    } catch { /* 隐私模式禁 storage：只少一次自动跳转 */ }
    if (jump) document.querySelector('[data-pending-jump]')?.click();
    return list;
  } catch {
    box.hidden = true;
    return [];
  }
}

export { refreshPendingBadge, loadPendingBanner, pendingTargetHref };
