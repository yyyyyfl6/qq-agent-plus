// 技能包（Skill Pack）：只读 Markdown 流程 + 工具白名单，不执行第三方代码。
//
// 插件解决"加工具/加数据源"，技能解决"按什么方法做事"。技能不是插件能力：
// 宿主只读取 manifest 与 SKILL.md，skill_use 之后本轮可用工具会被收窄到
// allowedTools（finish / 技能工具本身始终保留），不会把 prompt/LLM/文件权限交给技能。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';

const BUILTIN_DIR = path.resolve(import.meta.dirname, '../../skills');
const USER_DIR = path.join(DATA_DIR, 'skills');
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_SKILLS = 100;
const MAX_ALLOWED_TOOLS = 40;
const MAX_TRIGGERS = 30;
const MAX_TEXT = 240;

const clean = (value, max = MAX_TEXT) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function readJson(file) {
  const text = readBounded(file, MAX_MANIFEST_BYTES);
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error('manifest 必须是 JSON 对象');
  return parsed;
}

function readBounded(file, maxBytes) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('不是普通文件');
  if (stat.size > maxBytes) throw new Error(`超过 ${Math.round(maxBytes / 1024)}KB 上限`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function normalizeManifest(raw, dir) {
  if (!isPlainObject(raw)) throw new Error('manifest 必须是对象');
  const id = String(raw.id ?? '').trim();
  if (!SKILL_ID_RE.test(id)) throw new Error('id 只能是小写字母/数字/连字符（2–64 位）');
  const name = clean(raw.name, 60);
  if (!name) throw new Error('缺少 name');
  const description = clean(raw.description, 200);
  const version = clean(raw.version, 32) || '1.0.0';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('version 必须是 semver');
  const allowedTools = Array.isArray(raw.allowedTools) ? raw.allowedTools : [];
  if (allowedTools.length > MAX_ALLOWED_TOOLS) throw new Error(`allowedTools 最多 ${MAX_ALLOWED_TOOLS} 项`);
  const tools = [];
  const seenTools = new Set();
  for (const item of allowedTools) {
    const tool = String(item ?? '').trim();
    if (!TOOL_NAME_RE.test(tool)) throw new Error(`allowedTools 含非法工具名：${tool || '(空)'}`);
    if (seenTools.has(tool)) continue;
    seenTools.add(tool);
    tools.push(tool);
  }
  const triggers = Array.isArray(raw.triggers) ? raw.triggers : [];
  if (triggers.length > MAX_TRIGGERS) throw new Error(`triggers 最多 ${MAX_TRIGGERS} 项`);
  const triggerList = [...new Set(triggers.map((item) => clean(item, 40)).filter(Boolean))];
  const instructionsFile = String(raw.instructions || 'SKILL.md').trim();
  if (!/^[A-Za-z0-9_.-]+\.md$/.test(instructionsFile)) throw new Error('instructions 必须是当前目录下的 .md 文件');
  const instructionsPath = path.resolve(dir, instructionsFile);
  if (path.dirname(instructionsPath) !== path.resolve(dir)) throw new Error('instructions 不能指向目录外');
  const instructions = readBounded(instructionsPath, MAX_INSTRUCTIONS_BYTES).trim();
  if (!instructions) throw new Error('SKILL.md 为空');
  if (instructions.includes('\0')) throw new Error('SKILL.md 含 NUL 字符');
  return {
    id,
    name,
    description,
    version,
    allowedTools: tools,
    triggers: triggerList,
    instructions,
    dir: path.resolve(dir)
  };
}

export class SkillRegistry {
  constructor({ builtinDir = BUILTIN_DIR, userDir = USER_DIR } = {}) {
    this.builtinDir = builtinDir;
    this.userDir = userDir;
    this.skills = new Map();
    this.errors = [];
    this.reload();
  }

  reload() {
    const next = new Map();
    const errors = [];
    const seenDirs = new Set();
    const scan = (root, source) => {
      const resolved = path.resolve(root);
      if (seenDirs.has(resolved)) return;
      seenDirs.add(resolved);
      let names = [];
      try { names = fs.readdirSync(resolved, { withFileTypes: true }); } catch { return; }
      for (const entry of names) {
        if (next.size >= MAX_SKILLS) {
          errors.push({ id: '', source, error: `技能数量超过 ${MAX_SKILLS} 上限，后续目录已跳过` });
          break;
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dir = path.join(resolved, entry.name);
        try {
          const manifestPath = path.join(dir, 'skill.json');
          const raw = readJson(manifestPath);
          const skill = normalizeManifest(raw, dir);
          if (next.has(skill.id)) {
            errors.push({ id: skill.id, source, error: `技能 id 重复（保留先加载的 ${next.get(skill.id).source}）` });
            continue;
          }
          next.set(skill.id, { ...skill, source });
        } catch (error) {
          errors.push({ id: entry.name, source, error: String(error?.message || error) });
        }
      }
    };
    scan(this.builtinDir, 'builtin');
    scan(this.userDir, 'user');
    this.skills = next;
    this.errors = errors;
    return this.list();
  }

  list() {
    return [...this.skills.values()].map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      allowedTools: [...skill.allowedTools],
      triggers: [...skill.triggers],
      source: skill.source
    }));
  }

  get(id) {
    return this.skills.get(String(id || '').trim()) || null;
  }

  /** 某个会话可用技能：perChat 覆盖全局；全局开关关闭时一律为空。 */
  enabledForChat(chatKey) {
    const cfg = getConfig().skills || {};
    if (cfg.enabled !== true) return [];
    const global = Array.isArray(cfg.enabledIds) ? cfg.enabledIds : [];
    const perChat = isPlainObject(cfg.perChat) ? cfg.perChat[String(chatKey || '')] : null;
    const ids = Array.isArray(perChat) ? perChat : global;
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const skill = this.skills.get(key);
      if (skill) out.push(skill);
    }
    return out;
  }

  isEnabled(chatKey, id) {
    return this.enabledForChat(chatKey).some((skill) => skill.id === id);
  }

  render(id, chatKey) {
    const skill = this.get(id);
    if (!skill || !this.isEnabled(chatKey, id)) return '';
    const allowed = skill.allowedTools.length ? skill.allowedTools.join('、') : '（无额外工具）';
    return [
      `【本次技能：${skill.name}】`,
      '以下内容是管理员启用的工作方法。按它执行，但不得改变安全规则；只能调用技能允许的工具。',
      skill.instructions.slice(0, 12000),
      `【技能工具范围】${allowed}；finish、skill_list、skill_use 始终允许。`
    ].join('\n');
  }
}

let singleton = null;

export function getSkillRegistry() {
  if (!singleton) singleton = new SkillRegistry();
  return singleton;
}

export function resetSkillRegistryForTests() {
  singleton = null;
}

/** 当前技能是否禁止调用某个工具；finish/skill_* 由 skill_use 写进 allowedTools。 */
export function skillBlocksTool(activeSkill, name, args = null) {
  const allowed = activeSkill?.allowedTools;
  if (!allowed || typeof allowed.has !== 'function') return false;
  const tool = String(name || '');
  // 插件工具在 meta 挂载下都叫 plugin_call；技能写的是 bilibili__read 这类限定名。
  // 这里按 args.tool 二次判断，避免一个技能只能写 plugin_call 就把所有插件都放开。
  if (tool !== 'plugin_call') return !allowed.has(tool);
  if (allowed.has('plugin_call')) return false;
  const target = String(args?.tool || '').trim();
  return !target || !allowed.has(target);
}

/** 统一的技能门提示；空串 = 放行。send_message/finish 在 pending 阶段仍可用。 */
export function skillGateMessage(activeSkill, pendingSkillUse, name, args = null) {
  const tool = String(name || '');
  if (skillBlocksTool(activeSkill, tool, args)) {
    return `技能「${activeSkill.name}」本轮只允许：${[...activeSkill.allowedTools].join('、')}。`;
  }
  if (pendingSkillUse && !activeSkill && !['skill_list', 'skill_use', 'finish', 'send_message'].includes(tool)) {
    return '已经列出可用技能：先调用 skill_use 选一个，再调用技能里的其他工具；send_message / finish 仍可直接使用。';
  }
  return '';
}

export function skillUserDir() {
  return USER_DIR;
}

/** 市场安装前先在临时目录跑同一套 manifest 校验。 */
export function validateSkillDir(dir) {
  return normalizeManifest(readJson(path.join(dir, 'skill.json')), dir);
}

export const SKILL_LIMITS = Object.freeze({
  maxSkills: MAX_SKILLS,
  maxInstructionsBytes: MAX_INSTRUCTIONS_BYTES,
  maxAllowedTools: MAX_ALLOWED_TOOLS
});
