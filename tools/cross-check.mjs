/**
 * 独立交叉验证：solar.js（NOAA 简化算法） vs
 *   ① astronomy-engine v2（Alan M. MacDonald 高精度星历，含光行差/章动/自行）
 *   ② suncalc（另一套完全独立的天文实现）
 * 三个来源彼此独立，用于在固化 shared/golden/cases.json 前确认科学正确性。
 * 依赖仅安装在本 tools/ 目录，不进入应用产物。
 */
import * as solar from '../src/core/solar.js';
import * as Ae from 'astronomy-engine';
import { createRequire } from 'node:module';
const SC = createRequire(import.meta.url)('suncalc');

const DEG = Math.PI / 180;
const mod = (a, n) => ((a % n) + n) % n;
const utcMinOfDay = (ms) => mod(ms, 86400000) / 60000;
const dayStartOf = (ms) => Math.floor(ms / 86400000) * 86400000;
const normEot = (x) => mod(x + 720, 1440) - 720;
const d2ms = (iso) => Date.parse(iso + 'Z');
const HORIZON_ANGLES = -0.833; // 折光 0.567° + 太阳视半径 0.266°
const MIN = 60000;

/** ① AE：某时刻太阳几何高度角（无大气折光，度） */
function aeAlt(ms, lat, lon) {
  const d = new Date(ms);
  const obs = new Ae.Observer(lat, lon, 0);
  const eq = Ae.Equator('Sun', d, obs, true, true);
  return Ae.Horizon(d, obs, eq.ra, eq.dec, false).altitude;
}

/** ① AE：求某日高度角穿越 −0.833° 的绝对时刻（毫秒） */
function aeCrossing(dayStart, lat, lon, wantRise) {
  let prev = aeAlt(dayStart, lat, lon);
  for (let i = 1; i <= 1440; i++) {
    const cur = aeAlt(dayStart + i * MIN, lat, lon);
    const cross = wantRise ? (prev < HORIZON_ANGLES && cur >= HORIZON_ANGLES)
                            : (prev >= HORIZON_ANGLES && cur < HORIZON_ANGLES);
    if (cross) {
      let a = dayStart + (i - 1) * MIN, b = dayStart + i * MIN;
      for (let k = 0; k < 60; k++) {
        const mid = (a + b) / 2;
        const m = aeAlt(mid, lat, lon);
        if (wantRise ? m < HORIZON_ANGLES : m > HORIZON_ANGLES) a = mid; else b = mid;
      }
      return (a + b) / 2;
    }
    prev = cur;
  }
  return null;
}

/** ① AE：正午（太阳高度角极大）绝对时刻，再按定义反推 EoT */
function aeNoonMs(dayStart, lat, lon) {
  let best = dayStart + 720 * MIN, bestAlt = -Infinity;
  for (let i = 0; i <= 1440; i++) {
    const t = dayStart + i * MIN;
    const a = aeAlt(t, lat, lon);
    if (a > bestAlt) { bestAlt = a; best = t; }
  }
  let lo = best - 3 * MIN, hi = best + 3 * MIN;
  for (let k = 0; k < 60; k++) {           // 三分法求 alt 极大
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (aeAlt(m1, lat, lon) < aeAlt(m2, lat, lon)) lo = m1; else hi = m2;
  }
  return (lo + hi) / 2;
}
function aeEotMin(ms, lon) {
  return normEot(720 - (utcMinOfDay(aeNoonMs(dayStartOf(ms), 0, lon)) + lon * 4));
}

let bad = 0;
const fail = (msg) => { bad++; console.log('  ✗ ' + msg); };
const minBetween = (a, b) => Math.abs(a - b) / MIN;
const f = (v) => (v == null ? '—'.padStart(5) : solar.fmtHM(v).padStart(5));

console.log('═══ 1) 时差 EoT（分钟）与赤纬（度）═══');
console.log('基准时刻(UTC)    我的EoT      AE独立EoT   ΔEoT(秒)    我的赤纬    AE赤纬   Δ赤纬(角分)');
const eotCases = [['2024-02-11', 0], ['2024-04-15', 0], ['2024-05-14', 0], ['2024-07-26', 0],
                  ['2024-09-01', 0], ['2024-11-03', 0], ['2024-12-25', 0],
                  ['2024-06-21', 12], ['2024-12-21', 12], ['2024-03-20', 12],
                  ['2026-03-20', 12], ['2026-11-03', 12], ['2050-01-01', 12], ['2060-06-01', 12]];
let maxEotSec = 0, maxDeclArcmin = 0;
for (const [iso, h] of eotCases) {
  const ms = d2ms(iso) + h * 3600000;
  const mine = solar.solarCalc(new Date(ms));
  const aeEot = aeEotMin(ms, 116.41);
  const aeDecl = Ae.Equator('Sun', new Date(ms), new Ae.Observer(0, 0, 0), true, true).dec;
  const dEotS = (mine.eotMin - aeEot) * 60;
  const dDecl = (mine.decl - aeDecl) * 60;
  maxEotSec = Math.max(maxEotSec, Math.abs(dEotS));
  maxDeclArcmin = Math.max(maxDeclArcmin, Math.abs(dDecl));
  if (Math.abs(dEotS) > 60) fail(`${iso} EoT 偏差 ${dEotS.toFixed(1)} 秒 > 60 秒`);
  if (Math.abs(dDecl) > 3) fail(`${iso} 赤纬偏差 ${dDecl.toFixed(2)} 角分 > 3 角分`);
  console.log(`${iso.slice(5)} ${String(h).padStart(2)}:00  ` +
    `${(mine.eotMin >= 0 ? '+' : '') + mine.eotMin.toFixed(3).padStart(9)}  ` +
    `${(aeEot >= 0 ? '+' : '') + aeEot.toFixed(3).padStart(10)}  ` +
    `${(dEotS >= 0 ? '+' : '') + dEotS.toFixed(1).padStart(7)}    ` +
    `${mine.decl.toFixed(3).padStart(8)}  ${aeDecl.toFixed(3).padStart(8)}  ` +
    `${(dDecl >= 0 ? '+' : '') + dDecl.toFixed(2)}`);
}

console.log('\n═══ 2) 日出/日落（比较绝对 UTC 时刻，显示为真太阳时）═══');
console.log('地点         基准(UTC)     我的日出    AE独立    Δ分    suncalc   我的日落    AE独立    Δ分    suncalc');
const places = [
  { name: '北京', lat: 39.9, lon: 116.41 },
  { name: '悉尼', lat: -33.87, lon: 151.21 },
  { name: '苏瓦·斐济', lat: -18.14, lon: 178.44 },
  { name: '特罗姆瑟', lat: 69.65, lon: 18.96 },
  { name: '伦敦', lat: 51.51, lon: -0.13 },
  { name: '雷克雅未克', lat: 64.15, lon: -21.94 },
];
const eventDays = [['2024-06-21', 12], ['2024-12-21', 12], ['2024-03-20', 12], ['2026-06-21', 12]];
let maxEventMin = 0;
for (const p of places) {
  for (const [iso, h] of eventDays) {
    const ms = d2ms(iso) + h * 3600000;
    const dayStart = dayStartOf(ms);
    const sp = solar.solarCalc(new Date(ms));
    const ev = solar.sunEvents(new Date(ms), p.lat, p.lon);
    if (ev.polar) {
      const noonAlt = aeAlt(ms, p.lat, p.lon);
      const expect = noonAlt > 0 ? 'DAY' : 'NIGHT';
      if (expect !== ev.polar) fail(`${p.name} ${iso} 极昼/极夜判定 ${ev.polar} ≠ AE ${expect}`);
      console.log(`${p.name.padEnd(12)} ${iso}   极${ev.polar.padEnd(6)}（AE 正午高度 ${noonAlt.toFixed(2).padStart(7)}°，判定${expect === ev.polar ? '一致' : '不一致 ✗'}）`);
      continue;
    }
    const mineR = dayStart + ev.sunrise * MIN, mineS = dayStart + ev.sunset * MIN;
    const aeR = aeCrossing(dayStart, p.lat, p.lon, true);
    const aeS = aeCrossing(dayStart, p.lat, p.lon, false);
    const sc = SC.getTimes(new Date(dayStart + 3600000), p.lat, p.lon);
    const scR = sc.sunrise instanceof Date ? sc.sunrise.getTime() : null;
    const scS = sc.sunset instanceof Date ? sc.sunset.getTime() : null;
    const dR = aeR == null ? NaN : minBetween(mineR, aeR);
    const dS = aeS == null ? NaN : minBetween(mineS, aeS);
    maxEventMin = Math.max(maxEventMin, dR, dS);
    if (!Number.isNaN(dR) && dR > 3) fail(`${p.name} ${iso} 日出偏差 ${dR.toFixed(2)} 分 > 3 分`);
    if (!Number.isNaN(dS) && dS > 3) fail(`${p.name} ${iso} 日落偏差 ${dS.toFixed(2)} 分 > 3 分`);
    const t = (m0) => solar.fmtHM(solar.toTST(utcMinOfDay(m0), p.lon, sp.eotMin));
    console.log(`${p.name.padEnd(12)} ${iso}   ${t(mineR).padStart(6)}  ${t(aeR).padStart(7)}  ` +
      `${dR.toFixed(2).padStart(5)}    ${t(scR).padStart(7)}   ${t(mineS).padStart(6)}  ${t(aeS).padStart(7)}  ` +
      `${dS.toFixed(2).padStart(5)}    ${t(scS).padStart(7)}`);
  }
}

console.log('\n═══ 3) 高度角 / 方位角（自北顺时针，度）═══');
console.log('地点         时刻(UTC)  高度角   Δalt(AE)   方位角    Δaz(AE)');
const spots = ['2024-06-21T02:00:00Z', '2024-06-21T10:00:00Z', '2024-06-21T18:00:00Z',
               '2024-12-21T05:00:00Z', '2024-12-21T12:00:00Z', '2024-03-20T12:00:00Z',
               '2026-03-20T12:00:00Z'];
let maxAltDeg = 0, maxAzDeg = 0;
for (const p of places) {
  for (const iso of spots) {
    const ms = Date.parse(iso);
    const mine = solar.solarAltAz(new Date(ms), p.lat, p.lon);
    const obs = new Ae.Observer(p.lat, p.lon, 0);
    const eq = Ae.Equator('Sun', new Date(ms), obs, true, true);
    const ae = Ae.Horizon(new Date(ms), obs, eq.ra, eq.dec, false);
    const dAlt = mine.alt - ae.altitude;
    const dAz = Math.abs(mod(mine.az - ae.azimuth + 180, 360) - 180);
    maxAltDeg = Math.max(maxAltDeg, Math.abs(dAlt));
    maxAzDeg = Math.max(maxAzDeg, dAz);
    if (Math.abs(dAlt) > 0.05) fail(`${p.name} ${iso} 高度角偏差 ${dAlt.toFixed(4)}° > 0.05°`);
    if (dAz > 0.15) fail(`${p.name} ${iso} 方位角偏差 ${dAz.toFixed(4)}° > 0.15°`);
    console.log(`${p.name.padEnd(12)} ${iso.slice(11, 16)}  ${mine.alt.toFixed(3).padStart(7)}  ` +
      `${(dAlt >= 0 ? '+' : '') + dAlt.toFixed(4).padStart(9)}   ${mine.az.toFixed(2).padStart(7)}  ` +
      `${dAz.toFixed(4)}`);
  }
}

console.log('\n═══ 4) 时辰边界（八字核心场景）═══');
// 子时 23-01 / 丑 01-03 / 寅 03-05 / 卯 05-07 / 辰 07-09 / 巳 09-11 / 午 11-13 / 未 13-15
// 申 15-17 / 酉 17-19 / 戌 19-21 / 亥 21-23（均按真太阳时）
const expShi = { 0: '子时', 59: '子时', 60: '丑时', 119: '丑时', 120: '丑时', 239: '寅时',
                 240: '寅时', 300: '卯时', 359: '卯时', 360: '卯时', 420: '辰时', 719: '午时',
                 720: '午时', 780: '未时', 1380: '子时', 1439: '子时' };
for (const [t, want] of Object.entries(expShi)) {
  const got = solar.shichen(Number(t));
  if (got !== want) fail(`TST ${t} 分应为 ${want}，实得 ${got}`);
  console.log(`  TST ${solar.fmtHM(Number(t))} → ${got}  ${got === want ? '✓' : '✗'}`);
}

console.log('\n═══ 5) 自洽恒等式 ═══');
for (const iso of ['2024-02-11T00:00:00Z', '2024-06-21T12:00:00Z', '2024-11-03T12:00:00Z', '2026-01-15T08:00:00Z']) {
  const ms = Date.parse(iso);
  const sp = solar.solarCalc(new Date(ms));
  if (utcMinOfDay(ms) === 720) {
    const dSub = Math.abs(solar.subsolarLon(new Date(ms), sp.eotMin) + sp.eotMin / 4);
    if (dSub > 0.01) fail(`${iso} 直射点经度自洽偏差 ${dSub.toFixed(4)}°`);
    console.log(`  12:00 UTC  ${iso.slice(0, 10)}: 直射点经度 ${solar.subsolarLon(new Date(ms), sp.eotMin).toFixed(3)}° = -EoT/4 ✓ (Δ ${dSub.toFixed(5)}°)`);
  }
  // 直射点经度处 TST ≡ 12:00
  const lonSub = solar.subsolarLon(new Date(ms), sp.eotMin);
  const tstAtSub = solar.trueSolarMin(new Date(ms), lonSub, sp.eotMin);
  const dT = Math.min(Math.abs(tstAtSub - 720), 1440 - Math.abs(tstAtSub - 720));
  if (dT > 0.5) fail(`${iso} 直射点处 TST 偏差 ${dT.toFixed(3)} 分`);
  console.log(`  ${iso.slice(11, 16)} UTC: 直射点(λ=${lonSub.toFixed(2)}°)处 TST = ${solar.fmtHM(tstAtSub)} ✓ (Δ ${dT.toFixed(5)} 分)`);
}

console.log(`\n═══ 汇总：EoT 最大偏差 ${maxEotSec.toFixed(1)} 秒 | 赤纬 ${maxDeclArcmin.toFixed(2)} 角分 | ` +
            `事件 ${maxEventMin.toFixed(2)} 分 | 高度角 ${maxAltDeg.toFixed(4)}° | 方位角 ${maxAzDeg.toFixed(4)}° ═══`);
console.log(`═══ 结果：${bad === 0 ? '全部一致 ✓（golden 数据可固化）' : bad + ' 处超限 ✗'} ═══`);
process.exit(bad === 0 ? 0 : 1);
