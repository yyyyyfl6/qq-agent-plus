// 搜索链路自测：设置页的“测试搜索”按钮。
// 从 settings-bind.js 拆出，避免设置事件文件超过 1800 行上限。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';

function bindSearchTest() {
  const runSearchTest = async () => {
    const input = $('#cfg-search-test-query');
    const box = $('#cfg-search-test-result');
    const query = String(input?.value || '').trim();
    if (!box) return;
    if (!query) { box.textContent = '先输入一个搜索词，例如：上海天气 / 某个梗'; return; }
    const meme = $('#cfg-search-test-meme')?.checked !== false;
    box.textContent = '搜索中…';
    try {
      const r = await api('/api/web-search/test', {
        method: 'POST',
        body: JSON.stringify({ query, meme })
      });
      if (!r.ok) { box.textContent = `搜索失败：${r.error || '未知错误'}`; return; }
      const sources = (r.sources || []).join(' → ') || '（未报告）';
      const rows = (r.results || []).map((item) => {
        const title = esc(item.title || '(无标题)');
        const url = /^https?:\/\//i.test(String(item.url || '')) ? esc(item.url) : '';
        const snippet = item.snippet ? `<div class="muted">${esc(item.snippet)}</div>` : '';
        return `<li>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}${snippet}</li>`;
      }).join('');
      box.innerHTML = `<div><b>来源：</b>${esc(sources)}${r.supplemented ? '（触发了梗补充）' : '（只用了主搜索）'}`
        + ` · ${r.meme ? '梗模式' : '普通模式'} · ${Number(r.latencyMs) || 0} ms · ${Number(r.count) || 0} 条</div>`
        + (rows ? `<ol>${rows}</ol>` : '<div>没有结果</div>');
    } catch (error) {
      box.textContent = `搜索失败：${error.message}`;
    }
  };
  $('#cfg-search-test-btn')?.addEventListener('click', runSearchTest);
  $('#cfg-search-test-query')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runSearchTest(); }
  });
}

export { bindSearchTest };
