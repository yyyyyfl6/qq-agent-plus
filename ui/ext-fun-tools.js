'use strict';

// 趣味功能页面（扩展功能）：今日人品 / 今日运势 / 塔罗牌的开关与样例预览。

import { api } from './core/api.js';
import { $, esc } from './core/dom.js';
import { extFlash, extHead, extOnTab } from './ext-kit.js';

(function funToolsPage() {
  async function load() {
    const box = $('#ext-fun-page');
    if (!box) return;
    try {
      render(await api('/api/ext/fun-tools'));
    } catch (error) {
      box.innerHTML = `<div class="empty-hint">读取失败：${esc(error.message)}</div>`;
    }
  }

  function render(data) {
    const c = data?.config || {};
    const s = data?.sample || {};
    const items = [
      ['jrrp', '🎲 今日人品', '"jrrp""今天人品多少"：0~100，按 QQ 号 + 北京日期固定，一天内问几次都一样。',
        s.jrrp ? `示例：${s.jrrp.value}（${s.jrrp.level}）` : ''],
      ['fortune', '🏮 今日运势', '"今日运势""抽个签"：吉凶签 + 宜/忌 + 幸运数字与颜色，同样一天一固定。',
        s.fortune ? `示例：${s.fortune.luck} · 宜${s.fortune.good.join('、')} · 忌${s.fortune.bad.join('、')}` : ''],
      ['tarot', '🔮 塔罗牌', '"抽张塔罗""帮我占卜一下"：22 张大阿卡纳，单张指引或过去/现在/未来三张牌阵，正逆位随机。',
        s.tarot ? `示例：${s.tarot.map((t) => `${t.position}·${t.name}（${t.orientation}）`).join(' / ')}` : '']
    ];
    $('#ext-fun-page').innerHTML = `
      ${extHead({
        icon: 'dice', title: '趣味功能', toggleId: 'fun-enabled', enabled: c.enabled,
        sub: '群里常见的小玩法。结果由系统按规则算出来（离线、零花费），机器人只负责用自己的口吻说——不会同一个人一会儿 90 一会儿 12。'
      })}
      <div class="fun-grid">
        ${items.map(([key, title, desc, sample]) => `
          <label class="fun-card ${c[key] !== false ? 'on' : ''}">
            <div class="fun-card-top"><strong>${title}</strong><input type="checkbox" data-fun="${key}" ${c[key] !== false ? 'checked' : ''} /></div>
            <div class="fun-desc">${esc(desc)}</div>
            ${sample ? `<div class="fun-sample">${esc(sample)}</div>` : ''}
          </label>`).join('')}
      </div>
      <div class="hint" style="margin-top:10px">掷骰子、抽签、随机点名、成语接龙这类原有玩法不受这里影响（它们一直都在）。</div>
      <span class="ext-flash" id="fun-flash"></span>`;
    const save = async () => {
      const config = { enabled: $('#fun-enabled').checked };
      document.querySelectorAll('[data-fun]').forEach((el) => { config[el.dataset.fun] = el.checked; });
      try {
        await api('/api/ext/fun-tools/config', { method: 'POST', body: JSON.stringify({ config }) });
        extFlash($('#fun-flash'), '已保存', 'ok');
        await load();
      } catch (error) { extFlash($('#fun-flash'), `保存失败：${error.message}`, 'bad'); }
    };
    $('#fun-enabled')?.addEventListener('change', save);
    document.querySelectorAll('[data-fun]').forEach((el) => el.addEventListener('change', save));
  }

  extOnTab('ext-fun', load);
})();
