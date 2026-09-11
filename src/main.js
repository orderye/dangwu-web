/**
 * 当午 · Web 装配：1 秒时钟（visibility 感知）+ 地球渲染（按需绘制）+ 点球选。
 * 核心功能零网络、零时区库；INTERNET 与定位均为可选增强。
 */
import * as THREE from 'three';
import * as solar from './core/solar.js';
import { Globe } from './globe/Globe.js';
import { renderClock, fmtCoord } from './ui/clock.js';
import {
  loadFavorites, resolveSelected, upsertFavorite, saveSelectedId, normalizeLocation,
  removeFavorite, loadCompare, addCompare as addCompareStored,
  removeCompare as removeCompareStored, clearCompare as clearCompareStored, MAX_COMPARE,
} from './store/storage.js';
import { initSearch, openSearch, closeSearch } from './ui/search.js';
import { initFavorites, openFavorites, closeFavorites, refreshFavorites } from './ui/favorites.js';
import { initDetails, openDetails, closeDetails, refreshDetails, copyDetailCoords } from './ui/detail.js';
import { initAbout, openAbout, closeAbout } from './ui/about.js';
import { locationFromSearchResult, tzLabel, eventLines, formatCivilEvent } from './ui/presentation.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const clockEl = $('clock');
const pickEl = $('pick');

const state = { loc: resolveSelected(), timer: null, picked: null, detailLoc: null };

function fatal(msg) {
  $('boot').hidden = true;
  const e = $('err');
  e.hidden = false;
  e.textContent = msg;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/** 设备时区 IANA 标识；不可用时再保存当前固定偏移以兼容旧环境。 */
function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
const deviceTzOffset = () => -new Date().getTimezoneOffset();

// ── 每秒心跳 ─────────────────────────────────────────────
let globe = null;
function tick() {
  const now = new Date();
  const { latitude: lat, longitude: lon } = state.loc;
  const sp = solar.solarCalc(now);
  const tst = solar.trueSolarMin(now, lon, sp.eotMin);
  const ev = solar.sunEvents(now, lat, lon);

  renderClock(clockEl, state.loc, now, sp, tst, ev);

  const subLon = solar.subsolarLon(now, sp.eotMin);
  globe?.setSun(sp.decl, subLon);
  globe?.setSubsolarMarker(sp.decl, subLon);
  globe?.setMarker(lat, lon);

  if (state.picked) {
    const sp2 = solar.solarCalc(now);
    $('pick-coord').textContent = fmtCoord(state.picked.latitude, state.picked.longitude);
    $('pick-tst').textContent = solar.fmtHMS(solar.trueSolarMin(now, state.picked.longitude, sp2.eotMin));
    $('pick-shichen').textContent = solar.shichen(solar.trueSolarMin(now, state.picked.longitude, sp2.eotMin));
  }
  if (state.detailLoc) {
    refreshDetails(state.detailLoc, now);
  }
  if (cityCardCity) {
    refreshCityCard(now);
  }
  if (compareCities.length) {
    refreshCompareBar(now);
  }
  if (document.hidden) return;
}

function startClock() { tick(); state.timer = setInterval(tick, 1000); }
function stopClock() { clearInterval(state.timer); state.timer = null; }
document.addEventListener('visibilitychange', () => (document.hidden ? stopClock() : startClock()));
// 渲染由 Globe.requestRender() 按需调度（rAF 优先 + 定时器兜底），无需持续 rAF 循环

// ── 点球选 ───────────────────────────────────────────────
function openPick(lat, lon) {
  state.picked = { latitude: lat, longitude: lon };
  $('pick-name').value = '';
  pickEl.hidden = false;
  tick();
  globe.focusOn(lat, lon, 2.4);
}
function closePick() {
  pickEl.hidden = true;
  state.picked = null;
}
$('pick-close').addEventListener('click', closePick);
$('pick-set').addEventListener('click', () => {
  const name = $('pick-name').value.trim() || '未命名地点';
  selectLocation({ name, latitude: state.picked.latitude, longitude: state.picked.longitude });
  closePick();
  toast(`已切换到 ${name}`);
});
$('pick-save').addEventListener('click', () => {
  const name = $('pick-name').value.trim() || '未命名地点';
  upsertFavorite({ name, latitude: state.picked.latitude, longitude: state.picked.longitude });
  refreshFavorites();
  toast(`已收藏 ${name}（共 ${loadFavorites().length} 个地点）`);
  closePick();
});

// ── 地点切换 ─────────────────────────────────────────────
function selectLocation(loc) {
  state.loc = normalizeLocation(loc);
  saveSelectedId(state.loc.id);
  globe.focusOn(state.loc.latitude, state.loc.longitude);
}

$('place-btn').addEventListener('click', () => {
  const list = loadFavorites();
  if (list.length < 2) return toast(`收藏列表里只有 ${list.length} 个地点`);
  const i = list.findIndex((l) => l.id === state.loc.id);
  const next = list[(i + 1) % list.length];
  selectLocation(next);
  toast(`已切换到 ${next.name}（共 ${list.length} 个）`);
});

$('loc-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('此环境不支持定位（需 HTTPS 或 localhost）');
  $('loc-btn').textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      selectLocation({
        name: '我的位置',
        latitude: p.coords.latitude,
        longitude: p.coords.longitude,
        timeZoneId: deviceTimeZone(),
        tzOffsetMin: deviceTimeZone() ? null : deviceTzOffset(),
      });
      $('loc-btn').textContent = '定位';
      toast('已定位到当前位置');
    },
    (err) => {
      $('loc-btn').textContent = '定位';
      toast(`定位失败：${err.code === 1 ? '已拒绝权限' : err.message}`);
    },
    { timeout: 10000, enableHighAccuracy: false },
  );
});

$('fav-btn').addEventListener('click', () => {
  upsertFavorite(state.loc);
  refreshFavorites();
  toast(`已收藏 ${state.loc.name}`);
});

// ── 搜索面板（点击地球/拖动由搜索模块独立管理）──────────────
$('search-btn').addEventListener('click', () => {
  openSearch({
    onPick: (r) => {
      const loc = locationFromSearchResult(r);
      upsertFavorite(loc);
      selectLocation(loc);
      refreshFavorites();
      toast(`已切换到 ${loc.name}`);
    },
    onCompare: (r) => addToCompare(locationFromSearchResult(r)),
  });
});

// ── 详情面板（当前地点）──────────────────────────────────
$('detail-btn').addEventListener('click', () => {
  state.detailLoc = state.loc;
  openDetails(state.loc);
});

// ── 收藏列表面板 ──────────────────────────────────────────
$('fav-list-btn').addEventListener('click', () => {
  openFavorites({
    onSelect: (loc) => {
      selectLocation(loc);
      toast(`已切换到 ${loc.name}`);
    },
    onDetail: (loc) => {
      state.detailLoc = loc;
      openDetails(loc);
    },
    onCompare: (loc) => addToCompare(loc),
    onChanged: () => { /* 收藏增删改后由模块内部刷新 */ },
  });
});

// ── 面板初始化（绑定内部关闭/确认按钮、遮罩点击、ESC）────────
initSearch();
initFavorites({ onClose: closeFavorites });
initDetails({
  onClose: () => { state.detailLoc = null; },
  onSelectFromDetail: (loc) => {
    selectLocation(loc);
    state.detailLoc = null;
    closeDetails();
    toast(`已切换到 ${loc.name}`);
  },
  onCopy: (loc) => copyDetailCoords(loc),
  onAddToCompare: (loc) => addToCompare(loc),
});

initAbout();
$('about-btn').addEventListener('click', openAbout);
$('city-close').addEventListener('click', closeCityCard);
$('compare-clear').addEventListener('click', clearCompare);

// ── 城市卡片与对比栏状态 ────────────────────────────────────
let cityCardCity = null;
const cityCardEl = $('city-card');
const compareBarEl = $('compare-bar');
const compareSlotsEl = $('compare-slots');
let compareCities = loadCompare();   // localStorage 持久化，刷新后保留

const sameCoords = (a, b) => Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6;

function tzShort(c) {
  if (c.timeZoneId) return c.timeZoneId;
  if (c.tzOffsetMin != null) return `UTC${c.tzOffsetMin >= 0 ? '+' : ''}${c.tzOffsetMin / 60}`;
  return '时区未知';
}

// ── 对比栏渲染（结构）＋每秒刷新（文本）──────────────────────
function renderCompareBar() {
  if (!compareCities.length) {
    compareBarEl.hidden = true;
    return;
  }
  compareBarEl.hidden = false;
  compareSlotsEl.innerHTML = '';
  for (const c of compareCities) {
    const slot = document.createElement('div');
    slot.className = 'compare-bar__slot';
    slot.dataset.id = c.id;
    const header = document.createElement('div');
    header.className = 'compare-bar__slot-header';
    const name = document.createElement('span');
    name.className = 'compare-bar__slot-name';
    name.textContent = c.name;
    const remove = document.createElement('button');
    remove.className = 'compare-bar__slot-remove';
    remove.setAttribute('aria-label', '移除');
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromCompare(c.id);
    });
    header.append(name, remove);
    slot.appendChild(header);
    slot.insertAdjacentHTML('beforeend', `
      <div class="compare-bar__slot-metric"><span>真太阳时</span><strong data-m="tst">—</strong></div>
      <div class="compare-bar__slot-metric"><span>日出/日落</span><strong data-m="sun">—</strong></div>
      <div class="compare-bar__slot-metric"><span>日长</span><strong data-m="day">—</strong></div>
      <div class="compare-bar__slot-tz">${tzShort(c)}</div>
    `);
    compareSlotsEl.appendChild(slot);
  }
  refreshCompareBar(new Date());
}

/** 每秒刷新对比栏指标（民用时日出日落优先 IANA 时区，含夏令时）。 */
function refreshCompareBar(now = new Date()) {
  const sp = solar.solarCalc(now);
  for (const c of compareCities) {
    const slot = compareSlotsEl.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
    if (!slot) continue;
    const ev = solar.sunEvents(now, c.latitude, c.longitude);
    const tst = solar.trueSolarMin(now, c.longitude, sp.eotMin);
    const fallback = (min) => solar.fmtHM(solar.toTST(min, c.longitude, sp.eotMin));
    const rise = ev.sunrise == null ? '—' : (formatCivilEvent(now, ev.sunrise, c) ?? fallback(ev.sunrise));
    const set = ev.sunset == null ? '—' : (formatCivilEvent(now, ev.sunset, c) ?? fallback(ev.sunset));
    slot.querySelector('[data-m="tst"]').textContent = solar.fmtHM(tst);
    slot.querySelector('[data-m="sun"]').textContent = `${rise} / ${set}`;
    slot.querySelector('[data-m="day"]').textContent = ev.dayLen ? `${(ev.dayLen / 60).toFixed(2)} 小时` : '极昼/极夜';
  }
}

function addToCompare(city) {
  if (compareCities.some((x) => x.id === city.id)) return toast(`${city.name} 已在对比栏`);
  if (compareCities.some((x) => sameCoords(x, city))) return toast(`${city.name}（同坐标地点）已在对比栏`);
  if (compareCities.length >= MAX_COMPARE) return toast(`对比栏已满（最多 ${MAX_COMPARE} 个），请先移除`);
  try {
    compareCities = addCompareStored(city);
  } catch (e) {
    return toast('无法加入对比：' + (e.message || e));
  }
  renderCompareBar();
  toast(`已加入对比：${city.name}`);
}

function removeFromCompare(id) {
  compareCities = removeCompareStored(id);
  renderCompareBar();
}

function clearCompare() {
  compareCities = clearCompareStored();
  renderCompareBar();
}

// ── 城市卡片渲染 ────────────────────────────────────────────
function openCityCard(city) {
  cityCardCity = city;
  refreshCityCard(new Date());
  updateCityFavButton();
  cityCardEl.hidden = false;
}

/** 每秒刷新城市卡片（真太阳时走秒、日出日落当时区偏移随日期变化时同步）。 */
function refreshCityCard(now = new Date()) {
  const city = cityCardCity;
  if (!city) return;
  const sp = solar.solarCalc(now);
  const tst = solar.trueSolarMin(now, city.longitude, sp.eotMin);
  const ev = solar.sunEvents(now, city.latitude, city.longitude);
  const fallback = (min) => solar.fmtHM(solar.toTST(min, city.longitude, sp.eotMin));
  $('city-name').textContent = city.name;
  $('city-tst').textContent = solar.fmtHMS(tst);
  $('city-sunrise').textContent = ev.sunrise == null ? '—' : (formatCivilEvent(now, ev.sunrise, city) ?? fallback(ev.sunrise));
  $('city-sunset').textContent = ev.sunset == null ? '—' : (formatCivilEvent(now, ev.sunset, city) ?? fallback(ev.sunset));
  $('city-daylen').textContent = ev.dayLen ? `${(ev.dayLen / 60).toFixed(2)} 小时` : '极昼/极夜';
  $('city-tz').textContent = tzLabel(city, now);
  $('city-coord').textContent = fmtCoord(city.latitude, city.longitude);
  const lines = eventLines(now, ev, city, city.longitude, sp.eotMin);
  $('city-events').innerHTML = lines.primary +
    (lines.civil ? `<br><span class="civil">${lines.civil}</span>` : '');
}

/** 收藏按钮状态：已收藏（按 id 或同坐标匹配）时显示「取消收藏」。 */
function findCityFavorite(city) {
  return loadFavorites().find((l) => l.id === city.id || sameCoords(l, city));
}

function updateCityFavButton() {
  if (!cityCardCity) return;
  $('city-fav').textContent = findCityFavorite(cityCardCity) ? '取消收藏' : '收藏';
}

function closeCityCard() {
  cityCardEl.hidden = true;
  cityCardCity = null;
}

// 城市卡片按钮（打开卡片时只改状态，不重复绑定）
$('city-fav').addEventListener('click', () => {
  const city = cityCardCity;
  if (!city) return;
  const fav = findCityFavorite(city);
  if (fav) {
    removeFavorite(fav.id);
    toast(`已取消收藏 ${city.name}`);
  } else {
    upsertFavorite(city);
    toast(`已收藏 ${city.name}`);
  }
  refreshFavorites();
  updateCityFavButton();
});
$('city-compare').addEventListener('click', () => { if (cityCardCity) addToCompare(cityCardCity); });
$('city-set').addEventListener('click', () => {
  const city = cityCardCity;
  if (!city) return;
  selectLocation(city);
  closeCityCard();
  toast(`已切换到 ${city.name}`);
});

// ── ESC 关闭所有面板 ──────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSearch();
  closeFavorites();
  closeDetails();
  closeAbout();
  closeCityCard();
  if (pickEl.hidden === false) closePick();
});

window.addEventListener('resize', () => globe?.resize(innerWidth, innerHeight));

// ── 启动 ─────────────────────────────────────────────────
/**
 * 城市数据归一化：cities.json（GeoNames 导出）用 lat/lon/geonameId，
 * 渲染与 UI 层统一用 latitude/longitude/id。保持人口降序（Points LOD 依赖）。
 */
function normalizeCities(raw) {
  return raw
    .map((c) => ({
      id: c.geonameId != null ? 'geo:' + c.geonameId : undefined,
      name: c.name,
      asciiName: c.asciiName,
      aliases: c.aliases,
      countryCode: c.countryCode,
      population: c.population || 0,
      timeZoneId: c.timeZoneId || null,
      latitude: Number(c.lat),
      longitude: Number(c.lon),
    }))
    .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
    .sort((a, b) => b.population - a.population);
}

/** 优先加载 8K 纹理，失败（离线/旧缓存）回退 4K。 */
function loadTextureWithFallback(loader, hiUrl, loUrl) {
  const load = (url) => new Promise((res, rej) => loader.load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = globe.renderer.capabilities.getMaxAnisotropy();
    res(t);
  }, undefined, rej));
  return load(hiUrl).catch(() => load(loUrl));
}

function boot() {
  try {
    globe = new Globe(canvas, { onPick: openPick });
    globe.resize(innerWidth, innerHeight);
  } catch (e) {
    return fatal('无法初始化 WebGL 3D 渲染：' + (e.message || e) +
      '。请用支持 WebGL2 的现代浏览器打开。');
  }

  // 城市点击回调
  globe.onCityPick((city) => openCityCard(city));

  // 恢复持久化的对比栏
  renderCompareBar();

  const loader = new THREE.TextureLoader();

  // 并行加载贴图与城市数据
  Promise.all([
    loadTextureWithFallback(loader, 'assets/earth_day_8192.jpg', 'assets/earth_day_4096.jpg'),
    loadTextureWithFallback(loader, 'assets/earth_night_8192.jpg', 'assets/earth_night_4096.jpg'),
    fetch('src/data/cities.json').then(r => r.ok ? r.json() : []).catch(() => []),
  ])
    .then(([day, night, cities]) => {
      globe.setTexture(day, 'day');
      globe.setTexture(night, 'night');
      if (Array.isArray(cities) && cities.length) {
        globe.setCities(normalizeCities(cities));
      }
      globe.focusOn(state.loc.latitude, state.loc.longitude);
      $('boot').hidden = true;
      startClock();
    })
    .catch((e) => fatal('资源加载失败：' + (e.message || e) +
      '。请确认 assets/ 与 src/data/cities.json 存在。'));
}

boot();

// ── PWA：Service Worker 注册（仅 HTTPS / localhost）────────────────────
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // 离线/隐私模式等场景静默降级，不影响核心功能
  });
}
