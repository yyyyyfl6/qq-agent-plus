// 官方插件：GitHub 仓库动态。
//
// 群里最常问的一类问题："XX 项目还在维护吗""最近有什么动静"。这个插件把它变成一个工具：
// 模型可以问某个仓库最近的提交、issue、star 数，然后用自己的话讲给群里听。
//
// 为什么选它当官方插件之一：
//   · 数据源是 GitHub 公开 API，不需要任何 Key（未认证有速率限制，个人使用足够）；
//   · 只有只读查询，不涉及写操作；
//   · 正好演示"插件把上游数据整理成人话"这件事 —— 不是把 JSON 原样倒给模型。
//
// 配置（可选）：plugins.settings.gh-activity.perPage，默认取 5 条（1-20）。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const API = 'https://api.github.com';
let settings = {};
let requestSeq = 0;
const pending = new Map();

const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

/** 经宿主发一个 GET（那条路有内网拦截、体积上限、超时与审计）。 */
async function getJson(url) {
  const result = await callHost('cap.http.request', { url, method: 'GET' });
  const status = Number(result?.status) || 0;
  const text = String(result?.body ?? '');
  if (status === 404) return { notFound: true };
  if (status !== 200) {
    return { error: `GitHub 返回 HTTP ${status || '?'}${status === 403 ? '（未认证的请求有速率限制，等一会儿再试）' : ''}` };
  }
  try { return { data: JSON.parse(text) }; } catch {
    // 宿主的 cap.http 会把响应体截到 40000 字符：issue 正文很长的仓库（microsoft/vscode、
    // facebook/react）列表响应会超过它，JSON 从中间断掉 —— 这不是"返回了 HTML"，要说准
    if (text.length >= 40000) return { error: '响应超过宿主的 40000 字符取值上限被截断（这个仓库的正文较长）' };
    return { error: 'GitHub 返回的不是 JSON（可能是被拦截或限频的页面）' };
  }
}

/** 仓库名要能容错：接受 `owner/repo`、完整 URL、以及结尾带 .git 的写法。 */
function parseRepo(input) {
  const text = String(input || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(text);
  return match ? { owner: match[1], repo: match[2] } : null;
}

const relativeTime = (iso) => {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
};

const tools = {
  async repo_activity(args) {
    const parsed = parseRepo(args?.repo);
    if (!parsed) return { error: '仓库要写成 owner/repo（例如 torvalds/linux）' };
    const perPage = Math.max(1, Math.min(20, Number(settings.perPage) || 5));
    const base = `${API}/repos/${parsed.owner}/${parsed.repo}`;
    const info = await getJson(base);
    if (info.notFound) return { error: `找不到仓库 ${parsed.owner}/${parsed.repo}（拼错？或它不公开）` };
    if (info.error) return { error: info.error };
    const commits = await getJson(`${base}/commits?per_page=${perPage}`);
    // ⚠️ `/issues` 返回的是 issue **和 PR**：只取 perPage 条再过滤 PR，在 PR 活跃的仓库里
    // 可能一条 issue 都不剩（facebook/react 就是典型）。所以按 3 倍开窗（上限 100）再过滤。
    let issues = await getJson(`${base}/issues?state=open&per_page=${Math.min(100, perPage * 3)}&sort=updated`);
    // 窗口开大是为了穿过 PR（见下），但正文很长的仓库会因此撞上宿主取值上限、JSON 被截断 ——
    // 这时退回 perPage 再试一次，至少有东西可看
    if (issues.error) issues = await getJson(`${base}/issues?state=open&per_page=${perPage}&sort=updated`);
    const repo = info.data || {};
    return {
      repo: `${repo.full_name || `${parsed.owner}/${parsed.repo}`}`,
      description: String(repo.description || '').slice(0, 200),
      stars: repo.stargazers_count ?? null,
      forks: repo.forks_count ?? null,
      openIssues: repo.open_issues_count ?? null,
      language: repo.language || '',
      pushedAt: repo.pushed_at || '',
      pushedAgo: relativeTime(repo.pushed_at),
      archived: repo.archived === true,
      commits: Array.isArray(commits.data) ? commits.data.map((entry) => ({
        sha: String(entry.sha || '').slice(0, 7),
        message: String(entry.commit?.message || '').split('\n')[0].slice(0, 120),
        author: String(entry.commit?.author?.name || entry.author?.login || ''),
        at: entry.commit?.author?.date || '',
        ago: relativeTime(entry.commit?.author?.date)
      })) : [],
      openIssueTitles: Array.isArray(issues.data)
        ? issues.data.filter((entry) => !entry.pull_request).map((entry) => `#${entry.number} ${String(entry.title || '').slice(0, 100)}`).slice(0, perPage)
        : [],
      // 子请求失败时不能静默给空数组：模型会把"没查到"讲成"没有提交 / 没有 issue"
      partial: Boolean(commits.error || issues.error),
      note: '数字与时间来自 GitHub 公开 API 的即时查询。'
        + [commits.error ? `最近提交没取到：${commits.error}` : '', issues.error ? `issue 列表没取到：${issues.error}` : '']
          .filter(Boolean).join('；')
    };
  }
};

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message?.method === 'callTool') {
        const fn = tools[message.params?.name];
        if (!fn) send({ id: message.id, error: { code: 'E_NO_TOOL', message: `没有这个工具：${message.params?.name}` } });
        else {
          Promise.resolve()
            .then(() => fn(message.params?.args ?? {}))
            .then((result) => send({ id: message.id, result }))
            .catch((error) => send({ id: message.id, error: { code: 'E_TOOL', message: String(error?.message || error) } }));
        }
      } else if (message?.method === 'init') {
        settings = message.params?.settings && typeof message.params.settings === 'object' ? message.params.settings : {};
        send({ id: message.id, result: { ok: true } });
      } else if (message?.method === 'ping') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'schedule') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'shutdown') {
        send({ id: message.id, result: {} });
        setTimeout(() => process.exit(0), 10);
      } else if (message?.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});
