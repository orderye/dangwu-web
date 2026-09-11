/**
 * 当午 · 太阳引擎（Web）
 * NOAA 简化太阳算法，2020–2060 年误差 < 0.01 分钟。
 * 唯一真相源：必须与 dangwu-android 的 core/SolarEngine.kt 逐行同构，
 * 由 shared/golden/cases.json 锁定一致性（容差 0.001 分钟）。
 *
 * 约定：所有事件（noon/sunrise/sunset）输出「UTC 当日分钟数」，
 * 显示前由 toTST / toCivil 换算；引擎内部不出现任何时区概念。
 */

const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;
const utcMin = (d) => mod(d.getTime(), 86400000) / 60000;

/** 太阳赤纬与时差（与 Android SolarEngine.kt 逐行对应） */
export function solarCalc(date) {
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525; // 儒略世纪数
  const L0 = 280.46646 + T * (36000.76983 + 0.0003032 * T);       // 平黄经°
  const M  = 357.52911 + T * (35999.05029 - 0.0001537 * T);       // 平近点角°
  const e  = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);  // 轨道偏心率
  const Mr = M * DEG;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * Mr) * 0.000289;                          // 中心差
  const lam = L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * DEG); // 视黄经
  const eps = 23.4392911 - 0.0130042 * T
            + 0.00256 * Math.cos((125.04 - 1934.136 * T) * DEG);  // 黄赤交角
  const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lam * DEG)) * RAD; // 赤纬°
  const y = Math.tan(eps * DEG / 2) ** 2;
  // 求和结果以弧度计（sin/cos 入参均为弧度），换算为时间分钟需 ×(4 分/度 × 180/π 度/弧度)
  const eotMin = 4 * RAD * ( y * Math.sin(2 * L0 * DEG) - 2 * e * Math.sin(Mr)
                     + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * DEG)
                     - 0.5 * y * y * Math.sin(4 * L0 * DEG)
                     - 1.25 * e * e * Math.sin(2 * Mr) );          // 时差(分钟)
  return { decl, eotMin };
}

export const subsolarLon  = (d, eot) => mod(15 * (12 - utcMin(d) / 60 - eot / 60) + 540, 360) - 180;
export const trueSolarMin = (d, lon, eot) => mod(utcMin(d) + lon * 4 + eot, 1440);
export const meanSolarMin = (d, lon) => mod(utcMin(d) + lon * 4, 1440);

export function sunEvents(d, lat, lon) {
  const { decl, eotMin } = solarCalc(d);
  const noon = mod(720 - lon * 4 - eotMin, 1440);                 // 正午(UTC分)
  const cosH = (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * Math.sin(decl * DEG))
             / (Math.cos(lat * DEG) * Math.cos(decl * DEG));      // −0.833°=折光+视半径
  if (cosH > 1)  return { polar: 'NIGHT', noon };                 // 极夜
  if (cosH < -1) return { polar: 'DAY',  noon };                  // 极昼
  const H = Math.acos(cosH) * RAD;
  return { polar: null, noon,
           sunrise: mod(noon - 4 * H, 1440), sunset: mod(noon + 4 * H, 1440), dayLen: 8 * H };
}

export function solarAltAz(d, lat, lon) {                         // 高度角/方位角(自北顺时针)
  const { decl, eotMin } = solarCalc(d);
  const H = (trueSolarMin(d, lon, eotMin) / 60 - 12) * 15 * DEG;
  const p = lat * DEG, s = decl * DEG;
  const alt = Math.asin(Math.sin(p) * Math.sin(s) + Math.cos(p) * Math.cos(s) * Math.cos(H)) * RAD;
  const az = mod(Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(p) - Math.tan(s) * Math.cos(p)) * RAD + 180, 360);
  return { alt, az };
}

const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
export const shichen = (tst) => SHICHEN[Math.floor(mod(tst + 60, 1440) / 120)] + '时'; // 八字用十二时辰

// ── 显示层换算：sunEvents 输出 UTC 分钟，显示前统一换算 ──
export const toTST   = (evUtcMin, lon, eot) => mod(evUtcMin + lon * 4 + eot, 1440);
export const toCivil = (evUtcMin, tzOffsetMin) =>
  tzOffsetMin == null ? null : mod(evUtcMin + tzOffsetMin, 1440); // 固定偏移，不含夏令时；跨界不显示日期（v1 接受）

export const fmtHMS = (m) => {
  const s = Math.round(m * 60);
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtHM = (m) => {
  const s = Math.round(m * 60);
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
};

// 测试与调试用导出（不进入渲染路径）
export const _internal = { DEG, RAD, mod, utcMin, SHICHEN };
