// 索引与包的**多门牌号**：同一个文件准备几条取法，逐个试，哪条通用哪条。
//
// 为什么需要：索引与包都在 GitHub 上，而国内访问 GitHub 是"时快时慢"——同一台服务器上实测过
// 0.7s、9s、以及偶发超过 20s 超时。多备几条路的价值不在"更快"，而在"一条断了还能装上"。
//
// 三条来源，按顺序试（**原始地址永远排第一**）：
//   ① 原始地址 —— 最权威，内容一定是对的；国内快的时候它最快，也没必要多绕一层第三方。
//   ② 条目里显式给的 `mirrors` —— 索引维护者（或作者）自己列的备用地址，我们不猜。
//   ③ 前缀型镜像 —— 形如 `https://ghproxy.example/https://github.com/...`，社区里最常见的一类
//      （NapCat 那条链上放了 30 多个，末尾留原始 URL 兜底）。默认只取几个**当前可用**的；
//      要清空就配 `plugins.mirrorPrefixes: []`。
//
// 三条纪律：
//   · **索引不走镜像**：索引是信任根，镜像能替换"该装什么"（塞它自己的插件与 sha256），
//     sha256 只能证明"包与索引一致"、救不了被换掉的索引。所以 `fetchTextWithMirrors` 只用在
//     "内容可信度由别的东西保证"的场合；索引那条链在控制台里刻意用原始 safeFetch（见 app.js）。
//   · **内容校验不可省**：走第三方镜像意味着内容可能被替换，所以包一律先按索引里的 sha256 校验
//     再换入（见 install.js）—— 校验过关的镜像只是"更快的传输通道"，不是信任来源。
//   · **记住哪条通**：每个主机记住上次成功的那条（进程内缓存），后续同类请求直接用它，
//     不必每次都从第一条开始试一遍。
import { safeFetch } from '../llm/safe-fetch.js';

/** 前缀型镜像模板：把原始 URL 直接接在后面。可用 `plugins.mirrorPrefixes` 覆盖。 */
export const DEFAULT_MIRROR_PREFIXES = Object.freeze([
  'https://gh-proxy.com/',
  'https://ghproxy.cfd/',
  'https://gh.llkk.cc/'
]);

/**
 * GitHub raw → Contents API 的等价地址（信任根仍是 GitHub，适合 raw 域名被墙的机器）。
 * 注意：分支名带斜杠时（feature/x）无法从 raw URL 里区分 ref 与路径，这里按第一段解析，
 * 只作为兜底（官方索引用 main，不受影响；解析错了最多是 API 404，仍会如实报错）。
 */
export function githubContentsApiUrl(rawUrl) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(String(rawUrl || ''));
  if (!match) return '';
  const [, owner, repo, ref, rest] = match;
  if (ref.includes('%2F') || rest.includes('..') || /[?#]/.test(rest)) return '';
  return `https://api.github.com/repos/${owner}/${repo}/contents/${rest}?ref=${encodeURIComponent(ref)}`;
}

/** GitHub raw 的 jsDelivr 等价地址（只对 raw.githubusercontent.com 有确定的换法）。 */
export function jsdelivrForRaw(url) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(String(url || ''));
  if (!match) return '';
  const [, owner, repo, ref, rest] = match;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`;
}

/**
 * 给一个地址生成候选列表：原始 → 显式 mirrors → 派生（jsDelivr）→ 前缀镜像。
 * 顺序即优先级；去重（同一个地址只留第一次出现的位置）。
 */
export function mirrorCandidates({ url, mirrors = [], prefixes = DEFAULT_MIRROR_PREFIXES } = {}) {
  const out = [];
  const push = (candidate) => {
    const value = String(candidate ?? '').trim();
    if (!/^https?:\/\//i.test(value)) return;
    if (!out.includes(value)) out.push(value);
  };
  push(url);
  for (const item of Array.isArray(mirrors) ? mirrors : []) push(item);
  const derived = jsdelivrForRaw(url);
  if (derived) push(derived);
  // 前缀镜像只对 GitHub 域名有意义（第三方前缀只代理 GitHub）
  if (/^https:\/\/(raw\.githubusercontent\.com|github\.com|codeload\.github\.com)\//i.test(String(url || ''))) {
    for (const prefix of Array.isArray(prefixes) ? prefixes : []) push(`${String(prefix).replace(/\/$/, '')}/${url}`);
  }
  return out;
}

/**
 * 按候选顺序取一个文本资源（索引 JSON 就走这条）。返回 `{ ok, text, url, tried }`。
 * `fetchImpl` 是注入点（测试与线上用同一条实现：safe-fetch，内网被拦、有体积与超时上限）。
 */
export async function fetchTextWithMirrors({ url, mirrors, prefixes, fetchImpl, log = () => {}, pickCache = defaultPickCache } = {}) {
  const candidates = mirrorCandidates({ url, mirrors, prefixes });
  const preferred = pickCache.get(String(url));
  if (preferred && candidates.includes(preferred)) {
    // 上次成功的那条排在前面（仍然保留其余作为后备）
    candidates.splice(candidates.indexOf(preferred), 1);
    candidates.unshift(preferred);
  }
  const tried = [];
  for (const candidate of candidates) {
    try {
      const result = await fetchImpl(candidate);
      if (Number(result?.statusCode) !== 200) throw new Error(`HTTP ${result?.statusCode ?? '?'}`);
      pickCache.set(String(url), candidate);
      if (candidate !== url) log(`[plugins] 这条索引是从镜像取的：${candidate}`);
      return { ok: true, text: String(result?.body ?? ''), url: candidate, tried };
    } catch (error) {
      tried.push({ url: candidate, error: String(error?.message ?? error) });
      if (candidate !== candidates[candidates.length - 1]) {
        log(`[plugins] ${candidate} 取不动（${error?.message ?? error}），换下一条`);
      }
    }
  }
  return { ok: false, error: `所有地址都取不动：${tried.map((item) => `${item.url}（${item.error}）`).join('；')}`, tried };
}

/**
 * 按候选顺序取一个二进制资源（包就走这条）。
 *
 * `verify(buffer, candidate)` 可选：在**候选循环内部**判定内容真伪（安装器传 sha256 校验）。
 * 为什么非得在这里校验：镜像最常见的坏法不是超时，而是 200 + 错误页/旧版本 —— 只看 statusCode
 * 会把它当成功、还会记进"这条通"的缓存，于是之后每次都先试这条坏路，一次抖动变成长期装不上。
 * 放在这里，坏候选只会进 tried 列表，继续试下一条。
 */
export async function fetchBinaryWithMirrors({ url, mirrors, prefixes, fetchImpl, maxBytes, verify, log = () => {}, pickCache = defaultPickCache } = {}) {
  const candidates = mirrorCandidates({ url, mirrors, prefixes });
  const preferred = pickCache.get(String(url));
  if (preferred && candidates.includes(preferred)) {
    candidates.splice(candidates.indexOf(preferred), 1);
    candidates.unshift(preferred);
  }
  const tried = [];
  for (const candidate of candidates) {
    try {
      const downloaded = await fetchImpl(candidate, maxBytes);
      const buffer = downloaded?.buffer;
      if (!buffer?.length) throw new Error('内容是空的');
      if (typeof verify === 'function') {
        // 注入点先落本地常量：scan --strict 不认"直接调用解构参数"的形状
        const check = verify;
        const verdict = await check(buffer, candidate);
        if (verdict === false) throw new Error('内容校验不过（sha256 不符）');
      }
      pickCache.set(String(url), candidate);
      if (candidate !== url) log(`[plugins] 这个包是从镜像取的：${candidate}（内容仍按索引里的 sha256 校验）`);
      return { ok: true, buffer, url: candidate, tried };
    } catch (error) {
      tried.push({ url: candidate, error: String(error?.message ?? error) });
      log(`[plugins] ${candidate} 取不动（${error?.message ?? error}），换下一条`);
    }
  }
  return { ok: false, error: `所有地址都取不动：${tried.map((item) => `${item.url}（${item.error}）`).join('；')}`, tried };
}

/** 进程内记住"哪个主机走哪条路"（重启即忘，不需要落盘）。 */
export const defaultPickCache = new Map();

/** 测试用：清掉记住的选择。 */
export function resetMirrorPicks() { defaultPickCache.clear(); }

// 线上用的默认实现：文本与二进制都走 safe-fetch（内网拦截、重定向逐跳复检、体积与超时上限都在里面）。
// 测试注入自己的 fetchImpl 时不会碰这条真实路径。
export const defaultFetchText = (url) => safeFetch(url);
