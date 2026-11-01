import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeBubbles } from '../src/llm/bubble-shape.js';

test('把一段长回复按句拆成 1–3 条气泡', () => {
  const out = shapeBubbles('今天好累。老板又临时加活，地铁还坐过站。回去只想躺着。明天再说吧。', { maxBubbles: 3, maxChars: 20 });
  assert.ok(out.length >= 1 && out.length <= 3);
  assert.ok(out.every((text) => text.length <= 20 || /。/.test(text) === false));
  assert.equal(out.join('').includes('今天好累'), true);
});

test('已经分好的数组不改变顺序；超过上限时并进最后一条', () => {
  assert.deepEqual(shapeBubbles(['一', '二', '三'], { maxBubbles: 3 }), ['一', '二', '三']);
  assert.deepEqual(shapeBubbles(['一', '二', '三', '四'], { maxBubbles: 3 }), ['一', '二', '三四']);
});

test('代码块和 URL 不被拆开', () => {
  const code = '```js\nconst x = 1;\nconsole.log(x);\n```';
  const url = 'https://example.com/a/b?x=1&y=2';
  const out = shapeBubbles([`先看这个 ${url}`, code], { maxBubbles: 3, maxChars: 20 });
  assert.ok(out.some((text) => text.includes(url)));
  assert.ok(out.some((text) => text.includes('const x = 1;')));
});

test('短句原样保留，不为了凑条数硬拆', () => {
  assert.deepEqual(shapeBubbles('在的', { maxBubbles: 3, maxChars: 60 }), ['在的']);
  assert.deepEqual(shapeBubbles('', { maxBubbles: 3 }), []);
});
