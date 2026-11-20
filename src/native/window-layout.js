// Keep the complete window inside the current display, including after unplugging a monitor.
function fitWindowBounds(mode, current, workArea, previous) {
  if (!['portrait', 'landscape'].includes(mode)) throw new Error('Invalid window layout');
  const height = Math.min(mode === 'portrait' ? 940 : (previous?.height || 750), workArea.height);
  const width = Math.min(mode === 'portrait' ? Math.min(620, Math.round(height * 0.74)) : (previous?.width || 1100), workArea.width);
  const origin = mode === 'landscape' && previous ? previous : {
    x: Math.round(current.x + (current.width - width) / 2),
    y: Math.round(current.y + (current.height - height) / 2),
  };
  return {
    x: Math.max(workArea.x, Math.min(origin.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(origin.y, workArea.y + workArea.height - height)),
    width, height,
  };
}
// Window resizing changes available space, never the user's chosen text size.
function getWindowScale(value = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
}
function saveWindowZoom(store, direction) {
  if (!['in', 'out', 'reset'].includes(direction)) throw new Error('Invalid zoom direction');
  const settings = store.getSettings() || {};
  const current = getWindowScale(settings.ui_zoom);
  const next = direction === 'reset' ? 1 : Math.round((current + (direction === 'in' ? 0.1 : -0.1)) * 10) / 10;
  store.saveSettings({ ...settings, ui_zoom: getWindowScale(next) });
}
const validBounds = bounds => bounds && ['x', 'y', 'width', 'height'].every(key =>
  Number.isSafeInteger(bounds[key]) && Math.abs(bounds[key]) <= 2147483647)
  && bounds.width > 0 && bounds.height > 0;

function resolveScreenWorkArea(screen, bounds) {
  try {
    const matched = validBounds(bounds) ? screen?.getDisplayMatching?.(bounds)?.workArea : null;
    const area = matched || screen?.getPrimaryDisplay?.()?.workArea;
    if (area && Number.isFinite(area.width) && area.width > 0 && Number.isFinite(area.height) && area.height > 0) {
      return area;
    }
  } catch (_) {}
  return null;
}

function fitCreationWindowOptions(options, screen) {
  const area = resolveScreenWorkArea(screen, validBounds(options) ? options : null);
  if (!area) return options;
  const minWidth = Math.min(options.minWidth || 900, area.width);
  const minHeight = Math.min(options.minHeight || 620, area.height);
  const width = Math.max(minWidth, Math.min(options.width || 1100, area.width));
  const height = Math.max(minHeight, Math.min(options.height || 750, area.height));
  const next = { ...options, width, height, minWidth, minHeight };
  if (Number.isSafeInteger(options.x) && Number.isSafeInteger(options.y)) {
    next.x = Math.max(area.x, Math.min(options.x, area.x + area.width - width));
    next.y = Math.max(area.y, Math.min(options.y, area.y + area.height - height));
  }
  return next;
}

function syncWindowMinimumSize(win, screen, mode = 'landscape', clampBounds = false) {
  if (!win || win.isDestroyed?.() || win.isFullScreen?.() || win.isMinimized?.()) return;
  const bounds = win.getBounds?.();
  const area = resolveScreenWorkArea(screen, bounds);
  if (!area) return;
  const minWidth = Math.min(mode === 'portrait' ? 420 : 900, area.width);
  const minHeight = Math.min(mode === 'portrait' ? 560 : 620, area.height);
  win.setMinimumSize?.(minWidth, minHeight);
  if (!clampBounds || !validBounds(bounds) || win.isMaximized?.()) return;
  const width = Math.max(minWidth, Math.min(bounds.width, area.width));
  const height = Math.max(minHeight, Math.min(bounds.height, area.height));
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
  if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) {
    win.setBounds?.({ x, y, width, height });
  }
}

function restoreMainWindowBounds(store, screen) {
  try {
    const saved = store.getSettings()?.main_window_state;
    if (!validBounds(saved?.bounds)) return {};
    const display = screen.getAllDisplays().find(item => item.id === saved.displayId);
    if (!display) return {};
    const bounds = fitWindowBounds('landscape', saved.bounds, display.workArea, {
      width: Math.max(900, saved.bounds.width), height: Math.max(620, saved.bounds.height),
      x: saved.bounds.x, y: saved.bounds.y,
    });
    return { ...bounds,
      ...(bounds.width < 900 ? { minWidth: bounds.width } : {}),
      ...(bounds.height < 620 ? { minHeight: bounds.height } : {}),
    };
  } catch (_) { return {}; }
}

function rememberMainWindowBounds(win, { store, screen, isNormal }) {
  let lastNormal = null;
  let enteringFullScreen = false;
  const capture = () => {
    if (win.isDestroyed() || enteringFullScreen || !isNormal()
      || win.isFullScreen?.() || win.isMinimized?.() || win.isVisible?.() === false) return;
    // macOS emits intermediate resize events before maximize; its final normal bounds undo those frames.
    const bounds = win.isMaximized?.() ? win.getNormalBounds?.() : win.getBounds?.();
    if (!validBounds(bounds)) return;
    const display = screen.getDisplayMatching(bounds);
    if (!Number.isSafeInteger(display.id)) return;
    lastNormal = { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, displayId: display.id };
  };
  capture();
  win.on('move', capture);
  win.on('resize', capture);
  win.on('maximize', capture);
  win.on('will-enter-full-screen', () => { capture(); enteringFullScreen = true; });
  win.on('leave-full-screen', () => { enteringFullScreen = false; capture(); });
  // shortcut: persist on close; add debounced writes if crash/force-quit recovery is required.
  win.on('close', () => {
    capture();
    if (!lastNormal) return;
    try {
      const settings = store.getSettings();
      if (JSON.stringify(settings.main_window_state) !== JSON.stringify(lastNormal)) {
        store.saveSettings({ ...settings, main_window_state: lastNormal });
      }
    } catch (_) { /* The store reports storage errors; window memory must not block closing. */ }
  });
}

module.exports = {
  fitWindowBounds,
  getWindowScale,
  saveWindowZoom,
  restoreMainWindowBounds,
  rememberMainWindowBounds,
  fitCreationWindowOptions,
  syncWindowMinimumSize,
};
