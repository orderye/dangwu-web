/**
 * 时间卡渲染：主口径真太阳时；tzOffsetMin 非空时附一行民用时（固定偏移，不含夏令时）。
 */
import { fmtHMS, meanSolarMin, shichen } from '../core/solar.js';
import { eventLines } from './presentation.js';

export const fmtCoord = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

/** 副信息：平太阳时 · 时差 · 十二时辰 */
export function subLine(now, lon, eot, tst) {
  const e = `${eot >= 0 ? '+' : '−'}${Math.abs(eot).toFixed(1)} 分`;
  return `平太阳时 ${fmtHMS(meanSolarMin(now, lon))} · 时差 ${e} · <b>${shichen(tst)}</b>`;
}

/** 日出/正午/日落：真太阳时主行 +（可选）民用时附行 */
export function sunLine(ev, lon, eot, loc = {}, now = new Date()) {
  if (ev.polar) {
    return `<span class="polar">${ev.polar === 'DAY' ? '极昼' : '极夜'}</span>　日出与日落不适用`;
  }
  const lines = eventLines(now, ev, loc, lon, eot);
  return lines.primary + (lines.civil ? `<br><span class="civil">${lines.civil}</span>` : '');
}

/** 写入时间卡 DOM */
export function renderClock(el, loc, now, sp, tst, ev) {
  el.querySelector('#place-btn').textContent = loc.name || '未命名';
  el.querySelector('#place-coord').textContent = fmtCoord(loc.latitude, loc.longitude);
  el.querySelector('#tst').textContent = fmtHMS(tst);
  el.querySelector('#sub').innerHTML = subLine(now, loc.longitude, sp.eotMin, tst);
  el.querySelector('#sun').innerHTML = sunLine(ev, loc.longitude, sp.eotMin, loc, now);
}
