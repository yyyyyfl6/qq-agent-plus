// 插件 ↔ 宿主的线路协议：**一行一个 JSON**（NDJSON），零依赖。
//
// 这份协议是插件生态的长期契约：插件只依赖这里的方法名与消息形状，宿主内部怎么重构都不影响它，
// 所以 apiVersion 只增不改（破坏性变更要升版本号并在加载时拒掉旧插件）。
//
// 消息形状（JSON-RPC 的最小子集，够用且好读）：
//   请求   { "id": 1, "method": "callTool", "params": { "name": "x", "args": {} } }
//   成功   { "id": 1, "result": {...} }
//   失败   { "id": 1, "error": { "code": "E_TIMEOUT", "message": "…" } }
//   通知   { "method": "observe", "params": {...} }            // 没有 id = 不需要回执
//
// 宿主 → 插件：init / callTool / observe / schedule / ping / shutdown
// 插件 → 宿主：cap.log.write / cap.storage.get / cap.storage.set / cap.config.get / cap.http.request
//   （`cap.` 前缀的就是"能力调用"，宿主按 manifest 声明逐条鉴权）
export const PLUGIN_API_VERSION = 2;

export const HOST_METHODS = Object.freeze({
  init: 'init',
  callTool: 'callTool',
  observe: 'observe',
  schedule: 'schedule',
  ping: 'ping',
  // v2.1：控制台"检测"按钮用 —— 插件可选实现，返回登录态/依赖自检之类的应用层状态
  probe: 'probe',
  shutdown: 'shutdown'
});

export const CAP_PREFIX = 'cap.';
export const CAP_METHODS = Object.freeze({
  logWrite: `${CAP_PREFIX}log.write`,
  storageGet: `${CAP_PREFIX}storage.get`,
  storageSet: `${CAP_PREFIX}storage.set`,
  configGet: `${CAP_PREFIX}config.get`,
  httpRequest: `${CAP_PREFIX}http.request`,
  sendText: `${CAP_PREFIX}send.text`,
  // ── apiVersion 2 ──
  secretsGet: `${CAP_PREFIX}secrets.get`,
  secretsSet: `${CAP_PREFIX}secrets.set`,
  approvalCheck: `${CAP_PREFIX}approval.check`,
  quotaConsume: `${CAP_PREFIX}quota.consume`,
  mediaDownload: `${CAP_PREFIX}media.download`,
  mediaProbe: `${CAP_PREFIX}media.probe`,
  mediaMerge: `${CAP_PREFIX}media.merge`,
  mediaFrames: `${CAP_PREFIX}media.frames`,
  mediaDescribe: `${CAP_PREFIX}media.describe`,
  asrTranscribe: `${CAP_PREFIX}asr.transcribe`,
  feedPublish: `${CAP_PREFIX}feed.publish`,
  sendFile: `${CAP_PREFIX}send.file`
});

/** 能力方法 → 需要声明的能力名（鉴权用；漏一条就是"没声明也能用"）。 */
export const CAP_REQUIREMENT = Object.freeze({
  [CAP_METHODS.logWrite]: 'log',
  [CAP_METHODS.storageGet]: 'storage',
  [CAP_METHODS.storageSet]: 'storage',
  [CAP_METHODS.configGet]: 'config',
  [CAP_METHODS.httpRequest]: 'http',
  [CAP_METHODS.sendText]: 'send',
  [CAP_METHODS.secretsGet]: 'secrets',
  [CAP_METHODS.secretsSet]: 'secrets',
  [CAP_METHODS.approvalCheck]: 'approval',
  [CAP_METHODS.quotaConsume]: 'quota',
  [CAP_METHODS.mediaDownload]: 'media',
  [CAP_METHODS.mediaProbe]: 'media',
  [CAP_METHODS.mediaMerge]: 'media',
  [CAP_METHODS.mediaFrames]: 'media',
  [CAP_METHODS.mediaDescribe]: 'media',
  [CAP_METHODS.asrTranscribe]: 'media',
  [CAP_METHODS.feedPublish]: 'feed',
  [CAP_METHODS.sendFile]: 'send'
});

export const MAX_LINE_BYTES = 1024 * 1024;   // 单行上限：插件不能靠"吐一大坨"把宿主内存打满

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function rpcResult(id, result) {
  return { id, result: result === undefined ? null : result };
}

export function rpcError(id, code, message) {
  return { id, error: { code: String(code || 'E_PLUGIN'), message: String(message ?? '') } };
}

export function isResponse(message) {
  return Boolean(message) && typeof message === 'object' && 'id' in message
    && ('result' in message || 'error' in message);
}

export function isRequest(message) {
  return Boolean(message) && typeof message === 'object'
    && typeof message.method === 'string' && message.id !== undefined && message.id !== null;
}

export function isNotification(message) {
  return Boolean(message) && typeof message === 'object'
    && typeof message.method === 'string' && (message.id === undefined || message.id === null);
}

/** 出错时把消息截一段出来当线索（整条可能会很长）。 */
export function previewLine(text, max = 200) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 按行切分的解码器（**按字节找 \n，不按字符串**：一块 chunk 可能正好切在多字节字符中间，
 * 先 toString 会得到替换字符，中文参数会被悄悄改坏）。
 * - 超过 maxLineBytes 还没换行 → onViolation('line-too-long')，缓冲区丢掉（这已经不是协议数据了）
 * - JSON 解析失败 → onParseError(line)，单行丢弃、不影响后续
 */
export function createLineDecoder({
  maxLineBytes = MAX_LINE_BYTES, onMessage, onViolation, onParseError
} = {}) {
  let pending = null;
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      pending = pending?.length ? Buffer.concat([pending, incoming]) : incoming;
      let index = pending.indexOf(0x0a);
      while (index !== -1) {
        let line = pending.subarray(0, index);
        pending = pending.subarray(index + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        const text = line.toString('utf8').trim();
        if (text) {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { onParseError?.(text); parsed = null; }
          if (parsed && typeof parsed === 'object') onMessage?.(parsed);
        }
        index = pending.indexOf(0x0a);
      }
      if (pending.length > maxLineBytes) {
        pending = null;
        onViolation?.('line-too-long');
      }
    }
  };
}
