// 官方 MCP Registry 导入：只取 stdio 包并映射成本项目的 server 配置。
// 目录里有大量只支持远程 HTTP 的 server，当前客户端只支持 stdio，这类会标记 unsupported。

import { safeFetch } from '../llm/safe-fetch.js';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

function safeId(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'server';
}

function versionScore(version) {
  return String(version || '').split('.').reduce((sum, part, index) => {
    const n = Number(String(part).replace(/\D/g, '')) || 0;
    return sum + n / (1000 ** index);
  }, 0);
}

function packageConfig(entry, pkg) {
  const env = {};
  for (const item of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
    if (item?.name) env[String(item.name)] = String(item.default ?? '');
  }
  if (pkg.registryType === 'oci') {
    return {
      command: 'docker',
      args: ['run', '-i', '--rm', String(pkg.identifier || '')],
      env
    };
  }
  const identifier = String(pkg.identifier || '').trim();
  if (!identifier) return null;
  const pinned = pkg.version ? `${identifier}@${pkg.version}` : identifier;
  const runtime = Array.isArray(pkg.runtimeArguments)
    ? pkg.runtimeArguments.map((arg) => String(arg?.value ?? '')).filter(Boolean)
    : [];
  const args = ['-y', ...runtime.filter((arg) => arg !== '-y'), pinned];
  return { command: String(pkg.runtimeHint || 'npx'), args, env };
}

export function mapRegistryEntry(entry) {
  const name = String(entry?.name || '').trim();
  if (!name) return null;
  const packages = Array.isArray(entry.packages) ? entry.packages : [];
  const stdio = packages.find((pkg) =>
    pkg?.transport?.type === 'stdio' && ['npm', 'oci'].includes(pkg.registryType)
    && (pkg.registryType === 'oci' || pkg.identifier));
  if (!stdio) {
    return {
      id: safeId(name),
      title: String(entry.title || name),
      name,
      description: String(entry.description || ''),
      repository: String(entry.repository?.url || ''),
      version: String(entry.version || ''),
      category: '官方目录',
      source: 'registry',
      unsupported: true,
      reason: '只提供远程 HTTP 或未声明可运行的 stdio 包'
    };
  }
  const config = packageConfig(entry, stdio);
  if (!config) return null;
  return {
    id: safeId(name),
    title: String(entry.title || name),
    name,
    description: String(entry.description || ''),
    repository: String(entry.repository?.url || ''),
    version: String(entry.version || ''),
    category: '官方目录',
    source: 'registry',
    unsupported: false,
    config: {
      id: safeId(name),
      enabled: false,
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
      timeoutMs: 30000,
      maxCallsPerMinute: 30,
      toolMounting: 'direct'
    }
  };
}

export async function searchRegistry(query, { fetchImpl = safeFetch, limit = 20 } = {}) {
  const q = String(query || '').trim();
  const size = Math.max(1, Math.min(50, Number(limit) || 20));
  const url = q
    ? `${REGISTRY_URL}?search=${encodeURIComponent(q)}&limit=${size}`
    : `${REGISTRY_URL}?limit=${size}`;
  const res = await fetchImpl(url, { maxBytes: 500000, signal: AbortSignal.timeout(15000) });
  if (!res || res.statusCode >= 400) throw new Error(`MCP Registry 返回 ${res?.statusCode || '未知状态'}`);
  let data = null;
  try { data = JSON.parse(res.body || '{}'); } catch { throw new Error('MCP Registry 返回的不是 JSON'); }
  const list = Array.isArray(data) ? data : (Array.isArray(data.servers) ? data.servers : []);
  const byName = new Map();
  for (const item of list) {
    const entry = item?.server || item;
    const mapped = mapRegistryEntry(entry);
    if (!mapped) continue;
    const old = byName.get(mapped.name);
    if (!old || versionScore(mapped.version) > versionScore(old.version)) byName.set(mapped.name, mapped);
  }
  return [...byName.values()].slice(0, 50);
}
