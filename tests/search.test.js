/**
 * Nominatim 纯静态合规回归：用桩 fetch 验证全局串行限流、同查询合并、内存缓存、
 * 公开联系标识，以及「在线未知时区不得回填设备偏移」。不依赖真实网络。
 */
import assert from 'node:assert/strict';

let failed = 0;
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name} — ${e.message}`); }
};

let calls = [];
const okResponse = (rows, cachedAt = null) => ({
  ok: true,
  headers: { get: (k) => (String(k).toLowerCase() === 'x-dangwu-cached-at' ? cachedAt : null) },
  json: async () => rows,
});
const stub = (rows, cachedAt = null) => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    await new Promise((r) => setTimeout(r, 5));
    return okResponse(rows, cachedAt);
  };
};

const { searchOnline, NOMINATIM_EMAIL } = await import('../src/ui/search.js');
const city = (name, lat, lon) => ({ display_name: name, lat: String(lat), lon: String(lon), address: { country: name } });

await check('短查询不联网', async () => {
  stub([city('X', 1, 2)]);
  assert.deepEqual(await searchOnline('a'), []);
  assert.equal(calls.length, 0);
});

await check('在线结果保留未知时区（不回填设备偏移）', async () => {
  stub([city('Reykjavik, Iceland', 64.142, -21.927)]);
  const rows = await searchOnline('Reykjavik');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tzOffsetMin, null);
  assert.equal(rows[0].timeZoneId, null);
});

await check('请求携带公开联系标识与 jsonv2 格式', async () => {
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('email'), NOMINATIM_EMAIL);
  assert.equal(u.searchParams.get('format'), 'jsonv2');
});

await check('不设置会被浏览器丢弃的 User-Agent，但带 Accept', () => {
  const keys = Object.keys(calls[0].headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes('user-agent'), `出现了 UA：${keys.join(',')}`);
  assert.ok(keys.includes('accept'), `缺少 Accept：${keys.join(',')}`);
});

await check('同查询（含大小写与空格差异）命中内存缓存', async () => {
  const before = calls.length;
  const rows = await searchOnline('  REYKJAVIK ');
  assert.ok(rows.length >= 1);
  assert.equal(calls.length, before, '重复查询不应再请求');
});

await check('不同查询受 1 秒全局串行限流', async () => {
  calls = [];
  stub([city('Tromso', 69.65, 18.96)]);
  const t0 = Date.now();
  await searchOnline('Tromso');
  await searchOnline('London');
  const elapsed = Date.now() - t0;
  assert.equal(calls.length, 2);
  assert.ok(elapsed >= 1000, `两次请求仅间隔 ${elapsed}ms，未达 1 秒`);
});

await check('SW 回放的缓存响应标记为在线缓存', async () => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return okResponse([city('Cached City', 1, 2)], '1700000000000');
  };
  const rows = await searchOnline('Cached City');
  assert.match(rows[0].source, /在线缓存/);
});

await check('网络异常后请求队列不卡死', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => searchOnline('Broken Place'));
  stub([city('Recovered', 3, 4)]);
  const rows = await searchOnline('Recovered Place');
  assert.equal(rows[0].name, 'Recovered');
});

console.log(`\n════ 搜索合规 通过 ${passed} / 失败 ${failed} ════`);
if (failed) process.exit(1);
