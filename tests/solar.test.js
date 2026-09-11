/**
 * 当午 · 太阳引擎测试（零依赖，node 直接运行：npm test）
 *  - golden：与 shared/golden/cases.json 对账（该文件由参考实现生成，并经两套独立算法交叉验证）
 *  - invariants：不依赖 JSON 的自洽恒等式与格式约定
 *  - dual-end：若 shared/golden/kt-output.json 存在，则与 Kotlin 端同输入输出做 diff（红线 0.001 分钟）
 */
import * as solar from '../src/core/solar.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GOLDEN = new URL('../../shared/golden/cases.json', import.meta.url);
const KT_OUT = new URL('../../shared/golden/kt-output.json', import.meta.url);
const data = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const T = data.tolerances;

let pass = 0, fail = 0;
const fmt = (v) => (typeof v === 'number' ? +v.toFixed(6) : v);
function eq(name, actual, expected, tol) {
  const d = Math.abs(actual - expected);
  if (d <= tol) { pass++; return true; }
  fail++;
  console.log(`  ✗ ${name}: 实得 ${fmt(actual)}，期望 ${fmt(expected)}（容差 ${tol}，偏差 ${fmt(d)}）`);
  return false;
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
}

// ═══════════════ 1) golden：EoT 与赤纬 ═══════════════
console.log(`1) golden · EoT / 赤纬（${data.cases.eot.length} 例）`);
for (const c of data.cases.eot) {
  const got = solar.solarCalc(new Date(c.utc));
  eq(`EoT @ ${c.utc}`, got.eotMin, c.eotMin, 1e-6);
  eq(`赤纬 @ ${c.utc}`, got.decl, c.decl, 1e-6);
}

// ═══════════════ 2) golden：日出日落 / 极昼极夜 ═══════════════
console.log(`2) golden · 日出日落 / 极昼极夜（${data.cases.events.length} 例）`);
for (const c of data.cases.events) {
  const d = new Date(c.utc);
  const sp = solar.solarCalc(d);
  const ev = solar.sunEvents(d, c.lat, c.lon);
  const tag = `${c.name} ${c.utc.slice(0, 10)}`;
  ok(`${tag} 极昼极夜判定`, (ev.polar ?? null) === (c.polar ?? null),
     `实得 ${ev.polar ?? '无'}，期望 ${c.polar ?? '无'}`);
  if (ev.polar) continue;
  eq(`${tag} 正午(UTC分)`, ev.noon, c.noonUtcMin, 1e-6);
  eq(`${tag} 日出(UTC分)`, ev.sunrise, c.sunriseUtcMin, 1e-6);
  eq(`${tag} 日落(UTC分)`, ev.sunset, c.sunsetUtcMin, 1e-6);
  eq(`${tag} 日长(分)`, ev.dayLen, c.dayLenMin, 1e-6);
  // 显示层换算一致性（TST 口径）
  eq(`${tag} 正午(TST)`, solar.toTST(ev.noon, c.lon, sp.eotMin), c.noonTST, 1e-6);
  eq(`${tag} 日出(TST)`, solar.toTST(ev.sunrise, c.lon, sp.eotMin), c.sunriseTST, 1e-6);
  eq(`${tag} 日落(TST)`, solar.toTST(ev.sunset, c.lon, sp.eotMin), c.sunsetTST, 1e-6);
  // 真太阳时口径的题中应有之义：正午恒为 12:00
  eq(`${tag} 正午 TST = 12:00`, solar.toTST(ev.noon, c.lon, sp.eotMin), 720, 1e-6);
}

// ═══════════════ 3) golden：高度角 / 方位角 ═══════════════
console.log(`3) golden · 高度角 / 方位角（${data.cases.altAz.length} 例）`);
for (const c of data.cases.altAz) {
  const got = solar.solarAltAz(new Date(c.utc), c.lat, c.lon);
  eq(`${c.utc.slice(0, 10)} (${c.lat}N,${c.lon}E) 高度角`, got.alt, c.alt, 1e-6);
  eq(`${c.utc.slice(0, 10)} (${c.lat}N,${c.lon}E) 方位角`, got.az, c.az, 1e-6);
}

// ═══════════════ 4) golden：十二时辰 ═══════════════
console.log(`4) golden · 十二时辰（${data.cases.shichen.length} 例）`);
for (const c of data.cases.shichen) ok(`TST ${c.tst} 分 → ${c.value}`, solar.shichen(c.tst) === c.value,
  `实得 ${solar.shichen(c.tst)}`);

// ═══════════════ 5) invariants：自洽恒等式与边界 ═══════════════
console.log('5) invariants · 自洽恒等式 / 格式 / 边界');
for (const utc of ['2024-02-11T00:00:00Z', '2024-06-21T12:00:00Z', '2024-11-03T12:00:00Z',
                   '2026-01-15T08:00:00Z', '2050-07-21T12:00:00Z']) {
  const d = new Date(utc);
  const { eotMin } = solar.solarCalc(d);
  const sub = solar.subsolarLon(d, eotMin);
  // 直射点经度处真太阳时恒为 12:00
  eq(`${utc} 直射点处 TST`, solar.trueSolarMin(d, sub, eotMin), 720, T.identityMin);
  // 直射点经度范围 (-180, 180]
  ok(`${utc} 直射点经度范围`, sub > -180 && sub <= 180, `实得 ${sub}`);
  if (solar._internal.utcMin(d) === 720) {
    eq(`${utc} 12:00 UTC 直射点 = -EoT/4`, sub, -eotMin / 4, T.identityDeg);
  }
}
// 经度修正方向：向东 15° = 快 1 小时
eq('向东 15° 快 1 小时', solar.trueSolarMin(new Date('2024-01-01T12:00:00Z'), 15, 0) -
                     solar.trueSolarMin(new Date('2024-01-01T12:00:00Z'), 0, 0), 60, 1e-9);
// 跨午夜换算：东经 15° 处 UTC 23:00 = 真太阳时次日 00:00
eq('toTST 跨午夜归零', solar.toTST(1380, 15, 0), 0, 1e-9);
eq('toTST 东经 15° 快 1 小时', solar.toTST(720, 15, 0), 780, 1e-9);
ok('toCivil 空偏移返回 null', solar.toCivil(100, null) === null);
eq('toCivil 北京 +8', solar.toCivil(60, 480), 540, 1e-9);
// 格式化
ok('fmtHMS 形态', solar.fmtHMS(720) === '12:00:00', solar.fmtHMS(720));
ok('fmtHM 形态', solar.fmtHM(720) === '12:00', solar.fmtHM(720));
ok('fmtHMS 带秒', solar.fmtHMS(1380.5) === '23:00:30', solar.fmtHMS(1380.5));
ok('fmtHMS 午夜回绕', solar.fmtHMS(1440) === '00:00:00', solar.fmtHMS(1440));
ok('fmtHM 午夜回绕', solar.fmtHM(1440) === '00:00', solar.fmtHM(1440));
// fmtHM 必须是 fmtHMS 的前 5 位（两套格式不得各算各的）
let fmtConsistent = true;
for (let m = 0; m <= 1440; m += 0.25) {
  if (solar.fmtHM(m) !== solar.fmtHMS(m).slice(0, 5)) fmtConsistent = false;
}
ok('fmtHM 与 fmtHMS 前缀一致（0–1440 分全程）', fmtConsistent);
// 极点输入不崩溃
for (const lat of [90, -90, 89.99, -89.99]) {
  const ev = solar.sunEvents(new Date('2024-06-21T12:00:00Z'), lat, 0);
  ok(`极点 ${lat} 日出日落显示 —`, ev.polar !== null, String(ev));
}

// ═══════════════ 6) dual-end：JS vs Kotlin diff ═══════════════
console.log('6) dual-end · JS vs Kotlin（容差 ' + T.dualEndMin + ' 分钟 / ' + T.dualEndDeg + ' 度）');
if (!existsSync(KT_OUT)) {
  console.log(`  · 跳过：未找到 ${fileURLToPath(KT_OUT)}（运行 dangwu-android/tools/run-kt-probe.sh 生成）`);
} else {
  const kt = JSON.parse(readFileSync(KT_OUT, 'utf8'));
  console.log(`  · Kotlin 实现：${kt.impl}`);
  for (const row of kt.cases ?? []) {
    const tag = `${row.name} ${row.utc}`;
    const d = new Date(row.utc);
    const sp = solar.solarCalc(d);
    eq(`EoT @ ${tag}`, sp.eotMin, row.eotMin, T.dualEndMin);
    eq(`赤纬 @ ${tag}`, sp.decl, row.decl, T.dualEndDeg);
    eq(`直射点 @ ${tag}`, solar.subsolarLon(d, sp.eotMin), row.subsolarLon, T.dualEndDeg);
    eq(`真太阳时 @ ${tag}`, solar.trueSolarMin(d, row.lon, sp.eotMin), row.trueSolarMin, T.dualEndMin);
    eq(`平太阳时 @ ${tag}`, solar.meanSolarMin(d, row.lon),
       solar._internal.mod(solar._internal.utcMin(d) + row.lon * 4, 1440), 1e-9);
    const ev = solar.sunEvents(d, row.lat, row.lon);
    ok(`极昼极夜判定 @ ${tag}`, (ev.polar ?? null) === (row.polar ?? null),
       `JS ${ev.polar} / KT ${row.polar}`);
    eq(`正午(UTC分) @ ${tag}`, ev.noon, row.noonUtcMin, 1e-6);
    for (const [key, ktKey] of [['sunrise', 'sunriseUtcMin'], ['sunset', 'sunsetUtcMin'], ['dayLen', 'dayLenMin']]) {
      if (ev.polar) {
        ok(`${key} 在极地事件下为 null @ ${tag}`, row[ktKey] === null, `KT 实得 ${row[ktKey]}`);
      } else {
        eq(`${key}(UTC分) @ ${tag}`, ev[key], row[ktKey], 1e-6);
      }
    }
    const az = solar.solarAltAz(d, row.lat, row.lon);
    eq(`高度角 @ ${tag}`, az.alt, row.alt, T.dualEndDeg);
    eq(`方位角 @ ${tag}`, az.az, row.az, T.dualEndDeg);
  }
  for (const c of kt.shichen ?? []) {
    ok(`时辰 @ ${c.tst} 分 → ${c.value}`, solar.shichen(c.tst) === c.value,
       `JS ${solar.shichen(c.tst)} / KT ${c.value}`);
  }
  const fmt = kt.fmt ?? {};
  ok('fmtHMS 720 一致', fmt['720'] === solar.fmtHMS(720), `${fmt['720']} vs ${solar.fmtHMS(720)}`);
  ok('fmtHMS 跨午夜一致', fmt['1440'] === solar.fmtHMS(1440), `${fmt['1440']} vs ${solar.fmtHMS(1440)}`);
  ok('fmtHM 720 一致', fmt['720hm'] === solar.fmtHM(720), `${fmt['720hm']} vs ${solar.fmtHM(720)}`);
  ok('fmtHM 跨午夜一致', fmt['1440hm'] === solar.fmtHM(1440), `${fmt['1440hm']} vs ${solar.fmtHM(1440)}`);
  const ktTST = solar.toTST(1380, 15, 0);
  ok('toTST 跨午夜双端一致', ktTST < 1e-9, `JS ${ktTST}`);
}

// ═══════════════ 结果 ═══════════════
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
console.log(`golden 容差参考：EoT ±${T.eotMin} 分 | 赤纬 ±${T.declDeg}° | 事件 ±${T.eventMin} 分 | ` +
            `高度角 ±${T.altDeg}° | 方位角 ±${T.azDeg}°`);
process.exit(fail === 0 ? 0 : 1);
