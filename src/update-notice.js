// 控制台「发现新版本」提示：以 GitHub 上「已发布的 Release」为唯一依据做只读检查。
//
// 口径（与部署链路共用，见 scripts/auto-update.mjs）：
//   - 只有作者发布了 Release（草稿、预发布都不算）才提示；branch 上的日常提交不提示，
//     避免用户装上未经发布的中间状态。
//   - 「有没有新版本」以版本号为主判定：本地 package.json 版本 >= Release 版本即视为已是最新，
//     本地更旧则直接提示有更新。两条路径都不请求 compare —— 跨版本的 compare 响应会超过 1MB
//     （diff 占大头），既有的 512KB 上限与 10 秒超时会让检查永久失败（2026-10-18 实测）。
//   - compare 只在版本号解析不了时兜底判方向；方向未知（比较接口失败）时既不提示也不部署。
//   - 版本号没升、部署提交却领先 Release（手工 dirty 部署）会判「已是最新」，这是有意为之：
//     宁可漏一次提示，也不能把领先的代码回退成 Release tag。
//
// 本模块不做任何部署；「立即更新」仍走既有的 /api/auto-update/run 链路，
// 由它按这里判定出的 Release tag 部署。
//
// 站点数据只写入 auto-update.json 的 updateNotice / ignoredVersion 两个键，
// 与自动更新的既有字段互不影响。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAutoUpdateState, writeAutoUpdateState } from './auto-update.js';
import { readJsonBounded } from './core/http-body.js';

const CHECK_TTL_MS = 30 * 60 * 1000;
const API_TIMEOUT_MS = 10000;
// compare 只作版本号解析不了时的兜底：响应含 diff 的 files 数组，跨版本会到 1.3MB 量级，
// 所以单独给它更大的上限与超时（正常判定路径根本不发这个请求）。
const COMPARE_TIMEOUT_MS = 60000;
const COMPARE_BODY_LIMIT = 4 * 1024 * 1024;
const REVISION_LENGTH = 64;
const BODY_LIMIT = 8000;
const API_BASE_DEFAULT = 'https://api.github.com';

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

/**
 * 解析版本号：接受 `v0.9.1`、`0.9.1`、`0.9.1-beta.1`（构建元数据忽略）。
 * 解析不了返回 null —— 调用方此时才退回 compare 兜底。
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(cleanText(value, 64));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || ''
  };
}

/** 预发布标识按 semver 比较：数字段按数值、数字低于字母、前缀相同则段数少的更低。 */
function comparePrerelease(left, right) {
  if (left === right) return 0;
  if (!left) return 1;  // 正式版高于同号预发布
  if (!right) return -1;
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;  // 数字标识低于字母标识
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 语义化比较：负数表示 left 更旧，0 相等，正数表示 left 更新；任一解析失败返回 null。 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 读取指定部署目录根的版本（`<appDir>/package.json`）；读不到返回空串。 */
export function readVersionAt(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    return cleanText(pkg?.version, 64);
  } catch {
    return '';
  }
}

/** 本机正在运行的版本：本模块所在部署目录根的 package.json。读不到返回空串。 */
export function readLocalVersion() {
  return readVersionAt(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
}

/**
 * GitHub API 基地址：默认 api.github.com。
 * QQ_AGENT_GITHUB_API 用于测试桩或自建镜像，普通部署不需要设置。
 */
export function githubApiBase() {
  const configured = cleanText(process.env.QQ_AGENT_GITHUB_API, 200);
  return (configured || API_BASE_DEFAULT).replace(/\/+$/, '');
}

function ghHeaders() {
  return { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-plus-console' };
}

async function fetchJson(url, fetchImpl, { timeoutMs = API_TIMEOUT_MS, maxBytes = 512 * 1024 } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: Number(res.status) || 0 };
    // 有界读：默认 512KB（2026-10-09 审查）；compare 兜底单独放宽，见 COMPARE_BODY_LIMIT
    const data = await readJsonBounded(res, maxBytes).catch(() => null);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 0, error: cleanText(error?.message, 200) };
  }
}

function httpFailure(result) {
  return result.status ? `GitHub 返回 ${result.status}` : (result.error || '请求失败');
}

/** 从仓库地址解析 GitHub owner/repo；非 github.com 返回 null。 */
export function parseGithubRepo(repository) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)$/i.exec(String(repository || '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

function apiUrl(slug, suffix) {
  return `${githubApiBase()}/repos/${slug.owner}/${slug.repo}${suffix}`;
}

/** 部署基线：deploy.sh 写入的 data/deployed-revision，缺失时退回状态文件里的记录。 */
export function deployedRevisionAt(dataDir, state = null) {
  try {
    // deploy.sh 在源码树有未提交改动时会写 "<sha>-dirty"；带上它去调 GitHub compare 会 404，
    // 表现为更新检查永久 compare-failed（静默失效）。与 scripts/auto-update.mjs 口径一致地剥掉。
    const revision = cleanText(fs.readFileSync(path.join(dataDir, 'deployed-revision'), 'utf8'), REVISION_LENGTH)
      .replace(/-dirty$/, '');
    if (revision) return revision;
  } catch { /* 从未部署过 */ }
  return cleanText(state?.currentRevision, REVISION_LENGTH);
}

/**
 * 取 GitHub 最新 Release（公开仓库无需令牌）。
 * 只返回「已发布」的正式版本：草稿与预发布都不在 /releases/latest 里。
 * 返回 { published: false }（仓库还没有 Release）、{ published: true, release } 或 { failed: true }。
 */
export async function fetchLatestRelease(repository, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug) return { published: false };
  const result = await fetchJson(apiUrl(slug, '/releases/latest'), fetchImpl);
  if (!result.ok) {
    // 404 = 仓库还没有发布过 Release；其余（限流、网络、5xx）都算读取失败
    if (result.status === 404) return { published: false };
    return { failed: true, error: httpFailure(result) };
  }
  const data = result.data;
  if (!data || typeof data !== 'object' || data.draft === true || data.prerelease === true) {
    return { published: false };
  }
  return {
    published: true,
    release: {
      version: cleanText(data.tag_name, 64),
      name: cleanText(data.name, 200),
      body: cleanText(data.body, BODY_LIMIT),
      publishedAt: Date.parse(data.published_at) || 0,
      url: cleanText(data.html_url, 500)
    }
  };
}

/**
 * 比较「部署基线..发布版本」，失败时带上原因。
 * GitHub 的 status 描述的是 head 相对 base 的关系：
 * ahead = 发布版本领先（有更新）、behind / identical = 当前部署已包含该版本、
 * diverged = 两条线各自都有提交。
 */
export async function fetchComparison(repository, base, head, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const slug = parseGithubRepo(repository);
  if (!slug || !base || !head) return { ok: false, commits: [], error: '缺少比较参数' };
  const result = await fetchJson(
    apiUrl(slug, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
    fetchImpl,
    { timeoutMs: COMPARE_TIMEOUT_MS, maxBytes: COMPARE_BODY_LIMIT }
  );
  if (!result.ok) return { ok: false, commits: [], error: httpFailure(result) };
  const data = result.data;
  if (!data || !Array.isArray(data.commits)) {
    return { ok: false, commits: [], error: '比较结果无法解析' };
  }
  const commits = data.commits
    .map((item) => ({
      sha: cleanText(item?.sha, REVISION_LENGTH),
      subject: cleanText(item?.commit?.message, 200).split('\n')[0].trim()
    }))
    .filter((item) => item.sha && item.subject)
    // GitHub 按时间正序返回；展示时让最新的在最上面。
    .reverse();
  return {
    ok: true,
    commits,
    total: Number(data.total_commits) || commits.length,
    status: String(data.status || '')
  };
}

/**
 * 检查是否有新的已发布版本。成功结果缓存 30 分钟；部署基线变化（例如刚更新完）立即失效；
 * 连不上 GitHub 或无法判定方向时不写缓存，下次打开控制台会重试。
 *
 * 判定顺序：版本号（主）→ compare（仅在版本号解析不了时兜底）。
 * 版本号相等也按「已是最新」处理：版本没升却领先 Release 的部署不能回退。
 */
export async function checkForUpdate(
  dataDir,
  config = {},
  { force = false, now = Date.now(), fetchImpl, localVersion } = {}
) {
  const settings = config.autoUpdate || {};
  const repository = String(settings.repository || '').trim();
  const branch = String(settings.branch || 'main').trim() || 'main';
  const state = readAutoUpdateState(dataDir);
  const previous = state.updateNotice && typeof state.updateNotice === 'object' ? state.updateNotice : null;
  const deployedNow = deployedRevisionAt(dataDir, state);
  const local = localVersion !== undefined ? cleanText(localVersion, 64) : readLocalVersion();

  if (!repository) {
    return { available: false, reason: 'unconfigured', checkedAt: now, deployed: deployedNow, localVersion: local };
  }
  const fresh = previous && Number(previous.checkedAt) > 0
    && now - Number(previous.checkedAt) < CHECK_TTL_MS;
  const baselineUnchanged = previous && String(previous.deployed || '') === String(deployedNow || '');
  // 版本号现在是主判定，必须进缓存键：手工替换源码（版本变了、deployed-revision 没变，
  // 或只写了 "-dirty" 被剥掉）时若命中旧结论，会把"已是最新"的树回退成 Release tag。
  // 旧版本写的 notice 没有 localVersion 字段，这里也会自然失效、重算一次。
  const localUnchanged = previous && String(previous.localVersion || '') === local;
  if (!force && fresh && baselineUnchanged && localUnchanged) {
    return { ...previous, localVersion: local, cached: true };
  }

  const base = {
    repository,
    branch,
    deployed: deployedNow,
    localVersion: local,
    revision: '',
    version: '',
    name: '',
    body: '',
    commitCount: 0,
    publishedAt: 0,
    url: '',
    checkedAt: now,
    error: ''
  };
  const store = (notice) => {
    writeAutoUpdateState(dataDir, { updateNotice: notice });
    return notice;
  };

  const latest = await fetchLatestRelease(repository, { fetchImpl });
  if (latest.failed) {
    // 读不到 Release 列表（限流 / 网络 / 5xx）：不猜，不写缓存，下次打开控制台重试
    return store({
      ...base,
      available: false,
      reason: 'unreachable',
      checkedAt: 0,
      error: `无法读取 GitHub Releases：${latest.error}`
    });
  }
  if (!latest.published || !latest.release?.version) {
    // 仓库还没有发布过 Release：不提示（也不想让用户去装 branch 上的中间提交）
    return store({ ...base, available: false, reason: 'no-release' });
  }
  const release = latest.release;
  const releaseInfo = {
    version: release.version,
    name: release.name || '',
    body: release.body || '',
    publishedAt: release.publishedAt || 0,
    url: release.url || ''
  };

  if (!deployedNow) {
    // 部署基线不是 git 提交（例如压缩包安装），无法判断方向：不弹窗，只在面板里说明
    return store({ ...base, ...releaseInfo, available: false, reason: 'unknown-deployed' });
  }

  // 主判定：版本号。两个版本都能解析时不发 compare —— 跨版本的 compare 响应超过 1MB
  // （diff 的 files 占大头），旧的上限下必然失败，而这里多数时候并不需要那份 diff。
  const order = compareVersions(local, release.version);
  if (order !== null) {
    if (order >= 0) {
      // 相等也按「已包含」：版本没升、提交却领先 Release 的手工部署不能回退成 tag
      return store({ ...base, ...releaseInfo, available: false, reason: 'ahead-of-release' });
    }
    return store({
      ...base,
      ...releaseInfo,
      available: true,
      reason: '',
      revision: release.version,
      // 精确的提交列表要下载 1MB+ 的 compare diff，不值得为展示付这个代价；
      // 发布说明本身已经说明改了什么
      body: releaseInfo.body ? `【${release.version} 发布说明】\n${releaseInfo.body}` : ''
    });
  }

  // 版本号解析不了（非标准安装）：退回 compare 兜底判定方向
  const compare = await fetchComparison(repository, deployedNow, release.version, { fetchImpl });
  if (!compare.ok) {
    // 方向未知：既不提示也不允许部署，且不写缓存（下次打开控制台重试）
    return store({
      ...base,
      ...releaseInfo,
      available: false,
      reason: 'compare-failed',
      checkedAt: 0,
      error: `无法比较当前版本与该 Release：${compare.error || 'GitHub 比较接口不可用'}`
    });
  }

  const status = String(compare.status || '');
  if (status === 'behind' || status === 'identical') {
    return store({
      ...base,
      ...releaseInfo,
      available: false,
      reason: status === 'behind' ? 'ahead-of-release' : ''
    });
  }

  // status 为 ahead / diverged（或未给出状态但有差异）：发布版本领先，有更新
  const commits = compare.commits.map((item) => `- ${item.subject}`).join('\n');
  const body = [
    releaseInfo.body ? `【${release.version} 发布说明】\n${releaseInfo.body}` : '',
    commits ? `【本次包含的提交】\n${commits}` : ''
  ].filter(Boolean).join('\n\n');
  return store({
    ...base,
    ...releaseInfo,
    available: true,
    reason: '',
    revision: release.version,
    body,
    commitCount: Number(compare.total) || compare.commits.length
  });
}

/** 「忽略这个版本」：只屏蔽该 Release tag；出现更新版本时照常提示。 */
export function ignoreVersion(dataDir, version) {
  const clean = cleanText(version, 64);
  if (!clean) return '';
  writeAutoUpdateState(dataDir, { ignoredVersion: clean });
  return clean;
}
