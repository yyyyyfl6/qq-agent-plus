// 日志/落盘文本的统一脱敏口径。
// 两个使用点：incident-pilot（异常面板入库前）、orchestrator（工具失败的 journal 行）——
// 后者会把工具错误原文写进 journald，而 OneBot 的 access_token 是挂在 URL 查询串上的
// （src/onebot/onebot.js 里拼接为 ?access_token=…），错误串里可能带上它，所以两边必须同一套规则。
//
// 规则按**值形态**命中（Bearer 头 / 查询串令牌参数 / JSON 键值 / Cookie 头 / 裸密钥前缀），
// 与"按字段名判定"的 SECRET_KEY_PATTERN（secret-keys.js）互补：前者拦得住字段名正常的密钥，
// 后者拦得住字段名不含关键词、但值本身就是密钥的场景（审计快照里的 extraBody/headers 等）。
export function redactSecretValue(value) {
  return String(value ?? '')
    // 上游错误有时回显整个图片/附件，日志与通知不保留 base64 二进制内容。
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^,\s]*)?;base64,[a-z0-9+/=_-]+/gi, '[附件内容已省略]')
    .replace(/\bbase64:\/\/[a-z0-9+/=_-]+/gi, '[附件内容已省略]')
    // Bearer/Basic 头：值吃到空白为止（连同结尾引号）。保持既有语义不动。
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]')
    // 查询串里的令牌参数：名字本身在表内的（token/key/apikey/…），或"分隔符 + 令牌词"结尾的
    // （access_token / client_secret / api_key / session-key 这类——旧的纯精确名单漏掉它们，
    // 而百度换 token 的 URL 实际就在用 client_id/client_secret，asr-baidu.js）。
    // 分隔符要求让 monkey=/tokenizer=/sortkey= 这类普通词不误伤。
    .replace(/([?&](?:[a-z0-9_-]*[_-])?(?:token|key|secret|password|authorization|auth|credentials?|signature|apikey|client_id|clientid)=)[^&\s]+/gi, '$1[redacted]')
    // JSON 体形态："apiKey": "…"（错误信息里原样回显请求体时的兜底；命中面故意偏宽，宁多脱勿漏）。
    .replace(/("[a-z0-9_-]*(?:access_token|api_key|apikey|client_id|client_secret|secret_key|api_token|auth_token|auth_key|session_key|token|secret|password|authorization|credential|key)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    // Cookie 头整值脱敏（一对对抠不现实，整个值都是凭据）。
    .replace(/\b(cookie)\s*:\s*\S+/gi, '$1: [redacted]')
    // 裸的供应商密钥前缀（sk-/pk-/rk-，OpenAI/Stripe 风格；连字符与下划线两种分隔都认，
    // Stripe 是 sk_live_… 形态）：错误文本与粘贴的配置里常以裸串出现，前面几种形态
    // （查询串 / JSON / 头）都拦不住它。命中面同"宁多脱勿漏"，至少 8 位才算（2026-09-30 #6 补）。
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/gi, '$1-[redacted]');
}

/** 日志行用：值形态脱敏 + 去 NUL + 掐头去尾空白 + 截断。 */
export function redactText(value, max = 1000) {
  return redactSecretValue(value)
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
