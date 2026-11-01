import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idList } from '../src/core/list.js';

test('名单字段：数组正常转字符串，非数组回退空列表', () => {
  assert.deepEqual(idList(['123', 456]), ['123', '456']);
  assert.deepEqual(idList('123'), []);
  assert.deepEqual(idList(null), []);
  assert.deepEqual(idList(undefined), []);
  assert.deepEqual(idList({ groups: ['1'] }), []);
});
