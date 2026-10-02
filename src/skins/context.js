import { AsyncLocalStorage } from 'node:async_hooks';

// 每轮固定所属皮肤；切换后的迟到回调仍写回原仓，不能污染新人格。
const scope = new AsyncLocalStorage();
export const skinScope = () => scope.getStore() || null;
export const withSkinScope = (value, fn) => scope.run(value, fn);
export const logicalChatKey = (key) => String(key || '').replace(/\/skin\/[a-z][a-z0-9_-]{0,39}$/, '');
