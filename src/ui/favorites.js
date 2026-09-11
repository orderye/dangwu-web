/**
 * 收藏列表面板：查看、选中、重命名、删除、上移/下移排序、打开详情。
 * UI 仅依赖 DOM 操作与 CSS，不包含业务逻辑（定位、渲染等）均由 main.js 负责。
 *
 * 自包含：initFavorites 绑定内部按钮（关闭、遮罩、ESC、上移/下移、删除确认、
 * 重命名、详情）；openFavorites/closeFavorites 控制显隐；refreshFavorites 由 main.js
 * 在收藏增删改后调用以更新列表。
 */
import { fmtCoord } from '../ui/clock.js';
import { loadFavorites, updateFavorite, removeFavorite, moveFavorite } from '../store/storage.js';

let _state = { list: [], selectedId: null, onSelect: null, onDetail: null, onCompare: null, onClose: null };
let _draggingId = null;

/** 读取当前选中地点 id（与 storage 约定一致）。 */
function getSelectedIdFromStorage() {
  try { return localStorage.getItem('dangwu:v1:selected') || ''; } catch { return ''; }
}

/** 初始化收藏面板：绑定事件、删除确认、重命名、详情、上移/下移。 */
export function initFavorites({ onSelect, onDetail, onCompare, onClose } = {}) {
  _state = { ..._state, onSelect, onDetail, onCompare, onClose };
  const closeBtn = document.getElementById('favorites-close');
  const el = document.getElementById('favorites');
  closeBtn.addEventListener('click', closeFavorites);
  el.addEventListener('click', (e) => { if (e.target === el) closeFavorites(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) closeFavorites(); });
}

/** 打开收藏面板并渲染列表。 */
export function openFavorites({ onSelect, onDetail, onCompare, onClose } = {}) {
  _state = { ..._state, onSelect, onDetail, onCompare, onClose };
  _state.list = loadFavorites();
  _state.selectedId = getSelectedIdFromStorage();
  render();
  document.getElementById('favorites').hidden = false;
}

/** 关闭面板。 */
export function closeFavorites() {
  document.getElementById('favorites').hidden = true;
  if (_draggingId) { _draggingId = null; }
  _state.onClose?.();
}

/** 外部刷新（收藏增删改后）。 */
export function refreshFavorites() {
  const el = document.getElementById('favorites');
  if (el.hidden) return;
  _state.list = loadFavorites();
  _state.selectedId = getSelectedIdFromStorage();
  render();
}

/** 渲染列表。 */
function render() {
  const listEl = document.getElementById('favorites-list');
  const countEl = document.getElementById('favorites-count');
  const emptyEl = document.getElementById('favorites-empty');
  listEl.innerHTML = '';
  const total = _state.list.length;
  countEl.textContent = `${total} 个地点`;
  emptyEl.hidden = total > 0;
  const frag = document.createDocumentFragment();
  _state.list.forEach((loc, idx) => {
    const li = document.createElement('li');
    li.dataset.id = loc.id;
    li.className = 'fav-item';
    if (loc.id === _state.selectedId) li.classList.add('selected');

    const nameDiv = document.createElement('div');
    nameDiv.className = 'fav-name';
    nameDiv.title = '点击切换为当前地点';
    nameDiv.textContent = loc.name;
    nameDiv.addEventListener('click', () => selectLoc(loc));
    li.appendChild(nameDiv);

    const coord = document.createElement('div');
    coord.className = 'fav-coord';
    coord.textContent = fmtCoord(loc.latitude, loc.longitude);
    li.appendChild(coord);

    const ops = document.createElement('div');
    ops.className = 'fav-ops';

    const btnUp = document.createElement('button');
    btnUp.className = 'btn btn--sm';
    btnUp.textContent = '↑';
    btnUp.title = '上移';
    btnUp.disabled = idx === 0;
    btnUp.addEventListener('click', (e) => { e.stopPropagation(); moveFavorite(loc.id, idx - 1); render(); });
    ops.appendChild(btnUp);

    const btnDown = document.createElement('button');
    btnDown.className = 'btn btn--sm';
    btnDown.textContent = '↓';
    btnDown.title = '下移';
    btnDown.disabled = idx === total - 1;
    btnDown.addEventListener('click', (e) => { e.stopPropagation(); moveFavorite(loc.id, idx + 1); render(); });
    ops.appendChild(btnDown);

    const btnRename = document.createElement('button');
    btnRename.className = 'btn btn--sm';
    btnRename.textContent = '重命名';
    btnRename.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = prompt('请输入新名称（最长 24 字）', loc.name);
      if (newName !== null) {
        const trimmed = newName.trim().slice(0, 24);
        if (trimmed) { updateFavorite(loc.id, { name: trimmed }); render(); }
      }
    });
    ops.appendChild(btnRename);

    const btnDetail = document.createElement('button');
    btnDetail.className = 'btn btn--sm';
    btnDetail.textContent = '详情';
    btnDetail.title = '查看高度角、方位角、日长、影长比';
    btnDetail.addEventListener('click', (e) => { e.stopPropagation(); _state.onDetail?.(loc); });
    ops.appendChild(btnDetail);

    const btnCompare = document.createElement('button');
    btnCompare.className = 'btn btn--sm';
    btnCompare.textContent = '对比';
    btnCompare.title = '加入底部对比栏';
    btnCompare.addEventListener('click', (e) => { e.stopPropagation(); _state.onCompare?.(loc); });
    ops.appendChild(btnCompare);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn--sm btn--del';
    btnDel.textContent = '删除';
    btnDel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`确定要删除「${loc.name}」吗？`)) { removeFavorite(loc.id); render(); }
    });
    ops.appendChild(btnDel);

    li.appendChild(ops);
    frag.appendChild(li);
  });
  listEl.appendChild(frag);
}

/** 选中地点：更新 storage 并通知 main.js 切换定位，随后关闭面板。 */
function selectLoc(loc) {
  _state.selectedId = loc.id;
  try { localStorage.setItem('dangwu:v1:selected', loc.id); } catch { /* 忽略 */ }
  render();
  _state.onSelect?.(loc);
  closeFavorites();
}