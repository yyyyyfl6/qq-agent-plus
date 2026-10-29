/* global document */
import { test, expect } from '@playwright/test';
import { E2E_PLUGIN_ID, E2E_TOKEN } from './constants.mjs';
import { collectPageErrors, login, switchTo, tabNames } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

test('登录：错 Token 留在登录框，对 Token 进入总览，?token= 自动登录后清理 URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#console-login')).toBeVisible();

  await page.fill('#console-token', 'definitely-wrong-token');
  await page.click('#console-login-form button[type="submit"]');
  await expect(page.locator('#console-login-error')).toContainText(/Token|不正确/);

  await page.fill('#console-token', E2E_TOKEN);
  await page.click('#console-login-form button[type="submit"]');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect(page.locator('#console-login')).toBeHidden();
});

test('?token= 自动登录后把 Token 从地址栏移除', async ({ page }) => {
  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page.locator('#view-overview')).toHaveClass(/active/);
  await expect.poll(() => new URL(page.url()).searchParams.get('token')).toBeNull();
});

test('15 个页签逐一切换，且没有 console error / pageerror', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.goto('/');
  await expect(page.locator('#view-overview')).toHaveClass(/active/);

  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(15);

  for (const tab of tabs) {
    await switchTo(page, tab);
    await page.waitForTimeout(80);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('设置保存：改发送频率后落盘，再还原', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="chat"]');

  const input = page.locator('#cfg-maxpermin');
  await expect(input).toBeVisible();
  await input.fill('81');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).send.maxPerMinute;
  await expect.poll(read).toBe(81);

  await input.fill('80');
  await page.click('#save-cfg-btn');
  await expect.poll(read).toBe(80);
});

test('图片生成：自定义请求参数保存后回显', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');

  const area = page.locator('#cfg-img-extra-body');
  await expect(area).toBeAttached();
  await area.fill('{"output_watermark": {"enabled": false}}');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).imageGen.extraBody;
  await expect.poll(read).toEqual({ output_watermark: { enabled: false } });

  await page.reload();
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  // 回显是格式化后的 JSON（多行缩进），按解析后的对象比对，别用紧凑字符串正则
  const echoed = await page.locator('#cfg-img-extra-body').inputValue();
  expect(JSON.parse(echoed)).toEqual({ output_watermark: { enabled: false } });

  // 生成后发送格式（issue #67）：默认表情，可切普通图片；切换后落盘
  await expect(page.locator('#cfg-img-send-as')).toHaveValue('sticker');
  await page.selectOption('#cfg-img-send-as', 'image');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
  await expect.poll(async () => (await (await page.request.get('/api/config')).json()).imageGen.sendAs).toBe('image');
});

test('技能页：渲染内置技能并可全局启停', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'skills');
  await expect(page.locator('#skills-page')).toBeVisible();
  await page.click('[data-skills-view="installed"]');
  await expect(page.locator('#skills-list')).toContainText('群聊总结');
  await page.click('[data-skill-open="chat-summary"]');
  await expect(page.locator('#skills-detail')).toBeVisible();
  await page.click('[data-skill-back]');
  await expect(page.locator('#skills-list')).toBeVisible();

  const toggle = page.locator('#skills-enabled');
  await expect(toggle).toHaveCSS('width', '44px');
  const readEnabled = async () => (await (await page.request.get('/api/skills')).json()).enabled;
  await expect.poll(readEnabled).toBe(true);
  await toggle.click();
  await expect.poll(readEnabled).toBe(false);
  await toggle.click();
  await expect.poll(readEnabled).toBe(true);

  await page.click('[data-skills-view="publish"]');
  await expect(page.locator('#skills-publish-view')).toBeVisible();
  await expect(page.locator('#skills-publish-view')).toContainText('提交一个技能');
});

test('技能市场：预览、安装、已安装列表与卸载', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'skills');
  await page.click('[data-skills-view="market"]');
  await expect(page.locator('#skills-market-view')).toContainText('出行规划');
  await expect(page.locator('.skills-market-pagination')).toBeVisible();
  await page.click('[data-market-page="next"]');
  await expect(page.locator('.skills-market-page.is-on')).toHaveText('2');
  await page.click('[data-market-page="prev"]');

  await page.click('[data-market-open="trip-planner"]');
  await expect(page.locator('.skills-market-preview')).toContainText('目标：');
  await page.click('[data-market-install="trip-planner"]');
  await page.click('[data-confirm-accept]');

  await page.click('[data-skills-view="installed"]');
  await expect(page.locator('#skills-list')).toContainText('出行规划');
  await page.click('[data-skill-open="trip-planner"]');
  await expect(page.locator('#skills-detail')).toContainText('出行规划');
  await page.click('[data-skill-uninstall="trip-planner"]');
  await page.click('[data-confirm-accept]');
  await expect(page.locator('#skills-list')).not.toContainText('出行规划');
});

test('插件详情在打开过技能市场后仍占满主区（回归：同名 .plugin-layout 抢走 is-detail）', async ({ page }) => {
  await login(page);
  await page.goto('/');
  // 技能市场与插件页共用 .plugin-layout/.plugin-toolbar，且 #view-skills 在 DOM 里更靠前。
  // 先把它渲染出来，才能复现"详情落在 190px 列里"的布局串台。
  await switchTo(page, 'skills');
  await expect(page.locator('#skills-page .plugin-layout')).toHaveCount(1);

  await switchTo(page, 'plugins');
  await page.click('[data-plugin-pane="installed"]');
  await page.locator('#plugins-installed [data-plugin-open]').first().click();
  await expect(page.locator('#plugins-page .plugin-detail')).toBeVisible();
  await expect(page.locator('#plugins-page .plugin-layout')).toHaveClass(/is-detail/);
  await expect(page.locator('#skills-page .plugin-layout')).not.toHaveClass(/is-detail/);

  const widths = await page.evaluate(() => ({
    detail: document.querySelector('#plugins-page .plugin-detail')?.getBoundingClientRect().width || 0,
    main: document.querySelector('#plugins-page .plugin-main')?.getBoundingClientRect().width || 0
  }));
  expect(widths.detail).toBeGreaterThan(500);
  expect(widths.main).toBeGreaterThan(500);
});

test('人物记忆：控制台按关键词检索记忆', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'people-memory');
  await page.fill('#gm-search-query', '面馆');
  await page.click('#gm-search-btn');
  await expect(page.locator('#gm-search-results')).toContainText('面馆');
});

test('长期记忆页：四个页签、记忆详情与召回测试可用', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'living-memory');
  await expect(page.locator('#living-memory-page h2')).toHaveText('长期记忆');
  await expect(page.locator('#lm-enabled')).toBeChecked();
  await expect(page.locator('#lm-shadow-semantic')).toBeAttached();
  await expect(page.locator('#lm-turn-retention')).toHaveValue('7');
  await expect(page.locator('#lm-status-filter')).toBeAttached();

  await page.click('[data-lm-tab="memories"]');
  await expect(page.locator('#lm-memory-list')).toContainText('NAS 迁移计划');

  // 键盘焦点在行内「归档」上时，Enter 应触发归档确认，而不是打开详情。
  const archive = page.locator('.lm-memory-row [data-lm-archive]').first();
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await page.click('[data-confirm-cancel]');
  await expect(page.locator('.lm-detail-card')).toHaveCount(0);

  await page.locator('.lm-memory-row', { hasText: 'NAS 迁移计划' }).click();
  await expect(page.locator('.lm-detail-card h3')).toHaveText('NAS 迁移计划');
  await page.click('[data-lm-back]');
  await expect(page.locator('#lm-memory-list')).toContainText('NAS 迁移计划');

  await page.click('[data-lm-tab="recall"]');
  await expect(page.locator('#lm-test')).toHaveText('测试召回');
  await page.fill('#lm-query', 'NAS 迁移备份');
  await page.click('#lm-test');
  await expect(page.locator('#lm-recall-result')).toContainText('NAS 迁移计划');

  await page.click('[data-lm-tab="settings"]');
  await expect(page.locator('#lm-enabled')).toBeVisible();
});

test('设置 → 实验功能：长期记忆卡片显示状态并可进入/取消固化', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('button[data-section="experiments"]');
  await expect(page.locator('#experiment-living-memory')).toBeVisible();
  await expect(page.locator('#living-memory-badge')).toHaveText('已固化');
  await expect(page.locator('#living-memory-state')).toContainText('运行中');
  await expect(page.locator('#lm-ungraduate')).toBeVisible();
  await expect(page.locator('#launch-living-memory-feature')).toHaveCount(0);
  await expect(page.locator('#lm-open-console')).toBeVisible();

  // 开关不应触发整页重绘（否则卡片会消失再出现）：先记下节点，再切换两次。
  await page.evaluate(() => { globalThis.__lmCard = document.querySelector('#experiment-living-memory'); });
  const enabled = page.locator('#cfg-living-memory-enabled');
  const readEnabled = async () => (await (await page.request.get('/api/config')).json()).livingMemory.enabled;
  await enabled.click();
  await expect.poll(readEnabled).toBe(false);
  await expect(page.locator('#living-memory-state')).toContainText('已停用');
  expect(await page.evaluate(() => globalThis.__lmCard === document.querySelector('#experiment-living-memory'))).toBe(true);
  await enabled.click();
  await expect.poll(readEnabled).toBe(true);
  await expect(page.locator('#living-memory-state')).toContainText('运行中');
  expect(await page.evaluate(() => globalThis.__lmCard === document.querySelector('#experiment-living-memory'))).toBe(true);

  await page.click('#lm-open-console');
  await expect(page.locator('#living-memory-page h2')).toHaveText('长期记忆');

  // 取消固化：同时关闭开关并隐藏导航入口，记忆数据不清空。
  await switchTo(page, 'settings');
  await page.click('button[data-section="experiments"]');
  await page.click('#lm-ungraduate');
  await page.click('[data-confirm-accept]');
  const readFlags = async () => {
    const lm = (await (await page.request.get('/api/config')).json()).livingMemory;
    return { enabled: lm.enabled, graduated: lm.graduated };
  };
  await expect.poll(async () => (await readFlags()).graduated).toBe(false);
  await expect.poll(async () => (await readFlags()).enabled).toBe(false);
  await expect(page.locator('#launch-living-memory-feature')).toHaveText('固化上线');
  await expect(page.locator('#tabs .tab[data-tab="living-memory"]')).toHaveClass(/hidden/);

  // 还原，避免影响同一服务器上的后续用例。
  await page.request.post('/api/config', { data: { livingMemory: { enabled: true, graduated: true } } });
});

test('语音服务切换：豆包/MiMo 各自恢复上次保存的音色', async ({ page }) => {
  await login(page);
  const setTts = async (data) => {
    const response = await page.request.post('/api/config', { data: { tts: { enabled: true, ...data } } });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  await setTts({
    provider: 'doubao',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    voice: 'ICL_E2E_DOUBAO'
  });
  await setTts({
    provider: 'mimo',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'Chloe'
  });

  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  const service = page.locator('#cfg-tts-service');
  await expect(service.locator('option[value="mimo"]')).toHaveCount(1);
  await expect(service).toHaveValue('mimo');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('Chloe');

  await service.selectOption('doubao');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('ICL_E2E_DOUBAO');
  await service.selectOption('mimo');
  await expect(page.locator('#cfg-tts-voice')).toHaveValue('Chloe');

  // 自定义/自建没有内置模型：不能把 MiMo 的模型名原样留在框里
  await service.selectOption('custom');
  await expect(page.locator('#cfg-tts-model')).toHaveValue('');
});

test('图片生成切换预设：没有内置模型的预设不能沿用上一家的模型名', async ({ page }) => {
  await login(page);
  const saved = await page.request.post('/api/config', {
    data: {
      imageGen: {
        enabled: true,
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen-Image'
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();

  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="asr"]');
  const service = page.locator('#cfg-img-service');
  await expect(service.locator('option[value="modelscope"]')).toHaveCount(1);
  await expect(page.locator('#cfg-img-model')).toHaveValue('Qwen/Qwen-Image');

  await service.selectOption('modelscope');
  await expect(page.locator('#cfg-img-model')).toHaveValue('', { timeout: 3000 });
  await service.selectOption('siliconflow');
  await expect(page.locator('#cfg-img-model')).toHaveValue('Tongyi-MAI/Z-Image-Turbo');
});

test('生活层设置页可渲染、可保存，窄屏无横向溢出', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="life-feed"]');

  await expect(page.locator('#settings-lifefeed')).toBeVisible();
  await expect(page.locator('#lifefeed-status')).toContainText('未开启');

  const interval = page.locator('#cfg-lifefeed-interval');
  await expect(interval).toHaveValue('360');
  await interval.fill('300');
  await page.click('#save-cfg-btn');
  await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');

  const read = async () => (await (await page.request.get('/api/config')).json()).lifeFeed.forageIntervalMinutes;
  await expect.poll(read).toBe(300);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  await interval.fill('360');
  await page.click('#save-cfg-btn');
  await expect.poll(read).toBe(360);
});

test('好友设置保存：改入站待批上限后落盘，再还原', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'friends');

  const input = page.locator('#cfg-identity-incoming-max-pending');
  await expect(input).toBeVisible();
  await input.fill('51');
  await page.click('#friend-feature-save');

  const read = async () => {
    const cfg = await (await page.request.get('/api/config')).json();
    return cfg.identityPilot?.incomingFriendRequest?.maxPending;
  };
  await expect.poll(read).toBe(51);

  await page.locator('#cfg-identity-incoming-max-pending').fill('50');
  await page.click('#friend-feature-save');
  await expect.poll(read).toBe(50);
});

test('插件目录：索引超过一页时分页', async ({ page }) => {
  const plugins = Array.from({ length: 30 }, (_, index) => ({
    id: `demo-${String(index + 1).padStart(2, '0')}`,
    name: `测试插件 ${String(index + 1).padStart(2, '0')}`,
    description: '分页回归用条目',
    version: '1.0.0',
    author: 'tester',
    category: '测试',
    tags: ['test'],
    capabilities: ['tools'],
    compatible: true,
    downloads: index,
    updatedAt: '2026-10-01'
  }));
  await page.route('**/api/plugins/index', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins, skipped: [], sources: [{ name: '测试索引', ok: true, count: plugins.length }] })
  }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await expect(page.locator('.plugin-pagination')).toBeVisible();
  await page.click('[data-plugin-page="next"]');
  await expect(page.locator('.plugin-page.is-on')).toHaveText('2');
});

test('插件审批：待批请求能在插件详情里点「批准一次」', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await expect(page.locator('#plugins-page')).toBeVisible();

  await page.click('[data-plugin-pane="installed"]');
  // 顶部跨插件待批条：直接点进去，详情应自动滚到「待你批准」
  const banner = page.locator('#plugins-pending-banner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('待批');
  await banner.locator('[data-pending-jump="1"]').first().click();

  const block = page.locator(`[data-pd-settings="${E2E_PLUGIN_ID}"]`);
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block).toContainText('待你批准');
  await block.locator('[data-pd-approve-pending]').first().click();

  const read = async () => (await (await page.request.get(`/api/plugins/settings?id=${E2E_PLUGIN_ID}`)).json());
  await expect.poll(async () => (await read()).pending.length).toBe(0);
  const settings = await read();
  expect(settings.grants?.approvals?.write?.usesLeft ?? 0).toBeGreaterThan(0);
});

test('窄屏设置：切到屏外分区后当前项仍在可视范围内', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.click('.settings-menu-item[data-section="experiments"]');
  const visible = await page.evaluate(() => {
    const menu = document.querySelector('#settings-sidebar .settings-menu');
    const active = menu?.querySelector('.settings-menu-item.active');
    if (!menu || !active) return false;
    const m = menu.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return a.left >= m.left - 1 && a.right <= m.right + 1;
  });
  expect(visible).toBe(true);
});

test('窄屏 390×844：15 个页签都没有横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  const tabs = await tabNames(page);
  expect(tabs).toHaveLength(15);

  for (const tab of tabs) {
    await switchTo(page, tab);
    await page.waitForTimeout(150);
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1);
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className || '').replace(/\s+/g, '.')}`)
    }));
    expect(metrics.scrollWidth, `tab=${tab} 越界元素：${metrics.offenders.join(' | ')}`)
      .toBeLessThanOrEqual(metrics.clientWidth + 1);
  }
});
