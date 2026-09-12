import { fmtHM, toCivil, toTST } from '../core/solar.js';

function eventDate(date, utcMinutes) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + utcMinutes * 60000);
}

export function formatCivilEvent(date, utcMinutes, loc) {
  if (utcMinutes == null) return '—';
  if (loc?.timeZoneId) {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: loc.timeZoneId,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(eventDate(date, utcMinutes));
    } catch { /* 旧数据中的非法 IANA 标识按未知处理 */ }
  }
  return loc?.tzOffsetMin == null ? null : fmtHM(toCivil(utcMinutes, loc.tzOffsetMin));
}

export function civilLabel(loc) {
  if (loc?.timeZoneId) return '民用时（含夏令时规则）';
  if (loc?.tzOffsetMin != null) return '民用时（固定偏移，不含夏令时）';
  return null;
}

export function eventLines(date, ev, loc, lon, eot) {
  const sunrise = ev.sunrise == null ? '—' : fmtHM(toTST(ev.sunrise, lon, eot));
  const noon = ev.noon == null ? '—' : fmtHM(toTST(ev.noon, lon, eot));
  const sunset = ev.sunset == null ? '—' : fmtHM(toTST(ev.sunset, lon, eot));
  const primary = `日出 ${sunrise} · 正午 ${noon} · 日落 ${sunset}`;
  const label = civilLabel(loc);
  if (!label) return { primary, civil: null };
  const civilRise = formatCivilEvent(date, ev.sunrise, loc) ?? '—';
  const civilSet = formatCivilEvent(date, ev.sunset, loc) ?? '—';
  return { primary, civil: `${label} 日出 ${civilRise} · 日落 ${civilSet}` };
}

export function locationFromSearchResult(result) {
  const loc = {
    name: result.name || '未命名',
    latitude: result.latitude,
    longitude: result.longitude,
    timeZoneId: result.timeZoneId || null,
    tzOffsetMin: result.tzOffsetMin ?? null,
  };
  // GeoNames 本地结果带 geonameId → 稳定 id，对比栏按 id 去重；
  // 在线结果无 id，由调用方按坐标去重（不设置键，保持旧对象形状）
  if (result.geonameId != null) loc.id = 'geo:' + result.geonameId;
  return loc;
}

/**
 * 时区展示：`Asia/Shanghai · 当地 14:32 (UTC+8)`。
 * 无 IANA 标识时退回固定偏移；两者皆无显示「未知」。
 */
export function tzLabel(loc, now = new Date()) {
  if (loc?.timeZoneId) {
    try {
      const fmt = new Intl.DateTimeFormat('zh-CN', {
        timeZone: loc.timeZoneId,
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        timeZoneName: 'shortOffset',
      });
      const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
      const offset = (parts.timeZoneName || '').replace('GMT', 'UTC');
      return `${loc.timeZoneId} · 当地 ${parts.hour}:${parts.minute}${offset ? ` (${offset})` : ''}`;
    } catch { /* 非法 IANA 标识按未知偏移处理 */ }
  }
  if (loc?.tzOffsetMin != null) {
    const off = loc.tzOffsetMin / 60;
    return `UTC${off >= 0 ? '+' : ''}${off} · 固定偏移`;
  }
  return '未知';
}
