/**
 * 地点搜索：输入时仅检索 GeoNames 离线索引；提交表单才请求 Nominatim。
 * 公共端点请求全局串行（至少间隔 1 秒），并合并同查询、使用内存缓存。
 */
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
// 占位联系标识：发布前必须换成项目实际可监控的地址（公共 Nominatim 要求可联系到维护者）。
export const NOMINATIM_EMAIL = 'dangwu-app@users.noreply.github.com';
const REQUEST_INTERVAL_MS = 1000;
const memoryCache = new Map();
const inFlight = new Map();
let nextRequestAt = 0;
let queue = Promise.resolve();
let cities = [];
let citiesPromise = null;
let onPick = null;
let onCompare = null;
let controller = null;
let renderedLocal = [];

const normalize = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadCities() {
  if (cities.length) return Promise.resolve(cities);
  if (!citiesPromise) {
    citiesPromise = fetch('src/data/cities.json').then((response) => response.ok ? response.json() : [])
      .then((list) => { cities = Array.isArray(list) ? list : []; return cities; })
      .catch(() => { cities = []; return cities; });
  }
  return citiesPromise;
}

/** 对已加载数组做有界线性检索；2 字符起、最多 12 条。 */
export function searchLocal(query, list = cities) {
  const q = normalize(query);
  if (q.length < 2) return [];
  const hits = [];
  for (const city of list) {
    const values = [city.name, city.asciiName, ...(city.aliases || [])];
    let rank = 9;
    for (const value of values) {
      const text = normalize(value);
      if (text === q) rank = Math.min(rank, 0);
      else if (text.startsWith(q)) rank = Math.min(rank, 1);
      else if (text.includes(q)) rank = Math.min(rank, 2);
    }
    if (rank === 9 && !normalize(city.countryCode).includes(q)) continue;
    hits.push({
      geonameId: city.geonameId,
      name: city.name,
      latitude: city.lat,
      longitude: city.lon,
      timeZoneId: city.timeZoneId || null,
      tzOffsetMin: null,
      source: '本地 · GeoNames',
      country: city.countryCode,
      population: city.population || 0,
      rank,
    });
  }
  return hits.sort((a, b) => a.rank - b.rank || b.population - a.population || a.name.localeCompare(b.name)).slice(0, 12);
}

function onlineRequest(query) {
  const key = normalize(query);
  if (memoryCache.has(key)) return Promise.resolve(memoryCache.get(key).map((item) => ({ ...item, source: '在线缓存' })));
  if (inFlight.has(key)) return inFlight.get(key);
  const task = queue.then(async () => {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await sleep(delay);
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    const url = new URL(NOMINATIM_ENDPOINT);
    url.search = new URLSearchParams({ format: 'jsonv2', limit: '8', q: query, addressdetails: '1', email: NOMINATIM_EMAIL });
    const response = await fetch(url, { headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.3' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const cached = response.headers.get('X-Dangwu-Cached-At');
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    const results = data.map((row) => ({
      name: String(row.display_name || row.name || query).split(',').slice(0, 2).join(' · '),
      latitude: Number(row.lat),
      longitude: Number(row.lon),
      timeZoneId: null,
      tzOffsetMin: null,
      source: cached ? '在线缓存' : '在线',
      country: row.address?.country || '',
    })).filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
    memoryCache.set(key, results);
    return results;
  });
  queue = task.then(() => {}, () => {});
  inFlight.set(key, task);
  const clear = () => inFlight.delete(key);
  task.then(clear, clear);
  return task;
}

/** Abort 只取消调用者等待，不取消实际排队/网络请求。 */
export async function searchOnline(query, signal) {
  const q = String(query || '').trim();
  if (normalize(q).length < 2) return [];
  const request = onlineRequest(q);
  if (!signal) return request;
  if (signal.aborted) return null;
  return Promise.race([request, new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))]);
}

function renderResults(results) {
  const status = document.getElementById('search-status');
  const list = document.getElementById('search-results');
  list.innerHTML = '';
  if (!results.length) { status.textContent = '未找到匹配地点'; return; }
  status.textContent = `找到 ${results.length} 个地点`;
  const fragment = document.createDocumentFragment();
  for (const result of results) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = result.name;
    const meta = document.createElement('span');
    meta.className = 'meta'; meta.textContent = `${result.source} · ${result.latitude.toFixed(4)}°, ${result.longitude.toFixed(4)}°${result.country ? ` · ${result.country}` : ''}`;
    info.append(name, meta); li.append(info);
    const pick = document.createElement('button');
    pick.className = 'btn btn--sm'; pick.textContent = '选用';
    pick.addEventListener('click', () => { onPick?.(result); closeSearch(); });
    const compare = document.createElement('button');
    compare.className = 'btn btn--sm'; compare.textContent = '对比';
    compare.title = '加入底部对比栏';
    compare.addEventListener('click', () => { onCompare?.(result); });
    li.append(pick, compare); fragment.append(li);
  }
  list.append(fragment);
}

async function localInput(value) {
  const q = String(value || '').trim();
  if (normalize(q).length < 2) { renderedLocal = []; renderResults([]); document.getElementById('search-status').textContent = '请输入至少 2 个字符'; return; }
  const list = await loadCities();
  renderedLocal = searchLocal(q, list);
  renderResults(renderedLocal);
}

async function submitOnline(event) {
  event.preventDefault();
  const input = document.getElementById('search-input');
  const q = input.value.trim();
  if (normalize(q).length < 2) return localInput(q);
  controller?.abort(); controller = new AbortController();
  document.getElementById('search-status').textContent = '正在显式联网搜索…';
  try {
    const online = await searchOnline(q, controller.signal);
    if (!online) return;
    const merged = online.concat(renderedLocal.filter((local) => !online.some((remote) => Math.abs(remote.latitude - local.latitude) < .01 && Math.abs(remote.longitude - local.longitude) < .01)));
    renderResults(merged.slice(0, 12));
  } catch {
    renderResults(renderedLocal);
    document.getElementById('search-status').textContent = renderedLocal.length ? '在线搜索失败，显示本地结果' : '在线搜索失败';
  }
}

export function initSearch() {
  const panel = document.getElementById('search');
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => localInput(input.value));
  document.getElementById('search-form').addEventListener('submit', submitOnline);
  document.getElementById('search-close').addEventListener('click', closeSearch);
  panel.addEventListener('click', (event) => { if (event.target === panel) closeSearch(); });
  loadCities().catch(() => {});
}

export function openSearch({ onPick: pickCallback, onCompare: compareCallback } = {}) {
  onPick = pickCallback || onPick;
  onCompare = compareCallback || onCompare;
  const input = document.getElementById('search-input');
  document.getElementById('search').hidden = false;
  input.value = ''; renderedLocal = []; renderResults([]);
  document.getElementById('search-status').textContent = '输入时仅搜索本地数据；提交才联网';
  input.focus();
}

export function closeSearch() {
  document.getElementById('search').hidden = true;
  controller?.abort();
}
