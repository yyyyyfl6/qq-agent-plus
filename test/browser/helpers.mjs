/* global document */
import { expect } from '@playwright/test';
import { E2E_TOKEN } from './constants.mjs';

/** 用 API 登录，cookie 落在当前 browser context 里，后续 page.goto 直接是已登录态。 */
export async function login(page) {
  const response = await page.request.post('/api/login', { data: { token: E2E_TOKEN } });
  expect(response.ok(), `login failed: HTTP ${response.status()}`).toBeTruthy();
}

/**
 * 收集 console error / pageerror。
 * 过滤两类预期噪声：登录失败用例里的 401 网络日志、favicon 404。
 */
export function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/401 \(Unauthorized\)/.test(text)) return;
    if (/favicon\.ico/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

export async function tabNames(page) {
  return page.locator('#tabs .tab[data-tab]').evaluateAll((nodes) => nodes.map((node) => node.dataset.tab));
}

/** 窄屏下导航可能收起成抽屉：优先点可见 tab，点不到就直接点 DOM 节点。 */
export async function switchTo(page, tab) {
  // 首屏模块脚本是 defer：goto 返回时 tab 节点已在 DOM、但 click 监听可能还没挂上。
  // syncSideNav 会给当前页签写 aria-current，等到它出现再点（不假定一定是总览）。
  await expect(page.locator('#tabs .tab[aria-current="page"]')).toHaveCount(1);
  const button = page.locator(`#tabs .tab[data-tab="${tab}"]`);
  if (await button.isVisible().catch(() => false)) {
    await button.click();
  } else {
    // 功能页签的显隐由配置异步同步；首屏 selector 可能还没变成可见，但 click 仍会切页。
    // window.switchTab 没有暴露到全局，这里直接点 DOM，避免依赖测试用后门。
    await page.evaluate((name) => {
      document.querySelector(`#tabs .tab[data-tab="${name}"]`)?.click();
    }, tab);
  }
  await expect(page.locator(`#view-${tab}`)).toHaveClass(/active/);
}
