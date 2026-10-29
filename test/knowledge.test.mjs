// 轻量知识库：切片、关键词/中文二元组检索、工具出口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-knowledge-'));
const docs = path.join(dir, 'knowledge');
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, '群规.md'), '# 群规\n\n禁止刷屏。\n\n禁言最长 30 天。\n');
fs.writeFileSync(path.join(docs, 'faq.txt'), '问：怎么报名？\n答：在群里发「我玩」。\n');
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { chunkText, knowledgeEnabled, searchKnowledge, listKnowledgeFiles, writeKnowledgeFile, deleteKnowledgeFile, reindexKnowledge } = await import('../src/knowledge/store.js');
const { buildToolDefs } = await import('../src/tools/tools.js');

function enable(over = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.knowledge = { enabled: true, dir: docs, maxResults: 4, chunkChars: 300, overlapChars: 40, ...over };
  setRuntimeConfig(cfg);
  return cfg;
}

it('切分保留段落，长文按窗口切并带重叠', () => {
  const chunks = chunkText('第一段。'.repeat(50) + '\n\n第二段。'.repeat(50), 300, 40);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
});

it('中文二元组命中群规与 FAQ', () => {
  enable();
  assert.equal(knowledgeEnabled(), true);
  const rule = searchKnowledge('禁言多久');
  assert.ok(rule.results.length > 0);
  assert.equal(rule.results[0].source, '群规.md');
  assert.match(rule.results[0].snippet, /禁言/);
  const faq = searchKnowledge('怎么报名');
  assert.ok(faq.results.some((item) => item.source === 'faq.txt'));
});

it('知识库关闭时不返回结果；工具出口能带来源', async () => {
  const cfg = enable({ enabled: false });
  setRuntimeConfig(cfg);
  assert.deepEqual(searchKnowledge('禁言').results, []);
  enable();
  const tool = buildToolDefs().find((entry) => entry.name === 'knowledge_search');
  const result = await tool.execute({ kind: 'group', chatKey: 'group:1', session: {} }, { query: '禁言' });
  assert.ok(!result.isError);
  assert.match(result.content, /群规\.md/);
});

it('控制台文件管理：写入、列出、删除、重建索引', () => {
  enable();
  const written = writeKnowledgeFile('新增.md', '报名请发「我玩」。\n');
  assert.equal(written.name, '新增.md');
  assert.ok(listKnowledgeFiles().some((file) => file.name === '新增.md'));
  assert.ok(searchKnowledge('报名').results.some((item) => item.source === '新增.md'));
  deleteKnowledgeFile('新增.md');
  assert.ok(!listKnowledgeFiles().some((file) => file.name === '新增.md'));
  assert.ok(reindexKnowledge().files >= 2);
  assert.throws(() => writeKnowledgeFile('../x.md', 'x'), /文件名/);
});

it('知识库未启用时仍可先在控制台准备文档（工具/检索仍保持关闭）', () => {
  const cfg = enable({ enabled: false });
  setRuntimeConfig(cfg);
  writeKnowledgeFile('草稿.md', '还没启用，但可以先把资料放进来。');
  assert.ok(listKnowledgeFiles().some((file) => file.name === '草稿.md'));
  assert.deepEqual(searchKnowledge('草稿').results, [], '未启用时搜索仍然关闭');
  deleteKnowledgeFile('草稿.md');
});
