#!/usr/bin/env node
// 把一个技能目录打成官方索引条目：校验 manifest、算 sha256、生成可粘贴到
// 官方索引 qq-agent-skills 的 JSON。它不联网、不上传；创作者把文件托管到公开地址后，
// 用这里生成的 url+sha256 提 PR / issue。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateSkillDir } from '../src/skills/registry.js';

const MAX_FILES = 8;
const MAX_FILE_BYTES = 128 * 1024;
const FILE_RE = /^[A-Za-z0-9_.-]{1,80}\.(json|md)$/i;

function usage() {
  console.log(`用法: node scripts/skill-pack.mjs <技能目录> [选项]

选项:
  --base-url URL     技能文件所在目录的公开地址（推荐；生成绝对 url）
  --author NAME      作者/组织（默认 skill.json 的 author，否则“未署名”）
  --category NAME    分类（默认“其他”）
  --homepage URL     项目主页
  --preview TEXT     索引里展示的摘要（默认取 SKILL.md 前 240 字）
  --json             只输出 JSON（默认会带少量说明到 stderr）

示例:
  node scripts/skill-pack.mjs ./my-skill \\
    --base-url https://raw.githubusercontent.com/you/repo/main/skills/my-skill \\
    --author you --category 生活`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) { usage(); process.exit(args.length ? 0 : 2); }
const dir = path.resolve(args[0]);
const opts = { json: false, baseUrl: '', author: '', category: '', homepage: '', preview: '' };
for (let i = 1; i < args.length; i += 1) {
  const key = args[i];
  const take = () => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} 缺少值`);
    i += 1;
    return value;
  };
  if (key === '--json') opts.json = true;
  else if (key === '--base-url') opts.baseUrl = take();
  else if (key === '--author') opts.author = take();
  else if (key === '--category') opts.category = take();
  else if (key === '--homepage') opts.homepage = take();
  else if (key === '--preview') opts.preview = take();
  else throw new Error(`未知参数：${key}`);
}

const log = (...values) => { if (!opts.json) console.error(...values); };

try {
  const manifest = validateSkillDir(dir);
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!names.includes('skill.json')) throw new Error('目录里缺少 skill.json');
  if (names.length > MAX_FILES) throw new Error(`文件超过 ${MAX_FILES} 个上限`);
  const files = {};
  let total = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${name} 超过 128KB`);
    total += bytes.length;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (opts.baseUrl) {
      const base = new URL(opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
      if (!['http:', 'https:'].includes(base.protocol)) throw new Error('--base-url 只允许 http/https');
      files[name] = { url: new URL(encodeURIComponent(name), base).toString(), sha256, bytes: bytes.length };
    } else {
      files[name] = { path: `./${path.basename(dir)}/${name}`, sha256, bytes: bytes.length };
    }
  }
  if (total > 512 * 1024) throw new Error('技能包总大小超过 512KB');
  const preview = String(opts.preview || manifest.instructions)
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const entry = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    author: opts.author || manifest.author || '未署名',
    category: opts.category || '其他',
    homepage: opts.homepage || '',
    preview,
    allowedTools: manifest.allowedTools,
    triggers: manifest.triggers,
    files
  };
  if (!opts.baseUrl) log('提示：未提供 --base-url，files 里是相对 path；提官方索引时请改成公开 url。');
  log(`技能 ${manifest.id}@${manifest.version} 校验通过：${names.length} 个文件，${total} 字节`);
  console.log(JSON.stringify(entry, null, 2));
} catch (error) {
  console.error(`skill-pack 失败：${error?.message || error}`);
  process.exit(1);
}
