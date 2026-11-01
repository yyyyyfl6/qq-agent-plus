// 浏览器冒烟的固定契约：测试进程与 scripts/e2e-server.mjs 共用。
export const E2E_PORT = Number(process.env.E2E_PORT || 33210);
export const E2E_TOKEN = 'e2e-console-token-2026-10';
export const E2E_GROUP = '123456';
export const E2E_PLUGIN_ID = 'browser-fixture';
