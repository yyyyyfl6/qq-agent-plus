// 有界读响应体（src/core/http-body.js）的回归用例。
//
// 这个模块存在的理由：上游返回超大或畸形响应时，常驻进程会被单次调用打爆。
// 所以这里钉的重点是"超限时真的停住"与"各种残缺/异常的 Response 都不能把裸异常放出去"。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { readTextBounded, readJsonBounded, readBytesBounded } = await import('../src/core/http-body.js');

/** 造一个"每块 chunkBytes 字节、最多 maxChunks 块"的假流。 */
function streamRes({ chunkBytes = 100, maxChunks = 10, contentType = 'text/plain' } = {}) {
  let sent = 0;
  let cancelled = false;
  const body = {
    getReader() {
      return {
        async read() {
          if (cancelled || sent >= maxChunks) return { done: true, value: undefined };
          sent += 1;
          return { done: false, value: new Uint8Array(chunkBytes).fill(65) };
        },
        async cancel() { cancelled = true; },
        releaseLock() {},
      };
    },
  };
  return { res: { body, headers: { get: () => contentType } }, stats: () => ({ sent, cancelled }) };
}

test('超限时立刻停止并抛 BODY_TOO_LARGE：不截断、不再多读', async () => {
  const { res, stats } = streamRes({ chunkBytes: 100, maxChunks: 1000 });
  await assert.rejects(() => readTextBounded(res, 250), (err) => {
    assert.equal(err.code, 'BODY_TOO_LARGE');
    assert.match(err.message, /250/, '错误信息要带上限');
    return true;
  });
  const { sent, cancelled } = stats();
  assert.ok(sent <= 4, `超限后不该继续读（实际读了 ${sent} 块）`);
  assert.equal(cancelled, true, '超限必须取消底层流，否则上游继续吐数据占住连接与内存');
});

test('正好等于上限要放行（边界不能差一个字节）', async () => {
  const { res } = streamRes({ chunkBytes: 100, maxChunks: 5 });
  const text = await readTextBounded(res, 500);
  assert.equal(text.length, 500);
});

test('body 为空 / 没有流时退回 text()、json()，并照样按字节数校验', async () => {
  assert.equal(await readTextBounded({ text: async () => 'hello' }, 100), 'hello');
  assert.deepEqual(await readJsonBounded({ json: async () => ({ a: 1 }) }, 100), { a: 1 });
  await assert.rejects(() => readTextBounded({ text: async () => 'x'.repeat(50) }, 10),
    (err) => err.code === 'BODY_TOO_LARGE');
});

test('body 已被锁住 / 已被消费时，退回 text() 而不是抛裸 TypeError', async () => {
  // 审查指出的潜伏缺陷：getReader() 在流被锁住时抛 TypeError，而它原本在 try 之外，
  // 逃出去的就不是本模块承诺的错误形态了。真实调用点目前都不会先消费 body，
  // 但这是"下一个改动就可能踩到"的那类坑，钉住它。
  const res = {
    body: { getReader() { throw new TypeError('ReadableStream is locked'); } },
    text: async () => 'ok-from-text',
  };
  assert.equal(await readTextBounded(res, 1024), 'ok-from-text');
});

test('body 被锁住且连 text() 都没有时，抛的不能是裸 TypeError', async () => {
  const res = { body: { getReader() { throw new TypeError('locked'); } } };
  await assert.rejects(() => readTextBounded(res, 1024), (err) => {
    assert.notEqual(err.constructor.name, 'TypeError',
      `应当是可识别的错误，实际 ${err.constructor.name}: ${err.message}`);
    return true;
  });
});

test('readBytesBounded：超限立刻取消、正好等于上限放行、退路照常校验（字节路径）', async () => {
  // 2026-10-09 审查：图片/语音这类二进制读取原先是"先整包 arrayBuffer() 再判长度"，
  // 上限形同虚设；这里钉住字节路径与文本路径同一条纪律。
  const over = streamRes({ chunkBytes: 100, maxChunks: 1000 });
  await assert.rejects(() => readBytesBounded(over.res, 250), (err) => {
    assert.equal(err.code, 'BODY_TOO_LARGE');
    return true;
  });
  assert.equal(over.stats().cancelled, true, '超限必须取消底层流');

  const exact = streamRes({ chunkBytes: 100, maxChunks: 5 });
  const buffer = await readBytesBounded(exact.res, 500);
  assert.equal(buffer.length, 500, '正好等于上限要放行（边界不能差一个字节）');
  assert.equal(buffer[0], 65);

  const viaArrayBuffer = await readBytesBounded({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, 10);
  assert.deepEqual([...viaArrayBuffer], [1, 2, 3]);
  await assert.rejects(() => readBytesBounded({ arrayBuffer: async () => new Uint8Array(50).buffer }, 10),
    (err) => err.code === 'BODY_TOO_LARGE');
});

test('退化流：body 既无 getReader 也不是异步可迭代时，不抛裸 TypeError', async () => {
  // 2026-10-09 审查：`{}` 这类 truthy 桩对象会逸出 `for await ... of` 的裸 TypeError，
  // 与"残缺 Response 不放裸异常"的模块承诺不符。
  await assert.rejects(() => readTextBounded({ body: {} }, 1024), (err) => {
    assert.notEqual(err.constructor.name, 'TypeError',
      `应当是可识别的错误，实际 ${err.constructor.name}: ${err.message}`);
    return true;
  });
  // 有 asyncIterator 的退化流照常读（文本与字节两条路径）
  const textBody = { [Symbol.asyncIterator]: async function* () { yield new Uint8Array([65, 66]); } };
  assert.equal(await readTextBounded({ body: textBody }, 1024), 'AB');
  const byteBody = { [Symbol.asyncIterator]: async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3]); } };
  assert.deepEqual([...(await readBytesBounded({ body: byteBody }, 1024))], [1, 2, 3]);
});

test('reader 吐字符串块时上限照样生效（别让 total 变成 NaN）', async () => {
  // 2026-10-09 复核：主路径直接写了 chunk.byteLength，字符串块下是 undefined → total=NaN →
  // `NaN > limit` 恒假 → "有界"静默失效。真实 fetch 不会这样，但这个模块的卖点就是上限真的在生效，
  // 而它自己的退路分支（异步迭代器 / text()）都能接住字符串 —— 主路径不该是唯一漏的那个。
  // 假流故意**有界**（最多 50 块）：回归时若 total 变成 NaN，循环会一路读完 3200 字节、
  // 正常返回，断言立刻红 —— 比"永远读不完、把测试挂死"更容易看出是什么坏了。
  let cancelled = false;
  const res = {
    body: {
      getReader: () => {
        let n = 0;
        return {
          async read() { n += 1; return n <= 50 ? { done: false, value: 'x'.repeat(64) } : { done: true }; },
          async cancel() { cancelled = true; },
          releaseLock() {}
        };
      }
    }
  };
  await assert.rejects(() => readTextBounded(res, 100), (err) => err.code === 'BODY_TOO_LARGE');
  assert.equal(cancelled, true, '超限必须取消底层流');
  // 同一路径上，正常范围内的字符串块要能读出来（不能被 decoder 的 TypeError 弄坏）
  const okRes = {
    body: {
      getReader: () => {
        let n = 0;
        return {
          async read() { n += 1; return n <= 2 ? { done: false, value: 'abc' } : { done: true }; },
          async cancel() {}, releaseLock() {}
        };
      }
    }
  };
  assert.equal(await readTextBounded(okRes, 100), 'abcabc');
  // 字节路径同样要挡
  const binRes = {
    body: {
      getReader: () => {
        let n = 0;
        return {
          async read() { n += 1; return n <= 50 ? { done: false, value: 'yyyy'.repeat(40) } : { done: true }; },
          async cancel() {}, releaseLock() {}
        };
      }
    }
  };
  await assert.rejects(() => readBytesBounded(binRes, 64), (err) => err.code === 'BODY_TOO_LARGE');
});
