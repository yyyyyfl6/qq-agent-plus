import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-notice-'));
process.env.QQ_AGENT_DATA_DIR = root;

const {
  parseGithubRepo, checkForUpdate, ignoreVersion, githubApiBase,
  parseVersion, compareVersions, readLocalVersion, readVersionAt
} = await import('../src/update-notice.js');
const { readAutoUpdateState } = await import('../src/auto-update.js');

after(() => fs.rmSync(root, { recursive: true, force: true }));

const CONFIG = {
  autoUpdate: {
    repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
    branch: 'main'
  }
};
const DEPLOYED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// 与 GitHub compare 一致：按时间正序（最早的在前），客户端展示时反转成"最新在上"。
const DELTA_COMMITS = [
  { sha: 'dddddddddddddddddddddddddddddddddddddddd', subject: '更早的一个提交' },
  { sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', subject: '中间的一个提交' },
  { sha: 'ffffffffffffffffffffffffffffffffffffffff', subject: '最新的一个提交' }
];
const RELEASE = {
  tag_name: 'v9.9.9',
  name: 'v9.9.9 —— 测试版本',
  body: '- 新增了某某功能\n- 修了某某问题',
  published_at: '2026-09-20T00:00:00Z',
  html_url: 'https://example.com/release',
  draft: false,
  prerelease: false
};

function caseDir(deployed = DEPLOYED) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  if (deployed) fs.writeFileSync(path.join(dir, 'deployed-revision'), `${deployed}\n`);
  return dir;
}

/** 假的 GitHub：/releases/latest 与 /compare/{base}...{head} 两条路由。 */
function fakeGitHub({
  release = RELEASE,
  releaseHttp = 200,
  compareHttp = 200,
  compareStatus = 'ahead',
  commits = DELTA_COMMITS
} = {}) {
  const impl = async (url) => {
    const target = String(url);
    impl.calls.push(target);
    if (/\/releases\/latest$/.test(target)) {
      if (releaseHttp !== 200) return { ok: false, status: releaseHttp, json: async () => null };
      return { ok: true, status: 200, json: async () => release };
    }
    if (/\/compare\//.test(target)) {
      if (compareHttp !== 200) return { ok: false, status: compareHttp, json: async () => null };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: compareStatus,
          total_commits: commits.length,
          commits: commits.map((item) => ({ sha: item.sha, commit: { message: `${item.subject}\n\n细节` } }))
        })
      };
    }
    return { ok: false, status: 404, json: async () => null };
  };
  impl.calls = [];
  return impl;
}

function compareCalls(github) {
  return github.calls.filter((url) => /\/compare\//.test(url)).length;
}

test('parses GitHub repository slugs', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b'), { owner: 'a', repo: 'b' });
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseGithubRepo(''), null);
});

test('reads the version of the deployment that is running', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(readLocalVersion(), String(pkg.version));
});

test('reads the version of an explicit app directory', () => {
  // 更新器按 --app-dir 读版本；这里直接覆盖那条路径，不依赖模块所在树
  const dir = fs.mkdtempSync(path.join(root, 'app-version-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(readVersionAt(dir), '1.2.3');
  assert.equal(readVersionAt(path.join(dir, 'missing')), '', '没有 package.json 时回落空串');
});

test('parses and compares release versions', () => {
  assert.deepEqual(parseVersion('v0.9.1'), { major: 0, minor: 9, patch: 1, prerelease: '' });
  assert.deepEqual(parseVersion('0.9.1-beta.1'), { major: 0, minor: 9, patch: 1, prerelease: 'beta.1' });
  assert.equal(parseVersion('nightly'), null);
  assert.equal(compareVersions('0.8.5', 'v0.9.1'), -1);
  assert.equal(compareVersions('v0.9.1', '0.9.1'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('9.9.9-beta.1', 'v9.9.9'), -1, '预发布低于同号正式版');
  assert.equal(compareVersions('9.9.9-beta.10', '9.9.9-beta.9'), 1, '预发布数字段按数值比');
  assert.equal(compareVersions('9.9.9-beta', '9.9.9-beta.1'), -1, '段数少的预发布更低');
  assert.equal(compareVersions('9.9.9-1', '9.9.9-alpha'), -1, '数字标识低于字母标识');
  assert.equal(compareVersions('nightly', 'v9.9.9'), null);
});

test('an older local version advertises the release without requesting compare', async () => {
  const dir = caseDir();
  // 故意让 compare 失败：判定根本不该走到那里（v0.8.5 跨版本时响应超过 1MB）
  const github = fakeGitHub({ compareHttp: 502 });
  const notice = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: '0.8.5'
  });

  assert.equal(notice.available, true);
  assert.equal(notice.reason, '');
  assert.equal(notice.version, 'v9.9.9', '版本号用 Release tag');
  assert.equal(notice.revision, 'v9.9.9', '目标是 tag 本身，不是 branch 上的提交');
  assert.equal(notice.localVersion, '0.8.5');
  assert.equal(notice.commitCount, 0, '不下载 1MB+ 的 compare diff 换一份提交列表');
  assert.equal(notice.name, RELEASE.name);
  assert.equal(notice.url, RELEASE.html_url);
  assert.match(notice.body, /【v9\.9\.9 发布说明】/);
  assert.equal(compareCalls(github), 0, '版本号已经说明旧了，不需要比较');
  const state = readAutoUpdateState(dir);
  assert.equal(state.updateNotice.available, true);
  assert.equal(state.updateNotice.version, 'v9.9.9');
});

test('the same version is "current", never a rollback', async () => {
  // 若误用 compare，'ahead' 会判成有新版本 —— 版本相等必须压住它
  const github = fakeGitHub({ compareStatus: 'ahead' });
  const same = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: '9.9.9'
  });
  assert.equal(same.available, false);
  assert.equal(same.reason, 'ahead-of-release');
  assert.equal(same.version, 'v9.9.9', '仍记录最新 Release，供面板说明');
  assert.equal(compareCalls(github), 0);

  const newer = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: '9.9.10'
  });
  assert.equal(newer.available, false);
  assert.equal(newer.reason, 'ahead-of-release');
  assert.equal(compareCalls(github), 0);
});

test('a local prerelease is older than the same stable release', async () => {
  const github = fakeGitHub();
  const notice = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: '9.9.9-beta.1'
  });
  assert.equal(notice.available, true);
  assert.equal(notice.reason, '');
  assert.equal(compareCalls(github), 0, '版本号能解析就不走 compare');
});

test('compare is only a fallback when the local version cannot be parsed', async () => {
  const github = fakeGitHub({ compareStatus: 'ahead' });
  const notice = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: 'nightly'
  });

  assert.equal(notice.available, true);
  assert.equal(notice.commitCount, DELTA_COMMITS.length, '兜底路径仍可列出提交');
  assert.match(notice.body, /最新的一个提交/);
  assert.ok(
    github.calls.some((url) => url.includes(`/compare/${DEPLOYED}...v9.9.9`)),
    '版本号解析不了时才比较「当前部署...Release tag」'
  );
});

test('the compare fallback tolerates a response larger than 512KB', async () => {
  // v0.8.5 → v0.9.1 的真实响应约 1.3MB（diff 的 files 占大头）；旧上限会抛 BODY_TOO_LARGE
  const padding = 'x'.repeat(1_500_000);
  const github = async (url) => {
    if (/\/releases\/latest$/.test(String(url))) {
      return new Response(JSON.stringify(RELEASE), { status: 200 });
    }
    return new Response(JSON.stringify({
      status: 'ahead',
      total_commits: DELTA_COMMITS.length,
      commits: DELTA_COMMITS.map((item) => ({ sha: item.sha, commit: { message: `${item.subject}\n\n细节` } })),
      files: [{ filename: 'big.js', patch: padding }]
    }), { status: 200 });
  };
  const notice = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: 'nightly'
  });
  assert.equal(notice.available, true);
  assert.equal(notice.commitCount, DELTA_COMMITS.length);
});

test('a failed comparison blocks only the unparseable-version fallback', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ compareHttp: 502 });
  const first = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: 'nightly'
  });

  assert.equal(first.available, false);
  assert.equal(first.reason, 'compare-failed');
  assert.equal(first.checkedAt, 0);
  assert.match(String(first.error), /502/);
  assert.equal(readAutoUpdateState(dir).updateNotice.available, false);

  // 版本号能解析时不受上次 compare 失败影响：仍然只看版本
  const callsAfterFirst = github.calls.length;
  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github, localVersion: '0.8.5' });
  assert.equal(second.cached, undefined);
  assert.equal(second.available, true);
  assert.ok(github.calls.length > callsAfterFirst);
});

test('a repository without any release never advertises an update', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ releaseHttp: 404 });
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(notice.available, false);
  assert.equal(notice.reason, 'no-release');
  assert.equal(notice.version, '');
  assert.equal(compareCalls(github), 0, '没有 Release 就不必比较');
  assert.ok(notice.checkedAt > 0, '“没有 Release”是稳定结论，可以缓存');
});

test('draft and prerelease builds are not advertised', async () => {
  const dir = caseDir();
  const draft = await checkForUpdate(dir, CONFIG, {
    fetchImpl: fakeGitHub({ release: { ...RELEASE, draft: true } }),
    force: true
  });
  assert.equal(draft.available, false);
  assert.equal(draft.reason, 'no-release');

  const prerelease = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: fakeGitHub({ release: { ...RELEASE, prerelease: true } }),
    force: true
  });
  assert.equal(prerelease.available, false);
  assert.equal(prerelease.reason, 'no-release');
});

test('an unknown deployment baseline is described but not advertised', async () => {
  const dir = caseDir('');
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: fakeGitHub(), force: true });

  assert.equal(notice.available, false);
  assert.equal(notice.reason, 'unknown-deployed');
  assert.equal(notice.version, 'v9.9.9', '面板要能告诉用户最新 Release 是哪个');
});

test('a failed release lookup is neither cached nor reported as "no release"', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ releaseHttp: 503 });
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(first.available, false);
  assert.equal(first.reason, 'unreachable');
  assert.equal(first.checkedAt, 0, '读不到就不写缓存，下次重试');
  assert.match(String(first.error), /GitHub 返回 503/);

  const callsAfterFirst = github.calls.length;
  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github });
  assert.equal(second.cached, undefined);
  assert.ok(github.calls.length > callsAfterFirst, '失败后下一次打开控制台应重试');
});

test('serves cached results within the TTL and refreshes once the baseline moves', async () => {
  const dir = caseDir();
  const github = fakeGitHub();
  const first = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: '9.9.9'
  });
  const callsAfterFirst = github.calls.length;

  const cached = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    now: Number(first.checkedAt) + 60_000,
    localVersion: '9.9.9'
  });
  assert.equal(cached.cached, true);
  assert.equal(github.calls.length, callsAfterFirst, '缓存命中时不请求 GitHub');

  // 基线变了（刚部署完）→ 立即重新检查
  fs.writeFileSync(path.join(dir, 'deployed-revision'), `${'1'.repeat(40)}\n`);
  const refreshed = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    now: Number(first.checkedAt) + 60_000,
    localVersion: '9.9.9'
  });
  assert.equal(refreshed.cached, undefined);
  assert.ok(github.calls.length > callsAfterFirst);
});

test('a changed local version invalidates the cached verdict', async () => {
  const dir = caseDir();
  const github = fakeGitHub();
  const first = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    force: true,
    localVersion: '9.9.9'
  });
  assert.equal(first.available, false);

  // 版本从"已是最新"变成"更旧"（手工替换源码没走 deploy.sh，deployed-revision 没变）：
  // 若仍命中缓存，就会漏掉真实更新；反过来则会回退领先的代码。
  const callsAfterFirst = github.calls.length;
  const second = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    now: Number(first.checkedAt) + 60_000,
    localVersion: '0.8.5'
  });
  assert.equal(second.cached, undefined, 'localVersion 也是缓存键');
  assert.equal(second.available, true);
  assert.ok(github.calls.length > callsAfterFirst, '版本变了必须重新检查');
});

test('the GitHub API base can be pointed elsewhere for tests and mirrors', () => {
  assert.equal(githubApiBase(), 'https://api.github.com');
  process.env.QQ_AGENT_GITHUB_API = 'http://127.0.0.1:9/api/';
  try {
    assert.equal(githubApiBase(), 'http://127.0.0.1:9/api', '去掉尾部斜杠');
  } finally {
    delete process.env.QQ_AGENT_GITHUB_API;
  }
});

test('ignores exactly one release tag at a time', () => {
  const dir = caseDir();
  assert.equal(ignoreVersion(dir, 'v9.9.9'), 'v9.9.9');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
  assert.equal(ignoreVersion(dir, ''), '', '空版本号不写入');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
});
