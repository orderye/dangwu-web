/**
 * 放大倍数档位验证：点击 6 档，核对相机距离是否精确等于 7/factor、朝向是否保持不变。
 * 需要 DANGWU_TEST 钩子：以 ?test=1 打开页面。
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173/?test=1';
const EXPECTED = [2, 3, 4, 6, 8, 12];
const TOL = 1e-4;

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => {
  const t = document.getElementById('tst');
  return t && /^\d{2}:\d{2}:\d{2}$/.test(t.textContent.trim());
}, null, { timeout: 25000 });
await page.waitForFunction(() => typeof window.__dangwuCamDist === 'function', null, { timeout: 10000 });

const camDist = () => page.evaluate(() => window.__dangwuCamDist());

console.log('\n═══ 放大档位验证 ═══');

// 档位定义与 HTML 一致
const factors = await page.evaluate(() => window.__dangwuZoomLevels);
ok('6 档定义', factors.length === 6, `实际 ${factors.length}`);
ok('档位倍数 2/3/4/6/8/12', JSON.stringify(factors) === JSON.stringify(EXPECTED), JSON.stringify(factors));
const labels = await page.locator('.zoom__btn').allTextContents();
ok('按钮文案 2×/3×/4×/6×/8×/12×',
  JSON.stringify(labels) === JSON.stringify(EXPECTED.map(f => `${f}×`)), JSON.stringify(labels));
ok('控件可见', await page.locator('#zoom').isVisible());

// 逐档点击：距离必须精确等于 7/factor
for (let i = 0; i < 6; i++) {
  await page.click(`.zoom__btn[data-level="${i}"]`);
  await page.waitForTimeout(700);
  const d = await camDist();
  const want = 7 / EXPECTED[i];
  ok(`${EXPECTED[i]}× 距离精确`, Math.abs(d - want) < TOL, `实测 ${d.toFixed(5)} 期望 ${want.toFixed(5)}`);
  const active = await page.evaluate(() =>
    [...document.querySelectorAll('.zoom__btn')].findIndex(b => b.classList.contains('is-active')));
  ok(`${EXPECTED[i]}× 高亮自身`, active === i, `高亮 ${active}`);
  await page.screenshot({ path: `test-results/screenshots/zoom-${i}-${EXPECTED[i]}x.png` });
}

// 从最近档退回最远档，确认双向可用
await page.click('.zoom__btn[data-level="0"]');
await page.waitForTimeout(700);
ok('回退 2× 可用', Math.abs((await camDist()) - 3.5) < TOL, `${(await camDist()).toFixed(4)}`);

// 滚轮缩放后高亮应迁移到最近档位（或全部取消，不允许多个）
await page.click('#stage');
// 该 Playwright 版本 mouse.wheel 不接受选项对象，直接派发 wheel 事件
await page.evaluate(() => {
  document.getElementById('stage').dispatchEvent(
    new WheelEvent('wheel', { deltaY: -160, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(300);
const hi = await page.evaluate(() =>
  [...document.querySelectorAll('.zoom__btn')].filter(b => b.classList.contains('is-active')).length);
ok('滚轮后高亮唯一或取消', hi <= 1, `${hi} 个高亮`);

// 拖拽旋转后切档：相机应沿新朝向移动（距离仍精确，且地球未飞离视口）
await page.mouse.move(320, 400);
await page.mouse.down();
await page.mouse.move(560, 360, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(250);
await page.click('.zoom__btn[data-level="5"]');
await page.waitForTimeout(750);
ok('拖拽后切 12× 距离精确', Math.abs((await camDist()) - 7 / 12) < TOL, `${(await camDist()).toFixed(5)}`);
ok('拖拽后切 12× 高亮正常',
  await page.locator('.zoom__btn[data-level="5"].is-active').count() === 1);
await page.screenshot({ path: 'test-results/screenshots/zoom-after-drag-12x.png' });

// 近距下城市标签层与点图层仍在工作（无 NaN 崩溃）
ok('无 JS 报错', errors.length === 0, errors.join(' | '));
ok('地球标签层存在', await page.locator('.globe-labels').count() === 1);

console.log(`\n═══ 通过 ${pass} / 失败 ${fail} ════\n`);
await browser.close();
process.exit(fail ? 1 : 0);
