// 扩展功能的组装点（长期记忆用上游 src/living-memory，这里不再重复实现）：控制台 app.js（组合根）只和这里打交道。
//
//   initExtensions({ dataDir, store, sender, log })  创建各模块运行时（不建库、不起定时器）
//   startExtensions() / stopExtensions()              跟随服务启停；各模块自己按配置决定要不要干活
//   extensionToolDefs()                               追加到聊天工具表（每个 def 带 available(ctx) 过滤）
//   registerExtensionRoutes(router, deps)             各模块自己的 /api/ext/* 路由
//
// 运行时没初始化（单测里直接 new Orchestrator、没走控制台）时，工具与提示词钩子都安静地不生效。
import { ChatSummaryRuntime, chatSummaryToolDefs, registerChatSummaryRoutes } from './chat-summary.js';
import { LabBridgeRuntime, labBridgeToolDefs, registerLabBridgeRoutes } from './lab-bridge.js';
import { funToolDefs, registerFunToolsRoutes } from './fun-tools.js';

const runtimes = {
  chatSummary: null,
  labBridge: null
};

export function initExtensions({ dataDir, store, sender, log = console.log } = {}) {
  // 各模块自己的日志都带 [chat-summary] / [lab-bridge] 前缀
  runtimes.chatSummary = new ChatSummaryRuntime({ store, sender, log });
  runtimes.labBridge = new LabBridgeRuntime({ dataDir, sender, log });
  return runtimes;
}

export function extensionRuntimes() {
  return runtimes;
}

export function startExtensions() {
  runtimes.labBridge?.start();
}

export function stopExtensions() {
  runtimes.labBridge?.stop();
}

export function extensionToolDefs() {
  return [
    ...chatSummaryToolDefs(() => runtimes.chatSummary),
    ...labBridgeToolDefs(() => runtimes.labBridge),
    ...funToolDefs()
  ];
}

/** 工具是否注入本轮：普通工具一律放行；扩展工具看自己的 available 与运行时是否就绪。 */
export function extensionToolAvailable(def, { cfg, kind, chatKey } = {}) {
  if (!def?.extension) return true;
  if (def.extension === 'chatSummary' && !runtimes.chatSummary) return false;
  if (def.extension === 'labBridge' && !runtimes.labBridge) return false;
  try {
    return typeof def.available === 'function' ? def.available({ cfg, kind, chatKey }) === true : true;
  } catch {
    return false;
  }
}

export function registerExtensionRoutes(router, deps) {
  registerChatSummaryRoutes(router, { ...deps, getRuntime: () => runtimes.chatSummary });
  registerLabBridgeRoutes(router, { ...deps, getRuntime: () => runtimes.labBridge });
  registerFunToolsRoutes(router, deps);
}
