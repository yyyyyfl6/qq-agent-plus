#!/usr/bin/env node
// 官方技能索引体检：CI 和本地都能跑。远程文件只校验索引字段，本地文件会读盘核对 sha256，
// 这样 PR 里改坏示例文件/索引哈希会在合并前被挡下。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateSkillDir } from '../src/skills/registry.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_FILE = path.join(ROOT, 'skills', 'market.json');
const FILE_KEY_RE = /^[A-Za-z0-9_.-]{1,80}\.(json|md)$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function checkSkillMarket({ file = INDEX_FILE, root = ROOT } = {}) {
  const errors = [];
  const notes = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { ok: false, errors: [`读取 ${path.relative(root, file)} 失败：${error?.message || error}`], notes }; }
  if (!Array.isArray(data?.skills) || !data.skills.length) errors.push('索引没有 skills 数组或为空');
  const seen = new Set();
  for (const [index, entry] of (data.skills || []).entries()) {
    const label = `skills[${index}]${entry?.id ? `(${entry.id})` : ''}`;
    const id = String(entry?.id || '');
    if (!ID_RE.test(id)) errors.push(`${label}: id 非法`);
    if (seen.has(id)) errors.push(`${label}: id 重复`);
    seen.add(id);
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(entry?.version || ''))) errors.push(`${label}: version 不是 semver`);
    if (!String(entry?.name || '').trim()) errors.push(`${label}: 缺少 name`);
    if (!String(entry?.preview || '').trim()) errors.push(`${label}: 缺少 preview（查看详情不应再下载整包）`);
    if (!entry?.files || typeof entry.files !== 'object' || Array.isArray(entry.files)) errors.push(`${label}: files 必须是对象`);
    const files = entry?.files && typeof entry.files === 'object' && !Array.isArray(entry.files) ? entry.files : {};
    const names = Object.keys(files);
    if (names.length > 8) errors.push(`${label}: 文件超过 8 个`);
    if (!files['skill.json']) errors.push(`${label}: 缺少 skill.json`);
    for (const name of names) {
      if (!FILE_KEY_RE.test(name)) { errors.push(`${label}: 文件键非法 ${name}`); continue; }
      const meta = files[name];
      if (!/^[0-9a-f]{64}$/i.test(String(meta?.sha256 || ''))) errors.push(`${label}: ${name} sha256 格式错误`);
      if (!Number.isFinite(Number(meta?.bytes)) || Number(meta.bytes) <= 0) errors.push(`${label}: ${name} bytes 缺失`);
    }
    // 本地 path 直接核对；远程 url 不在 CI 里拉（索引来源可能被墙，网络失败不该误判内容）
    const manifestMeta = files['skill.json'];
    const localManifest = manifestMeta?.path ? path.resolve(path.dirname(file), manifestMeta.path) : '';
    if (localManifest && fs.existsSync(localManifest)) {
      const dir = path.dirname(localManifest);
      try {
        const manifest = validateSkillDir(dir);
        if (manifest.id !== id) errors.push(`${label}: manifest id=${manifest.id} 与索引不一致`);
        const instructionsName = 'SKILL.md';
        if (!files[instructionsName]) errors.push(`${label}: 缺少说明文件 ${instructionsName}`);
        const expectedTools = [...(manifest.allowedTools || [])].sort().join('\n');
        const indexedTools = [...(entry.allowedTools || [])].sort().join('\n');
        if (expectedTools !== indexedTools) errors.push(`${label}: allowedTools 与 manifest 不一致`);
        for (const [name, meta] of Object.entries(files)) {
          if (!meta?.path) continue;
          const target = path.resolve(path.dirname(file), meta.path);
          if (path.dirname(target) !== path.resolve(dir)) { errors.push(`${label}: ${name} 指向技能目录外`); continue; }
          if (!fs.existsSync(target)) { errors.push(`${label}: 本地文件不存在 ${meta.path}`); continue; }
          const bytes = fs.readFileSync(target);
          if (bytes.length !== Number(meta.bytes)) errors.push(`${label}: ${name} bytes 不一致（索引 ${meta.bytes}，实际 ${bytes.length}）`);
          const digest = crypto.createHash('sha256').update(bytes).digest('hex');
          if (digest !== String(meta.sha256).toLowerCase()) errors.push(`${label}: ${name} sha256 不一致`);
        }
      } catch (error) {
        errors.push(`${label}: 技能目录校验失败：${error?.message || error}`);
      }
    } else {
      notes.push(`${label}: 远程/非本地文件，只校验索引字段`);
    }
  }
  return { ok: errors.length === 0, errors, notes, count: data.skills?.length || 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = checkSkillMarket();
  for (const note of result.notes) console.log(`ℹ ${note}`);
  for (const error of result.errors) console.error(`✖ ${error}`);
  if (result.ok) console.log(`✓ 技能索引通过：${result.count} 个技能`);
  process.exit(result.ok ? 0 : 1);
}
