import rubyGlass from './assets/app-icons/ruby-glass.png';
import minimalRed from './assets/app-icons/minimal-red.png';
import obsidianCinema from './assets/app-icons/obsidian-cinema.png';
import ticketGlass from './assets/app-icons/ticket-glass.png';
import retroFilm from './assets/app-icons/retro-film.png';
import liquidGlass from './assets/app-icons/liquid-glass.png';
import cyberNeon from './assets/app-icons/cyber-neon.png';
import orientalSeal from './assets/app-icons/oriental-seal.png';

const STORAGE_KEY = 'hongguo-experience-preview:app-icon';
export const DEFAULT_APP_ICON = 'ruby-glass';

export const APP_ICONS = [
  { id: 'ruby-glass', name: '琉璃红果', style: '原生质感', src: rubyGlass },
  { id: 'minimal-red', name: '极简几何', style: '现代扁平', src: minimalRed },
  { id: 'obsidian-cinema', name: '暗夜影院', style: '黑曜鎏金', src: obsidianCinema },
  { id: 'ticket-glass', name: '影票叠影', style: '玻璃拟态', src: ticketGlass },
  { id: 'retro-film', name: '复古胶片', style: '经典影院', src: retroFilm },
  { id: 'liquid-glass', name: '液态玻璃', style: '水晶折射', src: liquidGlass },
  { id: 'cyber-neon', name: '霓虹赛博', style: '午夜电光', src: cyberNeon },
  { id: 'oriental-seal', name: '东方朱印', style: '新中式', src: orientalSeal },
];

const VALID_IDS = new Set(APP_ICONS.map(item => item.id));
const listeners = new Set();

export function normalizeAppIcon(id) {
  return typeof id === 'string' && VALID_IDS.has(id) ? id : DEFAULT_APP_ICON;
}

export function getAppIcon() {
  try {
    return normalizeAppIcon(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_APP_ICON;
  }
}

export function getAppIconOption(id = getAppIcon()) {
  const normalized = normalizeAppIcon(id);
  return APP_ICONS.find(item => item.id === normalized) || APP_ICONS[0];
}

export function setLocalAppIcon(id) {
  const normalized = normalizeAppIcon(id);
  try {
    window.localStorage.setItem(STORAGE_KEY, normalized);
  } catch {}
  for (const listener of listeners) listener(normalized);
  return normalized;
}

export function subscribeAppIcon(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
