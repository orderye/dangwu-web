/**
 * 生成 shared/golden/cases.json（双端共用的唯一真相源）。
 * 数值由本文件引用的参考实现 solar.js 产生；其正确性由 tools/cross-check.mjs
 * 对 astronomy-engine v2 与 suncalc 的独立交叉验证保证（见 cases.json 内 verification 字段）。
 * 用法：npm run gen-golden
 */
import * as solar from '../src/core/solar.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r6 = (x) => Math.round(x * 1e6) / 1e6;  // golden 保留 6 位小数

// ── EoT / 赤纬用例（含全年极值与过零日） ──
const eotTimes = [
  '2024-02-11T00:00:00Z', '2024-04-15T00:00:00Z', '2024-05-14T00:00:00Z', '2024-07-26T00:00:00Z',
  '2024-09-01T00:00:00Z', '2024-11-03T00:00:00Z', '2024-12-25T00:00:00Z',
  '2024-06-21T12:00:00Z', '2024-12-21T12:00:00Z', '2024-03-20T12:00:00Z',
  '2026-03-20T12:00:00Z', '2026-11-03T12:00:00Z', '2050-01-01T12:00:00Z', '2060-06-01T12:00:00Z',
];

// ── 日出日落 / 极昼极夜用例 ──
const places = [
  { name: '北京', lat: 39.9, lon: 116.41 },
  { name: '悉尼', lat: -33.87, lon: 151.21 },
  { name: '苏瓦', lat: -18.14, lon: 178.44 },       // 跨国际日界线回归
  { name: '特罗姆瑟', lat: 69.65, lon: 18.96 },      // 极昼 / 极夜
  { name: '伦敦', lat: 51.51, lon: -0.13 },
  { name: '雷克雅未克', lat: 64.15, lon: -21.94 },
];
const eventTimes = ['2024-06-21T12:00:00Z', '2024-12-21T12:00:00Z',
                    '2024-03-20T12:00:00Z', '2026-06-21T12:00:00Z'];

// ── 高度角 / 方位角用例 ──
const altAzTimes = ['2024-06-21T02:00:00Z', '2024-06-21T10:00:00Z', '2024-06-21T18:00:00Z',
                    '2024-12-21T05:00:00Z', '2024-12-21T12:00:00Z', '2024-03-20T12:00:00Z',
                    '2026-03-20T12:00:00Z'];

const eot = eotTimes.map((utc) => {
  const d = new Date(utc);
  const { decl, eotMin } = solar.solarCalc(d);
  return { utc, eotMin: r6(eotMin), decl: r6(decl) };
});

const events = [];
for (const p of places) {
  for (const utc of eventTimes) {
    const d = new Date(utc);
    const { eotMin } = solar.solarCalc(d);
    const ev = solar.sunEvents(d, p.lat, p.lon);
    const row = { utc, lat: p.lat, lon: p.lon, eotMin: r6(eotMin), name: p.name };
    if (ev.polar) {
      row.polar = ev.polar;
    } else {
      Object.assign(row, {
        noonUtcMin: r6(ev.noon), sunriseUtcMin: r6(ev.sunrise),
        sunsetUtcMin: r6(ev.sunset), dayLenMin: r6(ev.dayLen),
        noonTST: r6(solar.toTST(ev.noon, p.lon, eotMin)),
        sunriseTST: r6(solar.toTST(ev.sunrise, p.lon, eotMin)),
        sunsetTST: r6(solar.toTST(ev.sunset, p.lon, eotMin)),
      });
    }
    events.push(row);
  }
}

const altAz = [];
for (const p of places) {
  for (const utc of altAzTimes) {
    const { alt, az } = solar.solarAltAz(new Date(utc), p.lat, p.lon);
    altAz.push({ utc, lat: p.lat, lon: p.lon, alt: r6(alt), az: r6(az) });
  }
}

const shichenTST = [0, 59, 60, 119, 120, 239, 240, 300, 359, 360, 420, 540, 719, 720, 780,
                    1260, 1379, 1380, 1439];

const data = {
  v: 1,
  generatedAt: '2026-09-10',
  generatedBy: 'dangwu-web/src/core/solar.js（NOAA 简化太阳算法，含光行差与章动修正项）',
  verifiedAgainst: {
    'astronomy-engine': '2.1.19（Alan M. MacDonald 高精度星历，独立实现）',
    'suncalc': '2.0.2（独立实现）',
  },
  verification: 'tools/cross-check.mjs 三源对照：EoT ≤ 12 秒、赤纬 ≤ 0.13 角分、日出日落 ≤ 1.45 分、' +
                '高度角 ≤ 0.01°、方位角 ≤ 0.02°；极昼极夜判定与 AE 一致。',
  notes: {
    events: 'noon/sunrise/sunset 的 UtcMin 为引擎输出（UTC 当日分钟）；TST 字段为 toTST 换算后的显示口径。',
    altAz: 'alt/az 为几何量（无大气折光），az 自北顺时针。',
    '12utcIdentity': '任意日 12:00 UTC：subsolarLon ≡ -eotMin/4（度）。',
    'subsolarTST': '任意时刻：直射点经度处真太阳时 ≡ 720 分。',
  },
  tolerances: {
    eotMin: 0.5,          // 与高精度引擎对照的历史余量（实测 ≤0.2 分）
    declDeg: 0.2,         // 实测 ≤0.0022°
    eventMin: 3,          // 实测 ≤1.45 分（特罗姆瑟春分近极界）
    altDeg: 0.02,         // 实测 ≤0.0091°
    azDeg: 0.2,           // 实测 ≤0.0141°
    identityDeg: 0.01,
    identityMin: 0.5,
    dualEndMin: 0.001,    // JS vs Kotlin 同输入 diff（双端一致性红线）
    dualEndDeg: 0.0001,
  },
  cases: { eot, events, altAz, shichen: shichenTST.map((t) => ({ tst: t, value: solar.shichen(t) })) },
};

const out = new URL('../../shared/golden/cases.json', import.meta.url);
writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(`已写入 ${fileURLToPath(out)}`);
console.log(`  eot ${eot.length} 条 | events ${events.length} 条（其中极昼极夜 ${events.filter((e) => e.polar).length} 条）` +
            ` | altAz ${altAz.length} 条 | shichen ${shichenTST.length} 条`);
