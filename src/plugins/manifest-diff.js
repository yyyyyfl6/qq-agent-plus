// 插件升级的 manifest 差异：哪些变化会让旧授权失效。
//
// 原则：**权限面任何变化都要重新授权**，文案/README 变化不算。权限面包括：
// capabilities、httpDomains、tools 的 action/actionTarget/actionPreview/参数、
// approvals、quotas、secret 字段、schedule、apiVersion，以及发布者/签名。
// settings 里非 secret 字段的变化只展示，不触发重置。
import crypto from 'node:crypto';

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sorted(value));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toolSignature(tool) {
  return {
    action: String(tool?.action || ''),
    actionTarget: Array.isArray(tool?.actionTarget)
      ? tool.actionTarget.map(String)
      : String(tool?.actionTarget || ''),
    actionPreview: String(tool?.actionPreview || ''),
    parameters: tool?.parameters || {}
  };
}

/** 权限相关的 manifest 投影（稳定排序，用于哈希与 diff）。 */
export function permissionProjection(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const tools = {};
  for (const tool of Array.isArray(m.tools) ? m.tools : []) {
    if (!tool?.name) continue;
    tools[tool.name] = toolSignature(tool);
  }
  const approvals = {};
  for (const item of Array.isArray(m.approvals) ? m.approvals : []) {
    if (!item?.action) continue;
    approvals[item.action] = {
      label: String(item.label || ''),
      description: String(item.description || '')
    };
  }
  const settings = {};
  for (const group of Array.isArray(m.settings?.groups) ? m.settings.groups : []) {
    for (const field of Array.isArray(group?.fields) ? group.fields : []) {
      if (!field?.key) continue;
      settings[field.key] = { type: String(field.type || ''), secret: field.type === 'secret' };
    }
  }
  return {
    apiVersion: Number(m.apiVersion) || 1,
    capabilities: [...new Set((Array.isArray(m.capabilities) ? m.capabilities : []).map(String))].sort(),
    httpDomains: [...new Set((Array.isArray(m.httpDomains) ? m.httpDomains : []).map(String))].sort(),
    tools,
    approvals,
    quotas: { ...(m.quotas || {}) },
    settings,
    schedule: (Array.isArray(m.schedule) ? m.schedule : [])
      .map((item) => ({ name: String(item?.name || ''), everyMs: Number(item?.everyMs) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    engines: { minVersion: String(m.engines?.minVersion || '') }
  };
}

/** 当前 manifest 的授权绑定指纹：grant/pending 带着它，换了版本就不匹配。 */
export function hashManifest(manifest) {
  return sha256(stableStringify(permissionProjection(manifest)));
}

function same(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function setDiff(before, after, label, added, removed) {
  const oldSet = new Set(before);
  const newSet = new Set(after);
  for (const item of newSet) if (!oldSet.has(item)) added[label].push(item);
  for (const item of oldSet) if (!newSet.has(item)) removed[label].push(item);
}

function mapDiff(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push(key);
    else if (!same(before[key], after[key])) modified.push(key);
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(key);
  return { added, removed, modified };
}

/**
 * @returns {{
 *   fromVersion:string,toVersion:string,permissionChanged:boolean,diffHash:string,
 *   areas:string[], added:object, removed:object, changed:object,
 *   summary:string[]
 * }}
 */
export function diffManifests(previous, next, {
  previousPublisher = '', nextPublisher = '', previousSignature = '', nextSignature = ''
} = {}) {
  const before = permissionProjection(previous);
  const after = permissionProjection(next);
  const added = { capabilities: [], httpDomains: [], tools: [], approvals: [], secrets: [], schedule: [] };
  const removed = { capabilities: [], httpDomains: [], tools: [], approvals: [], secrets: [], schedule: [] };
  const changed = {
    tools: [], approvals: [], quotas: [], settings: [], schedule: [], publisher: false, signature: false, apiVersion: false
  };

  setDiff(before.capabilities, after.capabilities, 'capabilities', added, removed);
  setDiff(before.httpDomains, after.httpDomains, 'httpDomains', added, removed);

  const toolDiff = mapDiff(before.tools, after.tools);
  added.tools.push(...toolDiff.added);
  removed.tools.push(...toolDiff.removed);
  changed.tools.push(...toolDiff.modified);

  const approvalDiff = mapDiff(before.approvals, after.approvals);
  added.approvals.push(...approvalDiff.added);
  removed.approvals.push(...approvalDiff.removed);
  changed.approvals.push(...approvalDiff.modified);

  const quotaDiff = mapDiff(before.quotas, after.quotas);
  changed.quotas.push(...quotaDiff.modified);

  const secretKeys = Object.keys(after.settings).filter((key) => after.settings[key].secret);
  const oldSecretKeys = Object.keys(before.settings).filter((key) => before.settings[key].secret);
  setDiff(oldSecretKeys, secretKeys, 'secrets', added, removed);
  const settingDiff = mapDiff(before.settings, after.settings);
  changed.settings.push(...settingDiff.modified.filter((key) => !after.settings[key]?.secret));

  const scheduleDiff = mapDiff(
    Object.fromEntries(before.schedule.map((item) => [item.name, item])),
    Object.fromEntries(after.schedule.map((item) => [item.name, item]))
  );
  added.schedule.push(...scheduleDiff.added);
  removed.schedule.push(...scheduleDiff.removed);
  changed.schedule.push(...scheduleDiff.modified);

  changed.publisher = String(previousPublisher || '') !== String(nextPublisher || '');
  changed.signature = String(previousSignature || '') !== String(nextSignature || '');
  changed.apiVersion = before.apiVersion !== after.apiVersion;

  const permissionChanged = Boolean(
    added.capabilities.length || removed.capabilities.length
    || added.httpDomains.length || removed.httpDomains.length
    || added.tools.length || removed.tools.length || changed.tools.length
    || added.approvals.length || removed.approvals.length || changed.approvals.length
    || changed.quotas.length
    || added.secrets.length || removed.secrets.length
    || added.schedule.length || removed.schedule.length || changed.schedule.length
    || changed.publisher || changed.signature || changed.apiVersion
  );

  const summary = [];
  const push = (kind, list, label) => {
    if (!list.length) return;
    summary.push(`${kind} ${label}：${list.slice(0, 8).join('、')}${list.length > 8 ? '…' : ''}`);
  };
  push('新增', added.capabilities, '能力');
  push('移除', removed.capabilities, '能力');
  push('新增', added.httpDomains, '域名');
  push('移除', removed.httpDomains, '域名');
  push('新增', added.tools, '工具');
  push('移除', removed.tools, '工具');
  push('变更', changed.tools, '工具');
  push('新增', added.approvals, '写动作');
  push('移除', removed.approvals, '写动作');
  push('变更', changed.approvals, '写动作');
  push('变更', changed.quotas, '配额');
  push('新增', added.secrets, '凭据字段');
  push('移除', removed.secrets, '凭据字段');
  push('变更', changed.settings, '设置字段');
  if (changed.publisher) summary.push('发布者变了');
  if (changed.signature) summary.push('签名变了');
  if (changed.apiVersion) summary.push('apiVersion 变了');

  const diffHash = sha256(stableStringify({ added, removed, changed, permissionChanged }));

  return {
    fromVersion: String(previous?.version || ''),
    toVersion: String(next?.version || ''),
    permissionChanged,
    diffHash,
    areas: [
      ...(added.capabilities.length || removed.capabilities.length ? ['capabilities'] : []),
      ...(added.httpDomains.length || removed.httpDomains.length ? ['httpDomains'] : []),
      ...(added.tools.length || removed.tools.length || changed.tools.length ? ['tools'] : []),
      ...(added.approvals.length || removed.approvals.length || changed.approvals.length ? ['approvals'] : []),
      ...(changed.quotas.length ? ['quotas'] : []),
      ...(added.secrets.length || removed.secrets.length ? ['secrets'] : []),
      ...(added.schedule.length || removed.schedule.length || changed.schedule.length ? ['schedule'] : []),
      ...(changed.publisher || changed.signature ? ['publisher'] : []),
      ...(changed.apiVersion ? ['apiVersion'] : [])
    ],
    added,
    removed,
    changed,
    summary
  };
}

/** 插件版本比较：只认数字段，预发布后缀按字符串比较（与 update-notice 同口径的简化版）。 */
export function comparePluginVersions(left, right) {
  const parse = (value) => String(value || '').trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3)
    .map((part) => Number.parseInt(part, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}
