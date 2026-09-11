/**
 * Web/PWA 冒烟门禁：任一断言失败即以非零码退出。
 * 在线 Nominatim 结果不作为硬门禁（网络与公共服务可用性不可控）。
 * 截图写入 test-results/screenshots，不污染仓库根目录。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = resolve(ROOT, 'test-results/screenshots');
const BASE = process.env.DANGWU_BASE_URL || 'http://127.0.0.1:5173/';
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const shot = (page, name) => page.screenshot({ path: resolve(SHOTS, `${name}.png`) });

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleErrors = [];
const badResponses = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

try {
  console.log(`\n═══ 冒烟：${BASE} ═══`);
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById('tst');
    return t && /^\d{2}:\d{2}:\d{2}$/.test(t.textContent.trim());
  }, null, { timeout: 20000 });

  console.log('· 首页');
  check('错误层未出现', await page.locator('#err').isHidden());
  check('载入遮罩已隐藏', await page.locator('#boot').isHidden());
  check('时间卡可见', await page.locator('#clock').isVisible());
  check('真太阳时非占位', /^\d{2}:\d{2}:\d{2}$/.test((await page.locator('#tst').textContent()).trim()), await page.locator('#tst').textContent());
  check('地点名非空', (await page.locator('#place-btn').textContent()).trim().length > 0);
  check('日出日落行有内容', (await page.locator('#sun').textContent()).includes('日出'));
  check('关于入口存在', await page.locator('#about-btn').isVisible());
  await shot(page, 'home');

  console.log('· 本地搜索（不联网）');
  await page.click('#search-btn');
  check('搜索面板打开', await page.locator('#search').isVisible());
  check('联网搜索按钮为提交型', (await page.locator('#search-online').getAttribute('type')) === 'submit');
  check('离线索引署名可见', (await page.locator('#search .attribution').textContent()).includes('GeoNames'));
  await page.fill('#search-input', '北京');
  await page.waitForFunction(() => document.querySelectorAll('#search-results li').length > 0, null, { timeout: 15000 });
  const localHits = await page.locator('#search-results li').count();
  check('本地 GeoNames 命中', localHits > 0, `${localHits} 条`);
  check('本地命中带 GeoNames 标识', (await page.locator('#search-results li').first().textContent()).includes('GeoNames'));
  await shot(page, 'search');

  console.log('· 选用搜索结果 → 收藏');
  await page.locator('#search-results li .btn').first().click();
  await page.waitForFunction(() => document.getElementById('search').hidden, null, { timeout: 5000 });
  await page.click('#fav-list-btn');
  await page.waitForFunction(() => !document.getElementById('favorites').hidden, null, { timeout: 5000 });
  const favCount = parseInt((await page.locator('#favorites-count').textContent()).match(/\d+/)?.[0] || '0', 10);
  check('收藏数 ≥ 1', favCount >= 1, `${favCount} 个`);
  await shot(page, 'favorites');
  await page.keyboard.press('Escape');

  console.log('· 详情页');
  await page.click('#detail-btn');
  await page.waitForFunction(() => !document.getElementById('detail').hidden, null, { timeout: 5000 });
  const detailText = await page.locator('#detail').textContent();
  check('详情含高度角数值', /\d+\.\d{2}°/.test(await page.locator('#detail-alt').textContent()), await page.locator('#detail-alt').textContent());
  check('详情含方位角数值', /\d+\.\d{2}°/.test(await page.locator('#detail-az').textContent()));
  check('详情含日长或极地文案', (await page.locator('#detail-day').textContent()).match(/小时|极昼|极夜/) !== null);
  check('详情含正午高度角', /\d+\.\d{2}°/.test(await page.locator('#detail-noon-alt').textContent()));
  check('详情影长比是纯数值', /^[\d.]+$/.test((await page.locator('#detail-shadow').textContent()).trim()) || (await page.locator('#detail-shadow').textContent()) === '—', await page.locator('#detail-shadow').textContent());
  check('详情有民用时或无时区说明', /民用时|日出/.test(detailText));
  await shot(page, 'detail');
  await page.keyboard.press('Escape');

  console.log('· 关于页与署名');
  await page.click('#about-btn');
  await page.waitForFunction(() => !document.getElementById('about').hidden, null, { timeout: 5000 });
  const about = await page.locator('#about').textContent();
  check('关于页署名 NASA', about.includes('NASA'));
  check('关于页署名 GeoNames', about.includes('GeoNames'));
  check('关于页署名 OpenStreetMap', about.includes('OpenStreetMap'));
  await shot(page, 'about');
  await page.keyboard.press('Escape');

  console.log('· 非当前地点详情与空时区规则');
  await page.evaluate(() => {
    localStorage.setItem('dangwu:v1:favorites', JSON.stringify([
      { v: 2, id: 'fix:beijing', name: '北京', latitude: 39.9042, longitude: 116.4074, tzOffsetMin: 480, timeZoneId: null, sortOrder: 1 },
      { v: 2, id: 'fix:suva', name: '苏瓦', latitude: -18.1417, longitude: 178.4417, tzOffsetMin: null, timeZoneId: null, sortOrder: 2 },
    ]));
    localStorage.setItem('dangwu:v1:selected', 'fix:beijing');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => /^\d{2}:\d{2}:\d{2}$/.test((document.getElementById('tst') || {}).textContent || ''), null, { timeout: 20000 });
  await page.click('#fav-list-btn');
  await page.waitForFunction(() => !document.getElementById('favorites').hidden, null, { timeout: 5000 });
  await page.locator('#favorites-list li', { hasText: '苏瓦' }).locator('button', { hasText: '详情' }).click();
  await page.waitForFunction(() => !document.getElementById('detail').hidden, null, { timeout: 5000 });
  const detailEvents = await page.locator('#detail-events').textContent();
  const homeEvents = await page.locator('#sun').textContent();
  check('详情打开的是所选地点', (await page.locator('#detail-name').textContent()).trim() === '苏瓦');
  check('空时区详情不出现民用时行', !detailEvents.includes('民用时'), detailEvents.trim());
  check('详情事件按该地点计算而非当前地点',
    detailEvents.replace(/\s+/g, '').slice(0, 20) !== homeEvents.replace(/\s+/g, '').slice(0, 20),
    `详情=${detailEvents.trim().slice(0, 40)} 首页=${homeEvents.trim().slice(0, 40)}`);
  await shot(page, 'detail-null-tz');
  await page.keyboard.press('Escape');

  console.log('· Service Worker');
  let registration = null;
  for (let i = 0; i < 40 && !registration; i++) {
    registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active?.scriptURL || null;
    });
    if (!registration) await page.waitForTimeout(500);
  }
  check('Service Worker 已激活', typeof registration === 'string' && registration.includes('sw.js'), String(registration));
  const cacheKeys = await page.evaluate(() => caches.keys());
  check('核心缓存已建立', cacheKeys.some((k) => k.includes('core')), cacheKeys.join(','));
  check('缓存版本已升级', cacheKeys.some((k) => /v2/.test(k)), cacheKeys.join(','));
  const precached = await page.evaluate(async () => {
    const cache = await caches.match('./src/data/cities.json');
    return !!cache;
  });
  check('GeoNames 索引已预缓存', precached);

  console.log('· 离线刷新（飞行模式等价）');
  await page.reload({ waitUntil: 'load' });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById('tst');
    return t && /^\d{2}:\d{2}:\d{2}$/.test(t.textContent.trim());
  }, null, { timeout: 20000 });
  check('离线仍出帧', /^\d{2}:\d{2}:\d{2}$/.test((await page.locator('#tst').textContent()).trim()));
  const offFav = await page.evaluate(() => JSON.parse(localStorage.getItem('dangwu:v1:favorites') || '[]').length);
  check('离线保留收藏', offFav >= 1, `${offFav} 个`);
  await page.click('#search-btn');
  await page.fill('#search-input', '上海');
  await page.waitForFunction(() => document.querySelectorAll('#search-results li').length > 0, null, { timeout: 15000 });
  check('离线本地搜索可用', (await page.locator('#search-results li').count()) > 0);
  await shot(page, 'offline');
  await context.setOffline(false);

  const realErrors = consoleErrors.filter((t) => !/Failed to load resource/.test(t));
  check('无 4xx/5xx 资源', badResponses.length === 0, badResponses.slice(0, 5).join(' | '));
  check('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (error) {
  failures.push(`脚本异常：${error.message}`);
  console.log(`  ✗ 脚本异常：${error.message}`);
  await shot(page, 'failure').catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n════ 冒烟 通过 ${passed} / 失败 ${failures.length} ════`);
if (failures.length) {
  for (const f of failures) console.log(`  ! ${f}`);
  console.log(`截图：${SHOTS}`);
  process.exit(1);
}
console.log(`截图：${SHOTS}`);
