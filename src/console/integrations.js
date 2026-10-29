import { readJsonBounded } from '../core/http-body.js';

/**
 * 服务端探测协议端 WebUI 用的地址。
 *
 * 与 SNOWLUMA_WEBUI_URL 分开：后者是给**宿主机浏览器**的链接（容器部署时是
 * 127.0.0.1:5099），而容器内的 Agent 要探的是 compose 网络里的 snowluma:5099。
 * 两者混用会造成"控制台显示协议端离线，但浏览器能打开"的假故障。
 */
export function snowlumaApiBase(env = process.env) {
  return String(
    env.SNOWLUMA_INTERNAL_URL
    || env.SNOWLUMA_WEBUI_URL
    || 'http://127.0.0.1:5099'
  ).replace(/\/+$/, '');
}

// Linux 全栈部署的 SnowLuma / noVNC 端口是 5099 / 6081，上游旧默认值 15099 / 16081 会导致状态误报
const DEFAULT_ENDPOINTS = Object.freeze({
  dsh: process.env.DSH_URL || 'http://127.0.0.1:3080/',
  bridge: process.env.BRIDGE_URL || 'http://127.0.0.1:3100/api/status',
  snowluma: `${snowlumaApiBase()}/api/ui/public`,
  novnc: process.env.QQ_AGENT_NOVNC_URL || 'http://127.0.0.1:6081/'
});

// 旧架构（qq-bridge / DSH）不在本仓库的部署栈里（见 docs/LINUX.md），部署脚本也不会起它们。
// 没通过环境变量指端点时标记成"未部署"：控制台不再把它们显示成终年「不可达」的故障，
// 密钥控制里那条指向旧控制台的入口也一并收起。指了端点（迁移期并存、或显式接管）就照旧探测。
const LEGACY_ENV_BY_ID = Object.freeze({ dsh: 'DSH_URL', bridge: 'BRIDGE_URL' });

function legacyFlags(id, endpoints) {
  const envName = LEGACY_ENV_BY_ID[id];
  if (!envName) return { optional: false, configured: true };
  // 调用方显式传了别的端点（测试、或将来做多地址）也算"配置过"
  const configured = Boolean(process.env[envName]) || endpoints[id] !== DEFAULT_ENDPOINTS[id];
  return { optional: true, configured };
}

export const SNOWLUMA_WEBUI_URL = String(
  process.env.SNOWLUMA_WEBUI_URL || 'http://127.0.0.1:5099'
).replace(/\/+$/, '');
// 服务端调用（状态探测、改密钥）走这个；没有单独配置时与浏览器链接同源。
export const SNOWLUMA_API_URL = snowlumaApiBase();

async function responseJson(response) {
  try {
    // 有界读（1MB）：集成端点响应本应很小，超限按解析失败处理（2026-10-09 审查）
    return await readJsonBounded(response, 1024 * 1024);
  } catch {
    return {};
  }
}

function integrationError(message, httpStatus = 502) {
  return Object.assign(new Error(message), { httpStatus });
}

async function probe(fetchFn, url) {
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(2_500)
    });
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  }
}

export async function integrationStatus({
  fetchFn = fetch,
  endpoints = DEFAULT_ENDPOINTS
} = {}) {
  const checks = await Promise.all(
    Object.entries(endpoints).map(async ([id, url]) => ({
      id,
      online: await probe(fetchFn, url),
      ...legacyFlags(id, endpoints)
    }))
  );

  return {
    checkedAt: Date.now(),
    services: [
      { id: 'agent', online: true },
      ...checks
    ]
  };
}

export async function updateSnowLumaPassword({
  currentPassword,
  newPassword,
  confirmPassword,
  fetchFn = fetch,
  baseUrl = SNOWLUMA_API_URL
}) {
  const current = String(currentPassword ?? '');
  const next = String(newPassword ?? '');
  const confirm = String(confirmPassword ?? '');

  if (!current) throw integrationError('请输入当前 SnowLuma 密钥', 400);
  if (next !== confirm) throw integrationError('两次输入的新密钥不一致', 400);
  if (
    next.length < 10
    || !/[a-z]/.test(next)
    || !/[A-Z]/.test(next)
    || !/[^A-Za-z0-9\s]/.test(next)
    || /\s/.test(next)
  ) {
    throw integrationError(
      '新密钥至少 10 位，且需包含大小写字母和特殊符号',
      400
    );
  }
  if (current === next) throw integrationError('新密钥不能与当前密钥相同', 400);

  let login;
  try {
    login = await fetchFn(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: current }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw integrationError('SnowLuma WebUI 不可达');
  }

  const loginBody = await responseJson(login);
  if (loginBody.needsTotp) {
    throw integrationError(
      'SnowLuma 已启用二次验证，请在 SnowLuma WebUI 内修改密钥',
      409
    );
  }
  if (!login.ok || loginBody.success !== true) {
    throw integrationError(
      login.status === 401 ? '当前 SnowLuma 密钥不正确' : 'SnowLuma 登录验证失败',
      login.status === 401 ? 403 : 502
    );
  }
  if (!loginBody.token) throw integrationError('SnowLuma 未返回登录会话');

  let changed;
  try {
    changed = await fetchFn(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${loginBody.token}`
      },
      body: JSON.stringify({
        oldPassword: current,
        newPassword: next
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw integrationError('SnowLuma 密钥更新请求失败');
  }

  const changedBody = await responseJson(changed);
  if (!changed.ok || changedBody.success !== true) {
    throw integrationError(
      String(changedBody.message || 'SnowLuma 密钥更新失败'),
      changed.status >= 400 && changed.status < 500 ? changed.status : 502
    );
  }

  return { ok: true };
}
