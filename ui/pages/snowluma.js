// 协议端（SnowLuma）版本面板：「设置 → OneBot」页里的「协议端（SnowLuma）」块。
//
// 为什么在这里：协议端是独立软件，它的镜像版本决定了平台能力是否完整（低于 1.14.20 时
// 动画表情在 QQ 里显示成图片）。以前升级只能 ssh 进去改 .env + docker compose up -d，
// 别人装完就停在旧版本 —— 这个面板让控制台自己把这件事做完（改 .env → pull → up -d →
// 等就绪），失败自动回滚，数据卷不动所以登录态保留。
'use strict';

import { api } from '../core/api.js';
import { esc } from '../core/dom.js';

let lastStatus = null;

function versionChip(st) {
  if (st?.container) return '<span class="chip">容器模式 · 由 compose 管理</span>';
  if (!st?.installed) return '<span class="chip">未检测到协议端 compose 项目</span>';
  if (st.outdated) return `<span class="chip warn">落后于基线 ${esc(st.targetVersion || '')}</span>`;
  if (st.belowRecommended) return `<span class="chip warn">低于推荐 ${esc(st.minRecommended || '')}</span>`;
  return '<span class="chip ok">已是最新</span>';
}

function fmtState(st) {
  if (st?.container) return '当前以 Docker 容器运行：协议端镜像由 compose 管理，请在宿主机更新 compose 后重建容器';
  if (!st?.installed) return `没找到 ${st?.composeDir || '协议端目录'}/.env（这台机器可能没装协议端）`;
  const running = st.running ? '运行中' : `状态 ${st.runningState || '未知'}`;
  return `${st.container || 'qq-agent-snowluma'} · ${running}`;
}

async function hydrateSnowlumaPanel() {
  const box = document.getElementById('snowluma-version-box');
  if (!box) return;   // 不在这一页
  const note = document.getElementById('snowluma-action-note');
  try {
    const st = await api('/api/snowluma/version');
    lastStatus = st;
    box.innerHTML = [
      `当前版本 <b>${esc(st.currentVersion || '未知')}</b>`,
      `（镜像 <code>${esc(st.currentImage || '未读到')}</code>）`,
      ` · 项目基线 <b>${esc(st.targetVersion || '')}</b>`,
      ` · ${versionChip(st)}`
    ].join('') + `<div class="hint" style="margin-top:4px">${esc(fmtState(st))}</div>`;
    const updateBtn = document.getElementById('snowluma-update-btn');
    if (updateBtn) {
      // 已经是基线时别承诺"重建"：镜像 tag 没变，compose 不会重启容器（只拉取/校验）
      updateBtn.textContent = st.outdated && st.targetVersion ? `更新到 ${st.targetVersion}` : '重新拉取镜像';
      updateBtn.disabled = st.container === true || !st.installed || st.busy;
    }
    const backBtn = document.getElementById('snowluma-rollback-btn');
    if (backBtn) backBtn.disabled = st.container === true || !(st.lastResult?.from) || st.busy;
    if (note) {
      if (st.container) {
        note.textContent = '容器模式：协议端镜像由 compose 管理；请在宿主机更新 compose 后重建容器。';
        return;
      }
      const bits = [];
      if (st.auto?.enabled) bits.push('自动更新：已开启（每 6 小时检查一次）');
      if (String(st.auto?.image || '').trim()) {
        bits.push('随版本对齐：已停用（当前使用自定义镜像）');
      } else if (st.auto?.followBaseline === false) {
        bits.push('随版本对齐：已关闭');
      } else {
        bits.push('随版本对齐：已开启（更新到新版本时自动对齐协议端基线）');
      }
      note.textContent = bits.join(' · ');
    }
  } catch (error) {
    box.textContent = `读取协议端版本失败：${error?.message ?? error}`;
  }
}

/** 点按钮才绑定（渲染后调用；不在这一页时自己 no-op）。 */
function bindSnowlumaActions() {
  const check = document.getElementById('snowluma-check-btn');
  if (!check) return;
  const note = document.getElementById('snowluma-action-note');
  const say = (text) => { if (note) note.textContent = text; };

  check.addEventListener('click', () => { say(''); hydrateSnowlumaPanel(); });

  document.getElementById('snowluma-update-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (lastStatus?.container) {
      say('容器部署请在宿主机更新 compose 中的协议端镜像后重建容器。');
      return;
    }
    const outdated = lastStatus?.outdated === true;
    const target = lastStatus?.targetVersion ? ` ${lastStatus.targetVersion}` : '';
    const head = outdated
      ? `确定更新协议端吗？\n\n会把镜像换成项目基线${target}并重建容器：`
      : '当前已经是项目基线版本。\n\n这会重新拉取镜像并让 compose 对齐配置（镜像没变时不会白重启容器）：';
    if (!window.confirm(`${head}\n· 端口/数据卷不动，QQ 登录态保留\n· 更新期间机器人会短暂离线（约 10~30 秒）\n· 拉取失败只还原配置，起不来会自动回滚\n\n镜像备份与日志会留在协议端目录的 backups/ 下。`)) return;
    btn.disabled = true;
    say('正在更新协议端…（拉镜像 + 对齐容器，通常 10~60 秒）');
    try {
      const res = await api('/api/snowluma/update', { method: 'POST', body: JSON.stringify({}) });
      say(res.ok
        ? `已更新到 ${res.to}${res.waitedMs ? `（等待就绪 ${Math.round(res.waitedMs / 1000)}s）` : ''}`
        : `更新失败：${res.error}${res.rolledBack ? '（已自动回滚到旧镜像）' : ''}`);
    } catch (error) {
      say(`更新失败：${error?.message ?? error}`);
    } finally {
      btn.disabled = false;
      hydrateSnowlumaPanel();
    }
  });

  document.getElementById('snowluma-rollback-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (lastStatus?.container) {
      say('容器部署请在宿主机把镜像 tag 改回上一版后重建容器。');
      return;
    }
    if (!window.confirm('回滚到上一次更新前的镜像？（同样会重启协议端容器，登录态保留）')) return;
    btn.disabled = true;
    say('正在回滚…');
    try {
      const res = await api('/api/snowluma/rollback', { method: 'POST', body: JSON.stringify({}) });
      say(res.ok ? `已回滚到 ${res.to}` : `回滚失败：${errorText(res)}`);
    } catch (error) {
      say(`回滚失败：${error?.message ?? error}`);
    } finally {
      btn.disabled = false;
      hydrateSnowlumaPanel();
    }
  });
}

function errorText(res) {
  return res?.error || '未知原因';
}

export { bindSnowlumaActions, hydrateSnowlumaPanel };
