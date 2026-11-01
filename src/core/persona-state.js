// 性格状态：用很轻的精力/心情/作息影响语气，不训练、不调模型。
// 状态按"人设"存（同一人设跨群共享），写入 data/persona-state.json；
// 任何异常都退回默认值，绝不影响聊天主流程。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { minuteOfDayInZone } from './util.js';

const STATE_FILE = path.join(DATA_DIR, 'persona-state.json');
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

export function personaKeyOf(persona = {}) {
  const raw = String(persona?.templateId || persona?.botName || 'default').trim();
  return (raw || 'default').slice(0, 80);
}

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeAll(all) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1), { encoding: 'utf8', mode: 0o600, flush: true });
    fs.renameSync(tmp, STATE_FILE);
    fs.chmodSync(STATE_FILE, 0o600);
  } catch { /* 状态是锦上添花，写不进去不影响聊天 */ }
}

function clockMinutes(value, fallback) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function inWindow(minute, start, end) {
  const s = clockMinutes(start, 0);
  const e = clockMinutes(end, 7 * 60);
  return s === e ? false : (s < e ? (minute >= s && minute < e) : (minute >= s || minute < e));
}

function activityOf(minute, sleeping) {
  if (sleeping) return '这个点通常已经睡了';
  if (minute < 9 * 60) return '刚起床，还没完全清醒';
  if (minute < 12 * 60) return '在忙自己的事';
  if (minute < 14 * 60) return '刚吃完饭，在歇着';
  if (minute < 18 * 60) return '在忙';
  if (minute < 20 * 60) return '刚吃完晚饭';
  return '在放松';
}

/** 纯计算：给定旧状态与人设，算出此刻的状态（便于单测）。 */
export function computePersonaState(prev = {}, persona = {}, now = Date.now()) {
  const cfg = getConfig().humanize?.personaState || {};
  const key = personaKeyOf(persona);
  const updatedAt = Number(prev.updatedAt) || now;
  const hours = Math.min(72, Math.max(0, (now - updatedAt) / 3600000));
  const minute = minuteOfDayInZone(now);
  const sleeping = inWindow(minute, cfg.sleepStart || '00:00', cfg.sleepEnd || '07:00');
  // 0 是合法体力值：不能用 `|| 65`，否则累到 0 后下一轮会跳回 65。
  const prevEnergy = Number(prev.energy);
  const energyBase = Number.isFinite(prevEnergy) ? prevEnergy : 65;
  const prevMood = Number(prev.mood);
  const moodBase = Number.isFinite(prevMood) ? prevMood : 0;
  const energy = clamp(energyBase + hours * (sleeping ? 8 : -2.2), 0, 100);
  const mood = clamp(moodBase + hours * (sleeping ? 0.4 : -0.35), -100, 100);
  return {
    version: 1,
    key,
    energy: Math.round(energy),
    mood: Math.round(mood),
    activity: activityOf(minute, sleeping),
    sleeping,
    updatedAt: now,
    lastInteractionAt: Number(prev.lastInteractionAt) || 0
  };
}

function stateLine(state) {
  const energy = state.energy < 25 ? '很累，话会少一点'
    : state.energy < 50 ? '有点累'
      : state.energy < 80 ? '还好' : '精神不错';
  const mood = state.mood > 25 ? '心情挺好'
    : state.mood < -25 ? '有点烦，别硬聊'
      : state.mood < -10 ? '有点低落'
        : '心情一般';
  const sleepNote = state.sleeping
    ? '这个点通常已经睡了；如果被叫醒，回复短一点、慢一点，别硬撑。'
    : '按这个状态说话，不要提"能量/心情数值"，也不要解释这条设定。';
  return `【你现在的状态】${state.activity}；${energy}，${mood}。${sleepNote}`;
}

function enabled() {
  const h = getConfig().humanize;
  return h?.enabled === true && h?.personaState?.enabled !== false;
}

function cardDecidesTone(persona = {}) {
  const h = getConfig().humanize;
  return h?.respectPersonaCard !== false && persona?.behaviorProfile === 'card';
}

/** 控制台只读快照：不写盘、不改状态，只告诉页面当前会注入什么。 */
export function personaStateSnapshot(persona = {}, now = Date.now()) {
  const h = getConfig().humanize;
  const enabledNow = enabled() && !cardDecidesTone(persona);
  if (!enabledNow) {
    return {
      enabled: h?.enabled === true,
      injected: false,
      cardFirst: Boolean(persona?.behaviorProfile === 'card'),
      respectPersonaCard: h?.respectPersonaCard !== false,
      personaStateEnabled: h?.personaState?.enabled !== false,
      key: personaKeyOf(persona)
    };
  }
  const all = readAll();
  const key = personaKeyOf(persona);
  const state = computePersonaState(all[key] || {}, persona, now);
  return {
    enabled: true,
    injected: true,
    cardFirst: false,
    respectPersonaCard: h?.respectPersonaCard !== false,
    personaStateEnabled: true,
    savedAt: Number(all[key]?.savedAt) || state.updatedAt,
    ...state
  };
}

/** 取当前状态并格式化；关闭时返回空串（提示词与升级前逐字一致）。 */
export function personaStatePrompt(persona = {}, now = Date.now()) {
  if (!enabled() || cardDecidesTone(persona)) return '';
  try {
    const all = readAll();
    const key = personaKeyOf(persona);
    const prev = all[key] || {};
    const state = computePersonaState(prev, persona, now);
    // 不必每轮都落盘：一分钟内的多次运行复用同一份状态。
    if (now - (Number(prev.savedAt) || 0) > 60000) {
      all[key] = { ...state, savedAt: now };
      writeAll(all);
    }
    return stateLine(state);
  } catch { return ''; }
}

/** 有互动时轻微抬心情、掉精力；只对开启了这个功能的实例生效。 */
export function notePersonaInteraction(persona = {}, { kind = 'incoming', at = Date.now() } = {}) {
  if (!enabled() || cardDecidesTone(persona)) return;
  try {
    const all = readAll();
    const key = personaKeyOf(persona);
    const prev = all[key] || {};
    const state = computePersonaState(prev, persona, at);
    state.energy = clamp(state.energy - (kind === 'outgoing' ? 0.5 : 0.3), 0, 100);
    state.mood = clamp(state.mood + (kind === 'incoming' ? 1.2 : 0.4), -100, 100);
    state.lastInteractionAt = at;
    all[key] = { ...state, savedAt: at };
    writeAll(all);
  } catch { /* 状态更新失败不影响回复 */ }
}
