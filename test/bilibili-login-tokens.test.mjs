// 扫码登录的凭据解析：URL 与 Set-Cookie 必须按字段合并。
// 线上踩过：URL 里有 SESSDATA、Set-Cookie 里只有 bili_jct，旧实现直接丢掉后者 → 登录后写操作全失败。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSsoTokens, parseSetCookieTokens, mergeLoginTokens } from '../examples/plugins/bilibili/login-tokens.mjs';

test('URL 有 SESSDATA、Set-Cookie 只有 bili_jct：两边合并', () => {
  const url = 'https://passport.bilibili.com/x/passport-login/web/crossDomain?DedeUserID=42&SESSDATA=abc';
  const cookies = ['bili_jct=csrf-token; Path=/; Domain=.bilibili.com', 'DedeUserID=42; Path=/'];
  assert.deepEqual(mergeLoginTokens(url, cookies), {
    sessdata: 'abc',
    bili_jct: 'csrf-token',
    dedeuserid: '42'
  });
});

test('嵌套 crossDomain URL 逐层解出凭据', () => {
  const inner = 'https://passport.bilibili.com/x/passport-login/web/crossDomain?SESSDATA=inner-sess&bili_jct=inner-jct&DedeUserID=7';
  const outer = `https://passport.bilibili.com/x/passport-login/web/crossDomain?crossDomain=${encodeURIComponent(inner)}`;
  assert.deepEqual(mergeLoginTokens(outer, []), {
    sessdata: 'inner-sess', bili_jct: 'inner-jct', dedeuserid: '7'
  });
});

test('只有 Set-Cookie 也能解析（且 bili_jct 单独存在时不能返回 null）', () => {
  assert.equal(parseSetCookieTokens(['bili_jct=only-jct; Path=/']).bili_jct, 'only-jct');
  assert.equal(parseSetCookieTokens(['bili_jct=only-jct; Path=/']).sessdata, '');
  assert.deepEqual(mergeLoginTokens('', ['SESSDATA=s1; Path=/', 'bili_jct=c1; Path=/']), {
    sessdata: 's1', bili_jct: 'c1', dedeuserid: ''
  });
});

test('空响应 / 无凭据：返回空字段而不是抛错', () => {
  assert.equal(findSsoTokens(''), null);
  assert.equal(parseSetCookieTokens([]), null);
  assert.deepEqual(mergeLoginTokens(undefined, undefined), { sessdata: '', bili_jct: '', dedeuserid: '' });
});
