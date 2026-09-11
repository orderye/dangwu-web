/** About 覆盖层。 */
let onClose = null;

export function initAbout({ onClosed } = {}) {
  onClose = onClosed;
  const el = document.getElementById('about');
  document.getElementById('about-close').addEventListener('click', closeAbout);
  el.addEventListener('click', (event) => { if (event.target === el) closeAbout(); });
}

export function openAbout() {
  document.getElementById('about').hidden = false;
  document.getElementById('about-close').focus();
}

export function closeAbout() {
  const el = document.getElementById('about');
  if (el.hidden) return;
  el.hidden = true;
  onClose?.();
}
