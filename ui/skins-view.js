'use strict';

// 侧栏「人格」页：把 /skins.html 里的 #skins-page 原样取进控制台的 #skins-host，再交给 skins.js 初始化。
// 为什么不复制一份结构：人格页的元素 id 与 skins.js / test/skins-ui.test.mjs 一一对应，
// 两份结构迟早漂移；/skins.html 单独打开也要继续能用。所以这里只做"取过来 + 初始化"。
// 每次切到这一页都重新初始化一次（拿最新的人格列表与会话绑定），结构只取一次。

import { initSkinsPage } from './skins.js';

(function skinsView() {
  let loading = null;

  async function mount() {
    const host = document.getElementById('skins-host');
    if (!host) return;
    if (!host.querySelector('#skins-page')) {
      if (!loading) {
        loading = (async () => {
          const res = await fetch('/skins.html', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
          const page = doc.getElementById('skins-page');
          if (!page) throw new Error('skins.html 里找不到 #skins-page');
          page.querySelectorAll('script').forEach((node) => node.remove());
          host.replaceChildren(document.importNode(page, true));
        })().finally(() => { loading = null; });
      }
      try {
        await loading;
      } catch (error) {
        host.innerHTML = `<div class="empty-hint">人格页载入失败：${String(error?.message ?? error).replace(/[<>&]/g, '')}</div>`;
        return;
      }
    }
    await initSkinsPage();
  }

  document.querySelectorAll('.tab[data-tab="skins"]').forEach((btn) => {
    btn.addEventListener('click', () => { mount().catch((error) => console.warn('[skins-view]', error)); });
  });
})();
