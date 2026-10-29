import assert from 'node:assert/strict';
import { test } from 'node:test';

const { renderMemesSection } = await import('../ui/pages/settings-extensions.js');

test('梗库会话选择器：搜索、分组、已选标签，不铺一长排开关', () => {
  const html = renderMemesSection({
    allow: { groups: ['123', '456', '456'], private: ['789'] }
  });
  assert.equal((html.match(/class="meme-chat-option"/g) || []).length, 3, '群/私聊去重后各一个可选项');
  assert.equal((html.match(/class="meme-chat-check"/g) || []).length, 3, '每条会话前都有勾选框');
  assert.match(html, /群 123/);
  assert.match(html, /群 456/);
  assert.match(html, /私聊 789/);
  assert.match(html, /id="memes-chat-search"/);
  assert.match(html, /id="memes-select-visible"/);
  assert.match(html, /id="memes-chat-chips"/);
  assert.match(html, /id="memes-selected-count"/);
  assert.match(html, /id="meme-chatkey-manual"/, '白名单为空时仍能手动输入会话 key');
  assert.match(html, /群聊（2）/);
  assert.match(html, /私聊（1）/);
});

test('白名单为空时给出提示，不渲染空选择器', () => {
  const html = renderMemesSection({ allow: { groups: [], private: [] } });
  assert.doesNotMatch(html, /meme-chat-option/);
  assert.match(html, /还没有已添加的群聊\/私聊/);
});
