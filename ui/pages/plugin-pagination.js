// 插件目录分页控件：纯前端（索引已经整份拉回），与技能市场的分页保持同一套视觉。
const PLUGIN_PAGE_SIZE = 12;

function pluginPaginationHtml(page, totalPages, total) {
  if (totalPages <= 1) return '';
  const nums = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i += 1) {
    nums.push(`<button type="button" class="plugin-page${i === page ? ' is-on' : ''}" data-plugin-page="${i}" aria-current="${i === page ? 'page' : 'false'}">${i}</button>`);
  }
  return `<nav class="plugin-pagination" data-total="${total}" data-pages="${totalPages}" aria-label="插件目录分页">
    <button type="button" class="plugin-page" data-plugin-page="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    ${nums.join('')}
    <button type="button" class="plugin-page" data-plugin-page="next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    <span class="plugin-page-summary">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>
  </nav>`;
}

export { PLUGIN_PAGE_SIZE, pluginPaginationHtml };
