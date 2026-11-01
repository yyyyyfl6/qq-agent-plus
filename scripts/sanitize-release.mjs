#!/usr/bin/env node
// 生成可分享的干净副本 + 敏感串扫描。
//
// 只复制 git 已跟踪的文件（data/、config.json、.console-tunnel.cfg、_staging 等
// 天然不会进入副本），然后在副本里扫描常见的敏感残留：
//   - 长十六进制串（控制台令牌形态）、"Token:" 开头的行
//   - sk- / ghp_ 之类的密钥前缀
//   - 非私网、非文档示例的公网 IPv4
//   - 非 noreply 的邮箱地址
//   - 本机个人串（QQ 号、域名、业务标识……）：值放在 data/sanitize-patterns.json
//     （一个 JSON 字符串数组，data/ 本来就不进版本库，所以仓库里只有机制、没有值）。
//     2026-09-21 加：用例里写了一次真管理员 QQ，扫描器当时不认这类号，发布了才被发现。
//
// 用法：
//   node scripts/sanitize-release.mjs                 # 输出到 ../qq-agent-clean
//   node scripts/sanitize-release.mjs --out=/tmp/x    # 指定输出目录
//   node scripts/sanitize-release.mjs --force         # 输出目录已存在时覆盖
// 退出码：0 = 副本已生成且扫描干净；1 = 有发现或参数/环境有问题。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = path.resolve(outArg ? outArg.slice('--out='.length) : path.join(ROOT, '..', 'qq-agent-clean'));
const FORCE = args.includes('--force');

const PRIVATE_IPV4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|255\.)/;
const DOC_IPV4 = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;
const SAFE_EMAIL = /(@users\.noreply\.github\.com$|@example\.(com|org|net)$)/i;
// 图片/压缩包的魔数前缀、以及 aaaa…/0000… 这类低熵串不算令牌。
const BINARY_MAGIC = /^(89504e47|ffd8ff|47494638|504b0304)/i;
const LOW_ENTROPY = (value) => new Set(value.toLowerCase()).size <= 3;
// IPv4 只在「URL / ssh 目标 / 主带端口」的语境下算泄露迹象；
// 裸的 1.2.3.4 可能是版本号（例如微信 3.9.12.51），不报。
const IPV4_CONTEXT = /(?:\b(?:https?|ssh|git|ftp):\/\/|@)(\d{1,3}(?:\.\d{1,3}){3})\b|\b(\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/g;

// 通用示例不算泄露：文档里出现 /home/user、/home/ubuntu、C:\Users\user 这类占位是正常的。
// qqagent 是部署文档里自己建的服务账号（adduser qqagent），不算本机个人目录。
const EXAMPLE_USER_PATH = /(?:\/(?:home|Users)\/(?:user|ubuntu|deploy|sourcecode|example|qqagent|<[^>]+>)|[A-Za-z]:\\Users\\(?:user|public|Public|example|<[^>]+>))/i;

/**
 * 本机个人串：`data/sanitize-patterns.json` 里写一个字符串数组。
 * 只读本地文件，不写进仓库、也不打印原值（命中时打码）—— 这份输出经常被贴到 issue 里。
 */
let personalPatternsNotice = '';

function loadPersonalPatterns() {
  const file = path.join(ROOT, 'data', 'sanitize-patterns.json');
  // 缺失/坏清单都要留一句话提醒：data/ 整个被 gitignore，新克隆必然没有这份清单，
  // 静默空转会让"个人串"这一类扫描在别人的机器上永远不生效而无人察觉。
  if (!fs.existsSync(file)) {
    personalPatternsNotice = 'data/sanitize-patterns.json 不存在，「个人串」扫描器没有清单可查、已空转（新克隆的正常现象；本机部署请自行维护这份清单）。';
    return [];
  }
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) {
      personalPatternsNotice = 'data/sanitize-patterns.json 不是字符串数组，「个人串」扫描器已空转。';
      return [];
    }
    return list.map((item) => String(item).trim()).filter((item) => item.length >= 4);
  } catch {
    personalPatternsNotice = 'data/sanitize-patterns.json 读取失败，「个人串」扫描器已空转。';
    return [];
  }
}

const SCANNERS = [
  {
    name: '长十六进制串（疑似令牌）', re: /\b[0-9a-f]{40,}\b/gi,
    // GitHub Actions 的 action 固定版本（uses: owner/action@<40 位 SHA>）与测试里的 sha256 基准值
    // 都是**非敏感**的十六进制串。不豁免它们，工具每次都以"发现 6 处"退出 1 并删掉刚生成的副本 ——
    // 恒假的闸门等于没有闸门（2026-10-13 全项目审查 P2）。
    allow: (raw, text, rel) => {
      const lines = text.split('\n').filter((line) => line.includes(raw));
      return lines.length > 0 && lines.every((line) => /uses:\s*[^\s@]+@[0-9a-f]{40}/i.test(line)
        // 固定版本/哈希常量，以及 JSON 里的校验和字段（`"sha256": "<64 位 hex>"`）：
        // **字段名/变量名自证它不是秘密**。索引文件是硬需求 —— 插件索引每条都必须带 sha256，
        // 不豁免这一条，每次发版都会恒假报红（2026-10-16 插件索引落地时踩到）。
        || /["']?(?:COMMIT|SHA|HASH|CHECKSUM|DIGEST|REVISION)\w*["']?\s*[:=]\s*["']?[0-9a-f]{40,}["']?/i.test(line)
        // 测试里整行就是一个 sha256 基准值、或断言行里带 sha256（`assert.equal(x.sha256, '<hex>')`）：
        // **只在 test/ 下**豁免。不加文件限定的话，任何"一行就是一个 64 位十六进制"的地方
        // （比如 JSON 数组里的真实 32 字节密钥）会跟着一起放行，闸门等于漏了（2026-10-14 复审 P3）。
        || (/^test[\\/]/.test(rel)
          && (/sha256/i.test(line) || /^[\s'"`\[]*[0-9a-f]{64}[\s'"`,;\]]*$/i.test(line.trim()))));
    }
  },
  { name: '本机真实用户目录', re: /(?:\/(?:home|Users)\/[A-Za-z0-9._-]{2,}|[A-Za-z]:\\Users\\[^\\\s"']{2,})/g , filter: (hit) => !EXAMPLE_USER_PATH.test(hit) },
  { name: 'Token: 行', re: /^\s*Token\s*[:=]\s*["']?[0-9a-f]{16,}["']?\s*$/gim },
  { name: 'API 密钥前缀', re: /\b(sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g },
  { name: '公网 IPv4', re: null },
  { name: '非 noreply 邮箱', re: null },
  { name: '个人串（data/sanitize-patterns.json）', list: loadPersonalPatterns() }
];

function listTrackedFiles() {
  const raw = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function copyTracked(files) {
  let copied = 0;
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    const dst = path.join(OUT, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied += 1;
  }
  return copied;
}

function scanFile(rel, text) {
  const findings = [];
  for (const scanner of SCANNERS) {
    if (scanner.re) {
      const matches = text.match(scanner.re);
      if (matches) {
        for (const raw of new Set(matches.map((m) => m.trim()))) {
          if (BINARY_MAGIC.test(raw) || LOW_ENTROPY(raw)) continue;
          if (scanner.filter && !scanner.filter(raw)) continue;
          if (scanner.allow && scanner.allow(raw, text, rel)) continue;
          findings.push(`${rel}: ${scanner.name} -> ${raw.slice(0, 80)}`);
        }
      }
      continue;
    }
    if (scanner.name === '公网 IPv4') {
      for (const match of text.matchAll(IPV4_CONTEXT)) {
        const hit = match[1] || match[2] || '';
        if (!hit || PRIVATE_IPV4.test(hit) || DOC_IPV4.test(hit)) continue;
        findings.push(`${rel}: 公网 IPv4 -> ${hit}`);
      }
    }
    if (scanner.list) {
      for (const needle of scanner.list) {
        if (text.includes(needle)) findings.push(`${rel}: ${scanner.name} -> ${needle.slice(0, 2)}***${needle.slice(-2)}`);
      }
      continue;
    }
    if (scanner.name === '非 noreply 邮箱') {
      for (const hit of new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])) {
        if (SAFE_EMAIL.test(hit)) continue;
        findings.push(`${rel}: 非 noreply 邮箱 -> ${hit}`);
      }
    }
  }
  return findings;
}

function main() {
  // --force 会对已存在的目录做递归删除：先挡住三类危险目标 —— 文件系统根目录、
  // 仓库本身或仓库的上级目录、以及**仓库内部的任意路径**（`--out=<repo>/src --force`
  // 会把工作副本的源码删掉；2026-10-12 审查）。比较用 realpath + Windows 下折算大小写：
  // 只 resolve 的话，指向仓库内部的符号链接/junction、或盘符大小写变体（`c:\users\...`）
  // 都能绕过守卫（2026-10-13 审查）。
  const realOrResolve = (p) => {
    try { return (fs.realpathSync.native ?? fs.realpathSync)(p); } catch { return path.resolve(p); }
  };
  const normCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const outResolved = normCase(realOrResolve(OUT));
  const rootResolved = normCase(realOrResolve(ROOT));
  const outIsRootOrAncestor = outResolved === path.parse(outResolved).root
    || rootResolved === outResolved
    || rootResolved.startsWith(outResolved + path.sep);
  const outInsideRepo = outResolved.startsWith(rootResolved + path.sep);
  if (outIsRootOrAncestor || outInsideRepo) {
    console.error(`拒绝输出到 ${outResolved}：它是文件系统根目录、仓库本身/上级目录，或仓库内部的路径（--force 会删掉工作副本里的内容）。`);
    return 1;
  }
  if (fs.existsSync(OUT)) {
    if (!FORCE) {
      console.error(`输出目录已存在：${OUT}\n（要覆盖请加 --force）`);
      return 1;
    }
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  const files = listTrackedFiles();
  const copied = copyTracked(files);
  console.log(`已复制 ${copied} 个受跟踪文件 -> ${OUT}`);

  const findings = [];
  for (const rel of files) {
    const file = path.join(OUT, rel);
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue; // 二进制跳过
    const text = buffer.toString('utf8');
    findings.push(...scanFile(rel, text));
  }

  if (findings.length) {
    console.error(`\n发现 ${findings.length} 处疑似敏感内容：`);
    for (const line of findings.slice(0, 100)) console.error(`  - ${line}`);
    // 命中就删副本：避免"有命中但仍被分享出去"
    try {
      fs.rmSync(OUT, { recursive: true, force: true });
      console.error('\n已删除本次生成的副本，请清理后重新生成。');
    } catch {
      console.error('\n请手动删除本次生成的副本（自动删除失败）。');
    }
    return 1;
  }
  if (personalPatternsNotice) console.log(`注意：${personalPatternsNotice}`);
  console.log('扫描通过：未发现令牌 / 密钥 / 公网 IP / 真实邮箱 / 本机用户目录 / 本机个人串。');
  console.log('注意：这是粗筛，不保证覆盖所有敏感形态（域名、业务标识、截图内容等），外发前建议再人工过一遍。');
  console.log('（data/、config.json、console-access.txt 等本地文件本来就不在受跟踪文件里。）');
  return 0;
}

process.exit(main());
