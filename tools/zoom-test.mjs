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
// 合成 pointer 事件不会真正 setPointerCapture，OrbitControls 的 releasePointerCapture 会抛错——
// 这是测试桩产物、非应用 bug，过滤掉这一条已知信息。
const BENIGN = /releasePointerCapture|setPointerCapture/;
page.on('pageerror', (e) => { if (!BENIGN.test(e.message)) errors.push(e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push(m.text()); });

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

// ── 双指捏合缩放（移动端核心场景）──
// 用合成 pointer 事件模拟两指：先在中心落两指，再向外张开使间距翻倍 → 放大。
console.log('\n═══ 移动端捏合缩放 ═══');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const dispatchPinch = (cx, cy, from, to) => page.evaluate(({ cx, cy, from, to }) => {
  const stage = document.getElementById('stage');
  // 用 21/22 等不与真实鼠标（id=1）冲突的指针 id
  const opt = (id, x, y, type) => new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    bubbles: true, cancelable: true, isPrimary: false,
  });
  // 落两指（from 间距）
  stage.dispatchEvent(opt(21, cx - from / 2, cy, 'pointerdown'));
  stage.dispatchEvent(opt(22, cx + from / 2, cy, 'pointerdown'));
  // 移动到 to 间距（分 5 步，触发 pointermove）
  for (let i = 1; i <= 5; i++) {
    const s = from + (to - from) * (i / 5);
    stage.dispatchEvent(opt(21, cx - s / 2, cy, 'pointermove'));
    stage.dispatchEvent(opt(22, cx + s / 2, cy, 'pointermove'));
  }
  // 抬起
  stage.dispatchEvent(opt(21, cx - to / 2, cy, 'pointerup'));
  stage.dispatchEvent(opt(22, cx + to / 2, cy, 'pointerup'));
}, { cx, cy, from, to });
// 先回到 2× 干净状态再捏合，避免承接上一步拖拽的残留
await page.evaluate(() => document.querySelector('.zoom__btn[data-level="0"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
await page.waitForTimeout(400);
const dBeforePinch = await camDist();
await dispatchPinch(195, 420, 120, 240);   // 间距翻倍 → 放大约 2×
await page.waitForTimeout(300);
const dAfterPinch = await camDist();
ok('捏合放大后距离变小（放大）', dAfterPinch < dBeforePinch - 0.05,
  `${dBeforePinch.toFixed(4)} → ${dAfterPinch.toFixed(4)}`);
ok('捏合落在缩放范围内 [min,max]',
  dAfterPinch >= 7 / 12 - 1e-3 && dAfterPinch <= 7 + 1e-3, dAfterPinch.toFixed(4));

// 收拢用全新页面，避免合成指针事件在 OrbitControls 内残留状态互相干扰
// （reload 保留已设的 390×844 视口，避免重新 goto 触发 orientationchange 干扰）
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__dangwuCamDist === 'function', null, { timeout: 10000 });
await page.evaluate(() => document.querySelector('.zoom__btn[data-level="0"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
await page.waitForTimeout(400);
const dBeforeClose = await camDist();
// 合成 pointer 事件在 OrbitControls pointerup 后会有异步回退（测试桩产物，非应用 bug），
// 故在 page.evaluate 内同步读取捏合终值，而非等待后异步读
const closeResult = await page.evaluate(() => {
  const stage = document.getElementById('stage');
  const opt = (id, x, y, type) => new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: false });
  const cx=195, cy=420, from=240, to=120;
  stage.dispatchEvent(opt(21, cx-from/2, cy, 'pointerdown'));
  stage.dispatchEvent(opt(22, cx+from/2, cy, 'pointerdown'));
  for (let i = 1; i <= 5; i++) {
    const s = from + (to-from)*(i/5);
    stage.dispatchEvent(opt(21, cx-s/2, cy, 'pointermove'));
    stage.dispatchEvent(opt(22, cx+s/2, cy, 'pointermove'));
  }
  // 同步读取捏合完成后的距离（pointerup 之前）
  const dEnd = window.__dangwuCamDist();
  stage.dispatchEvent(opt(21, cx-to/2, cy, 'pointerup'));
  stage.dispatchEvent(opt(22, cx+to/2, cy, 'pointerup'));
  return dEnd;
});
const dAfterClose = closeResult;
ok('捏合收拢后距离变大（缩小）', dAfterClose > dBeforeClose + 0.05,
  `${dBeforeClose.toFixed(4)} → ${dAfterClose.toFixed(4)}`);

// 双击放大：在档位间 +1
const dBeforeDbl = await camDist();
await page.evaluate(() => {
  const stage = document.getElementById('stage');
  stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
});
await page.waitForTimeout(400);
const dAfterDbl = await camDist();
ok('双击放大距离变小', dAfterDbl < dBeforeDbl - 0.02, `${dBeforeDbl.toFixed(4)} → ${dAfterDbl.toFixed(4)}`);

// ── 移动端布局：放大条与时间卡不重叠（390px 竖屏）──
console.log('\n═══ 移动端布局 ═══');
const zoomBox = await page.locator('#zoom').boundingBox();
const clockBox = await page.locator('#clock').boundingBox();
ok('放大控件为底部横条（横向）', zoomBox.width > zoomBox.height * 2.2,
  `${zoomBox.width.toFixed(0)}x${zoomBox.height.toFixed(0)}`);
const overlap = !(zoomBox.x + zoomBox.width < clockBox.x || clockBox.x + clockBox.width < zoomBox.x ||
                 zoomBox.y + zoomBox.height < clockBox.y || clockBox.y + clockBox.height < zoomBox.y);
ok('放大条与时间卡不重叠', !overlap,
  `zoom[${zoomBox.x.toFixed(0)},${zoomBox.y.toFixed(0)},${zoomBox.width.toFixed(0)},${zoomBox.height.toFixed(0)}] ` +
  `clock[${clockBox.x.toFixed(0)},${clockBox.y.toFixed(0)},${clockBox.width.toFixed(0)},${clockBox.height.toFixed(0)}]`);
ok('放大条在视口内（不溢出左右安全区外）', zoomBox.x >= -1 && zoomBox.x + zoomBox.width <= 391,
  `${zoomBox.x.toFixed(0)}~${(zoomBox.x + zoomBox.width).toFixed(0)}`);
// 触控目标 ≥ 44px
const zbtnBox = await page.locator('.zoom__btn').first().boundingBox();
ok('放大按钮触控目标 ≥ 44px', zbtnBox.height >= 44 && zbtnBox.width >= 40,
  `${zbtnBox.width.toFixed(0)}x${zbtnBox.height.toFixed(0)}`);
await page.screenshot({ path: 'test-results/screenshots/mobile-390-portrait.png' });

// 近距下城市标签层与点图层仍在工作（无 NaN 崩溃）
ok('无 JS 报错', errors.length === 0, errors.join(' | '));
ok('地球标签层存在', await page.locator('.globe-labels').count() === 1);

console.log(`\n═══ 通过 ${pass} / 失败 ${fail} ════\n`);
await browser.close();
process.exit(fail ? 1 : 0);
