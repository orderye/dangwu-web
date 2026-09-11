/**
 * 地点详情面板：查看选中地点的太阳高度角、方位角、日出/正午/日落、
 * 日长、太阳正午高度、影长比（物高 / 影长 = tan(alt) 的倒数）。
 * 数据由 main.js 每秒刷新；本模块负责渲染与复制坐标。
 */
import { fmtCoord } from '../ui/clock.js';
import { solarCalc, sunEvents, solarAltAz, fmtHM, shichen, trueSolarMin } from '../core/solar.js';
import { eventLines } from './presentation.js';

let _onClose = null;
let _onSelectFromDetail = null;
let _onCopy = null;
let _onAddToCompare = null;
let _loc = null;

export function initDetails({ onClose, onSelectFromDetail, onCopy, onAddToCompare } = {}) {
  _onClose = onClose;
  _onSelectFromDetail = onSelectFromDetail;
  _onCopy = onCopy;
  _onAddToCompare = onAddToCompare;
  document.getElementById('detail-close').addEventListener('click', closeDetails);
  document.getElementById('detail-select').addEventListener('click', () => {
    if (_loc) _onSelectFromDetail?.(_loc);
  });
  document.getElementById('detail-copy').addEventListener('click', () => {
    if (_loc) _onCopy?.(_loc);
  });
  document.getElementById('detail-compare').addEventListener('click', () => {
    if (_loc) _onAddToCompare?.(_loc);
  });
  const el = document.getElementById('detail');
  el.addEventListener('click', (e) => { if (e.target === el) closeDetails(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) closeDetails(); });
}

export function openDetails(loc) {
  _loc = loc;
  document.getElementById('detail').hidden = false;
  refreshDetails(loc, new Date());
}

export function closeDetails() {
  document.getElementById('detail').hidden = true;
  _onClose?.();
}

/** 渲染详情（主口径真太阳时，民用时作为附行）。 */
export function refreshDetails(loc, now = new Date(), sp, ev) {
  _loc = loc;
  if (sp === undefined) sp = solarCalc(now);
  if (ev === undefined) ev = sunEvents(now, loc.latitude, loc.longitude);
  if (!sp || !ev) return;
  const tst = trueSolarMin(now, loc.longitude, sp.eotMin);
  const altAz = solarAltAz(now, loc.latitude, loc.longitude);
  const dayLen = ev.dayLen == null ? null : ev.dayLen / 60; // 分钟 → 小时
  const noonAlt = 90 - Math.abs(loc.latitude - sp.decl);
  const shadow = altAz.alt > 0.5 ? (1 / Math.tan(altAz.alt * Math.PI / 180)).toFixed(2) : '—';

  document.getElementById('detail-name').textContent = loc.name;
  document.getElementById('detail-coord').textContent = fmtCoord(loc.latitude, loc.longitude);
  document.getElementById('detail-tst').textContent = fmtHM(tst);
  document.getElementById('detail-az').textContent = `${altAz.az.toFixed(2)}°`;
  document.getElementById('detail-alt').textContent = `${altAz.alt.toFixed(2)}°`;
  document.getElementById('detail-day').textContent = dayLen == null ? '极昼 / 极夜' : `${dayLen.toFixed(2)} 小时`;
  document.getElementById('detail-shadow').textContent = shadow;
  document.getElementById('detail-noon-alt').textContent = `${noonAlt.toFixed(2)}°`;
  const lines = eventLines(now, ev, loc, loc.longitude, sp.eotMin);
  document.getElementById('detail-events').innerHTML = lines.primary +
    (lines.civil ? `<br><span class="civil">${lines.civil}</span>` : '');
  document.getElementById('detail-shichen').textContent = shichen(tst);
}

/** 复制坐标到剪贴板（含 fallback）。 */
export function copyDetailCoords(loc) {
  const text = `${loc.name} ${fmtCoord(loc.latitude, loc.longitude)}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('坐标已复制'), () => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('坐标已复制'); } catch { toast('复制失败，请手动复制'); }
  ta.remove();
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}