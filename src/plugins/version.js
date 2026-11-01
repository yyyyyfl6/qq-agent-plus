/**
 * 插件版本的规范化：撤回规则与注册表比较必须用同一把尺子。
 *
 * 索引是第三方内容源，`version` 可能写成 `1.0`、`v1.0.0`、`1.0.0+build`；
 * 而 manifest 校验后的版本总是 `x.y.z`。按字符串精确比较会漏掉这些等价写法 ——
 * 一条 `demo@1.0` 的撤回规则对已安装的 `1.0.0` 完全不起作用。
 */
export function canonicalVersion(value) {
  // 只剥构建元数据（+build），**保留预发布后缀**：1.0.0-beta.1 与 1.0.0 是两个版本，
  // 把 '-' 也截掉会让"撤预发布版"误伤稳定版（2026-10-17 审查）
  const text = String(value ?? '').trim().replace(/^[vV]/, '').split('+')[0];
  if (!text) return '';
  const dash = text.indexOf('-');
  const core = dash >= 0 ? text.slice(0, dash) : text;
  const pre = dash >= 0 ? text.slice(dash) : '';
  const parts = core.split('.').map((n) => Number(n));
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0)) return '';
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join('.') + pre;
}

/** 撤回规则里的一侧：`id`（撤全部）或 `id@canonical`。 */
export function versionRule(id, version) {
  const canonical = canonicalVersion(version);
  return canonical ? `${id}@${canonical}` : String(id || '');
}
