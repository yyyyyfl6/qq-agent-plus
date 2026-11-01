#!/usr/bin/env node
// 拟人化表达评估：对一组脱敏聊天样本算客观指标，供盲评前缩小范围。
// 用法：node scripts/humanize-eval.mjs samples.jsonl
// 样本格式：每行 {"text":"..."} 或 {"messages":["...","..."]}。
// 只读文件，不联网、不调模型。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAiTells } from '../src/llm/humanize.js';

const CJK = /[\u4e00-\u9fff]/;

export function evaluateSamples(samples = [], { includeSoft = true } = {}) {
  const rows = samples.map((sample) => {
    const messages = Array.isArray(sample?.messages)
      ? sample.messages.map((item) => String(item ?? '')).filter(Boolean)
      : [String(sample?.text ?? '')].filter(Boolean);
    const text = messages.join('\n');
    return {
      messages,
      text,
      chars: text.length,
      questions: (text.match(/[？?]/g) || []).length,
      tells: findAiTells(text).filter((tell) => includeSoft || tell.severity === 'severe').length,
      opener: text.replace(/\s+/g, '').slice(0, 6)
    };
  }).filter((row) => row.chars > 0);

  const count = rows.length;
  const totalChars = rows.reduce((sum, row) => sum + row.chars, 0);
  const sorted = rows.map((row) => row.chars).sort((a, b) => a - b);
  const median = count ? (count % 2 ? sorted[(count - 1) / 2] : Math.round((sorted[count / 2 - 1] + sorted[count / 2]) / 2)) : 0;
  const openers = new Map();
  for (const row of rows) openers.set(row.opener, (openers.get(row.opener) || 0) + 1);
  const duplicateOpeners = [...openers.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);
  const withQuestion = rows.filter((row) => row.questions > 0).length;
  const multiBubble = rows.filter((row) => row.messages.length > 1).length;
  const withTells = rows.filter((row) => row.tells > 0).length;
  const cjk = rows.filter((row) => CJK.test(row.text)).length;

  return {
    samples: count,
    avgChars: count ? Math.round(totalChars / count) : 0,
    medianChars: median,
    maxChars: sorted.length ? sorted[sorted.length - 1] : 0,
    questionRate: count ? +(withQuestion / count).toFixed(3) : 0,
    multiBubbleRate: count ? +(multiBubble / count).toFixed(3) : 0,
    aiTellRate: count ? +(withTells / count).toFixed(3) : 0,
    duplicateOpenerRate: count ? +(duplicateOpeners / count).toFixed(3) : 0,
    cjkRate: count ? +(cjk / count).toFixed(3) : 0
  };
}

function loadSamples(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node scripts/humanize-eval.mjs <samples.jsonl|samples.json>');
    process.exit(2);
  }
  const samples = loadSamples(path.resolve(file));
  const report = evaluateSamples(samples, { includeSoft: !process.argv.includes('--severe-only') });
  console.log(JSON.stringify(report, null, 2));
  // 只做提示，不阻断：这些阈值是观察线，不是硬门禁。
  if (report.aiTellRate > 0.05) console.error(`提示：${(report.aiTellRate * 100).toFixed(1)}% 的样本命中助手腔，建议抽查。`);
  if (report.duplicateOpenerRate > 0.2) console.error(`提示：${(report.duplicateOpenerRate * 100).toFixed(1)}% 的样本开头重复，建议看开场白模板。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
