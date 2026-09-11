/**
 * 地点持久化：localStorage（Web 版）。
 * 键 dangwu:v1:favorites 存 JSON 数组，每条带 v 字段便于后续迁移；
 * 选中地点 id 单独存 dangwu:v1:selected。数据量极小，无需 IndexedDB。
 */
const KEY_FAV = 'dangwu:v1:favorites';
const KEY_SEL = 'dangwu:v1:selected';
const KEY_COMPARE = 'dangwu:v1:compare';
const V = 2;
export const MAX_COMPARE = 4;

export const DEFAULT_LOCATION = {
  v: V, id: 'seed:beijing', name: '北京',
  latitude: 39.9042, longitude: 116.4074,
  timeZoneId: 'Asia/Shanghai', tzOffsetMin: null, note: null, sortOrder: 0, createdAt: 0,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 校验并归一化一条地点记录；非法经纬度抛错。 */
export function normalizeLocation(loc) {
  if (!loc || typeof loc !== 'object') throw new Error('地点数据无效');
  const lat = Number(loc.latitude ?? loc.lat);
  const lon = Number(loc.longitude ?? loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('坐标不是数字');
  if (lat < -90 || lat > 90) throw new Error('纬度超出 -90~90');
  if (lon < -180 || lon > 180) throw new Error('经度超出 -180~180');
  const tz = loc.tzOffsetMin == null ? null : Math.round(Number(loc.tzOffsetMin));
  return {
    v: V,
    id: loc.id || newId(),
    name: String(loc.name || '未命名').slice(0, 24),
    latitude: clamp(lat, -90, 90),
    longitude: clamp(lon, -180, 180),
    timeZoneId: typeof loc.timeZoneId === 'string' && loc.timeZoneId.trim() ? loc.timeZoneId.trim() : null,
    tzOffsetMin: Number.isFinite(tz) ? clamp(tz, -720, 840) : null,
    note: loc.note ? String(loc.note).slice(0, 200) : null,
    sortOrder: Number.isFinite(loc.sortOrder) ? loc.sortOrder : Date.now() / 1000,
    createdAt: Number.isFinite(loc.createdAt) ? loc.createdAt : Date.now(),
  };
}

export function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function loadFavorites() {
  let raw = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_FAV) || '[]');
    if (Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = [];
  }
  // 逐条校验：一条损坏记录不影响其余
  const out = [];
  for (const item of raw) {
    try { out.push(normalizeLocation(item)); } catch { /* 丢弃损坏记录 */ }
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

export function saveFavorites(list) {
  try {
    localStorage.setItem(KEY_FAV, JSON.stringify(list));
    return true;
  } catch {
    return false;   // 隐私模式或配额满：静默降级为内存态
  }
}

/** 收藏地点；同名同坐标时更新原记录，避免首页重复收藏。 */
export function upsertFavorite(loc) {
  const next = normalizeLocation(loc);
  const list = loadFavorites();
  const i = list.findIndex((l) => l.id === next.id ||
    (l.latitude === next.latitude && l.longitude === next.longitude));
  if (i >= 0) {
    list[i] = { ...list[i], ...next, sortOrder: list[i].sortOrder };
  } else {
    list.push({ ...next, sortOrder: list.length + 1 });
  }
  saveFavorites(list);
  return list;
}

export function updateFavorite(id, patch) {
  const list = loadFavorites();
  const i = list.findIndex((l) => l.id === id);
  if (i < 0) return list;
  list[i] = normalizeLocation({ ...list[i], ...patch, id });
  saveFavorites(list);
  return list;
}

export function removeFavorite(id) {
  const list = loadFavorites().filter((l) => l.id !== id);
  saveFavorites(list);
  return list;
}

export function moveFavorite(id, toIndex) {
  const list = loadFavorites();
  const from = list.findIndex((l) => l.id === id);
  if (from < 0) return list;
  const [item] = list.splice(from, 1);
  const target = Math.max(0, Math.min(toIndex, list.length));
  list.splice(target, 0, item);
  list.forEach((l, i) => { l.sortOrder = i + 1; });
  saveFavorites(list);
  return list;
}

export function loadSelectedId() {
  try { return localStorage.getItem(KEY_SEL) || ''; } catch { return ''; }
}

export function saveSelectedId(id) {
  try { localStorage.setItem(KEY_SEL, String(id)); } catch { /* 忽略 */ }
}

/** 当前生效地点：收藏里选中的那条，否则默认北京。 */
export function resolveSelected() {
  const list = loadFavorites();
  const id = loadSelectedId();
  return list.find((l) => l.id === id) || list[0] || { ...DEFAULT_LOCATION };
}

// ── 对比栏持久化：与收藏同构的地点数组，上限 MAX_COMPARE、按 id 去重 ──
export function loadCompare() {
  let raw = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_COMPARE) || '[]');
    if (Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = [];
  }
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_COMPARE) break;
    try {
      const loc = normalizeLocation(item);
      if (!out.some((l) => l.id === loc.id)) out.push(loc);
    } catch { /* 丢弃损坏记录 */ }
  }
  return out;
}

function saveCompareList(list) {
  try {
    localStorage.setItem(KEY_COMPARE, JSON.stringify(list.slice(0, MAX_COMPARE)));
    return true;
  } catch {
    return false;   // 隐私模式或配额满：静默降级为内存态
  }
}

/** 加入对比；重复 id 忽略。返回最新列表。 */
export function addCompare(loc) {
  const next = normalizeLocation(loc);
  const list = loadCompare();
  if (!list.some((l) => l.id === next.id)) {
    list.push(next);
    saveCompareList(list);
  }
  return list;
}

export function removeCompare(id) {
  const list = loadCompare().filter((l) => l.id !== id);
  saveCompareList(list);
  return list;
}

export function clearCompare() {
  saveCompareList([]);
  return [];
}
