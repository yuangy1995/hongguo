const path = require('node:path');
const { chooseAccountProgress, isSameAccountProgress, mergeAccountWatchHistory } = require('./account-progress-sync');

function createAccountController({
  ipcMain,
  app,
  session,
  safeStorage,
  platform = process.platform,
  BrowserWindow,
  createAccountService,
  safeMessage,
  hongguo,
  getSeriesRegistry,
  upsertSeriesRegistry,
  saveSeriesRegistry,
  navigateToPlayer,
  send,
  applyProxyToSession = async () => {},
  allowLibrary = () => false,
  progressTest,
  progressSync,
}) {
  let service = null;
  let webSession = null;
  let webSessionReady = Promise.resolve();
  let cookieCleanup = null;
  let loginWindow = null;
  const resumePositions = new Map();
  let progressCandidate = null;
  let progressTestRunning = false;
  let syncTimer = null;
  let syncRunning = null;
  let trailingSync = null;
  let syncStopped = false;
  let logoutRunning = null;
  let qrRequest = 0;
  const canSync = () => !syncStopped && (progressSync?.canSync?.() ?? true);

  function makePosition(series, record, metadata, accountId) {
    const episode = series.episodes.find(item => record.episode_id ? String(item.vid) === record.episode_id : item.vid_index === record.vid_index);
    if (!accountId || !/^\d{6,30}$/.test(String(series.series_id)) || !episode || episode.locked
      || !Number.isFinite(metadata?.duration) || metadata.duration <= 0 || record.currentTime < 0) return null;
    return {
      accountId, series_id: String(series.series_id), series_title: series.series_title,
      episode_id: String(episode.vid), vid_index: Number(episode.vid_index), currentTime: record.currentTime,
      updatedAt: record.updatedAt, duration: metadata.duration, total: series.episodes.length,
    };
  }

  function matchesPending(map, position) {
    const stored = map[position.series_id]?.accountSyncPending?.[position.accountId];
    return stored?.updatedAt === position.updatedAt && stored.episode_id === position.episode_id
      && stored.currentTime === position.currentTime;
  }

  function finishPending(position, field) {
    if (!matchesPending(progressSync.getPlayback(), position)) return false;
    return progressSync.updatePlayback(map => {
      if (!matchesPending(map, position)) return false;
      const pending = map[position.series_id].accountSyncPending;
      if (field) pending[position.accountId][field] = Date.now();
      else delete pending[position.accountId];
      return true;
    });
  }

  function syncProgress({ afterCurrent = false, signal, final = false } = {}) {
    if (!progressSync || !canSync() || signal?.aborted) return Promise.resolve({ success: true });
    if (syncRunning) {
      if (!afterCurrent) return trailingSync || syncRunning;
      if (!trailingSync) trailingSync = syncRunning.then(() => {
        trailingSync = null;
        return syncProgress({ signal, final });
      });
      return trailingSync;
    }
    syncRunning = action(async current => {
      if (!canSync()) return;
      const status = await current.status();
      const accountId = current.activeAccountId();
      const isCurrentAccount = () => canSync() && !signal?.aborted && current.activeAccountId() === accountId;
      if (!status.signedIn || !accountId || !isCurrentAccount()) return { success: true };
      const refreshed = await current.refreshHistory();
      if (!isCurrentAccount()) return { success: true, expired: refreshed?.expired === true };
      send('watch-history-updated', {});
      const pending = Object.values(progressSync.getPlayback())
        .map(record => record.accountSyncPending?.[accountId])
        .filter(Boolean).sort((a, b) => final ? b.updatedAt - a.updatedAt
          : (a.lastAttemptAt || 0) - (b.lastAttemptAt || 0) || a.updatedAt - b.updatedAt);
      for (const position of pending.slice(0, 6)) {
        if (!isCurrentAccount()) break;
        const triedBefore = !!position.lastAttemptAt;
        const shouldSend = () => isCurrentAccount() && matchesPending(progressSync.getPlayback(), position);
        const cloud = current.row(position.series_id);
        try {
          const direction = chooseAccountProgress(position, cloud, { allowNew: true });
          const retryProgress = triedBefore && !position.submittedAt && direction === 'unchanged' && cloud?.updatedAt <= position.updatedAt;
          if (direction === 'upload' || retryProgress) {
            if (position.submittedAt && Date.now() - position.submittedAt < 60000) continue;
            if (!finishPending(position, 'lastAttemptAt')) continue;
            await current.uploadProgress(accountId, position, cloud, { allowNew: true, retryProgress, shouldSend });
            finishPending(position, 'submittedAt');
          } else finishPending(position);
        } catch (error) {
          if (!shouldSend()) continue;
          finishPending(position, 'lastAttemptAt');
          throw error;
        }
      }
      return { success: true };
    }).then(result => {
      if (result?.success === false && service?.activeAccountId()) send('account-progress-sync-status', { error: result.error });
      else if (service?.activeAccountId()) send('account-progress-sync-status', { error: '' });
      return result;
    }).finally(() => {
      syncRunning = null;
    });
    return syncRunning;
  }

  async function flushProgress() {
    const accountId = service?.activeAccountId();
    if (!progressSync || !accountId) return { success: true };
    const signal = AbortSignal.timeout(8000);
    let onAbort;
    try {
      const result = await Promise.race([
        syncProgress({ afterCurrent: true, signal, final: true }),
        new Promise(resolve => {
          onAbort = () => resolve({ success: false });
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      const remaining = Object.values(progressSync.getPlayback()).some(record => {
        const position = record.accountSyncPending?.[accountId];
        return position && !position.submittedAt;
      });
      return { success: result?.success !== false && !remaining };
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  function getWebSession() {
    if (!webSession) {
      webSession = session.fromPartition('hongguo-account-login', { cache: false });
      webSessionReady = applyProxyToSession(webSession);
    }
    return webSession;
  }

  async function clearCookies() {
    await getWebSession().clearStorageData({ storages: ['cookies'] });
    await webSessionReady;
    const cookies = await session.defaultSession.cookies.get({});
    await Promise.all(cookies
      .filter(cookie => /(?:^|\.)hongguoduanju\.com$/i.test(String(cookie.domain || '')))
      .map(async cookie => {
        const host = String(cookie.domain || '').replace(/^\./, '');
        if (!host) return;
        try { await session.defaultSession.cookies.remove(`https://${host}${cookie.path || '/'}`, cookie.name); } catch {}
      }));
  }

  function getService() {
    if (!service) {
      cookieCleanup = clearCookies().catch(error => console.warn('[Account] 清除旧登录 Cookie 失败:', safeMessage(error)));
      const local = platform === 'darwin';
      service = createAccountService({
        filePath: path.join(app.getPath('userData'), local ? 'account-session.json' : 'account-session.bin'),
        local,
        safeStorage,
        webRequest: webRequest,
        historyFilePath: progressSync?.historyFilePath?.(),
        onAccountExpired: () => {
          resumePositions.clear();
          clearCookies().catch(error => console.warn('[Account] 清除登录 Cookie 失败:', error.message));
          send('account-updated', { signedIn: false, expired: true });
          send('watch-history-updated', {});
        },
      });
    }
    return service;
  }

  async function webRequest(url, options = {}) {
    await webSessionReady;
    const response = await getWebSession().fetch(url, {
      method: options.method || 'GET', headers: options.headers || {}, redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    const headers = {};
    for (const [name, value] of response.headers) headers[name] = value;
    const cookies = response.headers.getSetCookie?.();
    if (cookies?.length) headers['set-cookie'] = cookies;
    return { status: response.status, headers, data: await response.text() };
  }

  async function action(run) {
    try {
      const current = getService();
      await cookieCleanup;
      await webSessionReady;
      return await run(current);
    } catch (error) {
      const message = safeMessage(error);
      console.warn('[Account]', message);
      return { success: false, error: message };
    }
  }

  ipcMain.handle('open-account-web-login', async () => {
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { success: true }; }
    getService();
    await cookieCleanup;
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { success: true }; }
    getService().cancelLogin();
    const accountSession = getWebSession();
    await webSessionReady;
    const win = new BrowserWindow({ width: 1000, height: 760, title: '红果官网登录', webPreferences: {
      session: accountSession, contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    loginWindow = win;
    const official = value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'hongguoduanju.com' || url.hostname.endsWith('.hongguoduanju.com'));
      } catch { return false; }
    };
    for (const name of ['will-navigate', 'will-redirect']) win.webContents.on(name, (event, url) => { if (!official(url)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const observer = require('./account-web-login').createWebLoginObserver({
      readCookies: () => getWebSession().cookies.get({ url: 'https://hongguoduanju.com/' }),
      complete: cookie => action(current => current.completeWebLogin(cookie)),
      cancel: () => getService().cancelLogin(),
      onSignedIn: result => {
        send('account-updated', { signedIn: true, storageWarning: result.storageWarning });
        void syncProgress({ afterCurrent: true });
        if (!win.isDestroyed()) win.close();
      },
      onError: error => {
        const message = safeMessage(error);
        console.warn('[Account]', message);
        send('account-updated', { error: message });
      },
    });
    const changed = () => { void observer.inspect(); };
    getWebSession().cookies.on('changed', changed);
    win.on('closed', () => {
      observer.close();
      getWebSession().cookies.removeListener('changed', changed);
      if (loginWindow === win) loginWindow = null;
    });
    win.webContents.on('did-finish-load', changed);
    await win.loadURL('https://hongguoduanju.com/');
    return { success: true };
  });

  ipcMain.handle('get-account-status', async () => action(async current => ({
    ...await current.status(), progressTest: !!progressTest, librarySession: current.librarySessionId?.() || '',
  })));
  ipcMain.handle('get-account-library', (event, id, kind) => action(async current => {
    if (!allowLibrary(event) || logoutRunning) throw new Error('当前无法读取账号列表。');
    return { success: true, items: await current.readLibrary(id, kind) };
  }));
  ipcMain.handle('change-account-library', (event, id, change) => action(async current => {
    if (!allowLibrary(event) || logoutRunning) throw new Error('当前无法修改账号列表。');
    return { success: true, ...await current.changeLibrary(id, change || {}) };
  }));
  ipcMain.handle('start-account-login', async () => {
    const request = ++qrRequest;
    progressCandidate = null;
    resumePositions.clear();
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    getService().cancelLogin();
    await clearCookies();
    if (request !== qrRequest) return { success: true, status: 'cancelled' };
    return action(current => current.startLogin());
  });
  ipcMain.handle('poll-account-login', async (_event, loginId) => {
    const result = await action(current => current.pollLogin(String(loginId || '')));
    if (!result.success) await clearCookies();
    if (result.status === 'signed-in') {
      send('account-updated', { signedIn: true });
      void syncProgress({ afterCurrent: true });
    }
    return result;
  });
  ipcMain.handle('cancel-account-login', async (_event, loginId) => {
    qrRequest++;
    const result = await action(current => current.cancelLogin(String(loginId || '')));
    await clearCookies();
    return result;
  });
  ipcMain.handle('logout-account', () => logoutRunning ||= (async () => {
    qrRequest++;
    progressCandidate = null;
    resumePositions.clear();
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    const sync = await flushProgress().catch(() => ({ success: false }));
    const result = await action(current => current.logout());
    if (result.success) {
      send('account-updated', { signedIn: false });
      send('watch-history-updated', {});
      await clearCookies().catch(error => console.warn('[Account] 清除登录 Cookie 失败:', safeMessage(error)));
    }
    return { ...result, syncIncomplete: sync?.success === false };
  })().finally(() => { logoutRunning = null; }));
  ipcMain.handle('sync-account-progress', (_event, options) => syncProgress({ afterCurrent: options?.afterCurrent === true }));
  function saveCloudProgress(local, cloud) {
    const series = getSeriesRegistry().find(item => String(item.series_id) === local.series_id);
    const episode = series?.episodes.find(item => String(item.vid) === cloud.episode_id);
    if (!episode || episode.locked) throw new Error('该剧的云端分集在本机无法确认。');
    progressTest.saveLocal(local, cloud, episode.vid_index);
    progressCandidate = null;
  }

  ipcMain.handle('get-account-history', async (event, options) => action(async current => {
    const refresh = options?.refresh === true;
    const local = progressTest && refresh && options?.importTestProgress === true
      && progressTest.allowed(event) && !progressTestRunning ? progressCandidate : null;
    const result = await current.history({ refresh });
    if (refresh && progressSync && result?.success) send('watch-history-updated', {});
    if (!result?.success || !local || !result.signedIn || progressCandidate !== local
        || current.activeAccountId() !== local.accountId) return result;
    const cloud = current.row(local.series_id);
    if (!cloud || cloud.updatedAt <= local.updatedAt || isSameAccountProgress(local, cloud)) return result;
    try {
      if (chooseAccountProgress(local, cloud) !== 'download') return result;
      saveCloudProgress(local, cloud);
      return { ...result, importedTestProgress: true };
    } catch (error) {
      return { ...result, warning: safeMessage(error) };
    }
  }));
  if (progressTest) ipcMain.handle('test-account-progress-sync', async event => {
    if (!progressTest.allowed(event)) return { success: false, error: '同步测试窗口已失效。' };
    if (progressTestRunning) return { success: false, error: '正在测试这条进度，请稍候。' };
    progressTestRunning = true;
    try {
      return await action(async current => {
        const local = progressCandidate;
        const accountId = current.activeAccountId();
        if (!local || !accountId || local.accountId !== accountId) {
          throw new Error('请先登录独立测试账号，并在这台电脑上观看一集后暂停。');
        }
        await current.refreshHistory();
        const cloud = current.row(local.series_id);
        const direction = chooseAccountProgress(local, cloud);
        if (direction === 'unchanged') return { success: true, status: 'unchanged' };
        if (!await progressTest.confirm({ local, cloud, direction })) return { success: true, status: 'cancelled' };
        const verifyLocal = () => {
          if (progressCandidate !== local || current.activeAccountId() !== accountId) {
            throw new Error('本机进度或测试账号已变更，请重新开始。');
          }
        };
        verifyLocal();
        if (direction === 'upload') {
          await current.uploadProgressForTest(accountId, local, cloud);
          return { success: true, status: 'uploaded' };
        }
        await current.refreshHistory();
        verifyLocal();
        const fresh = current.row(local.series_id);
        if (!isSameAccountProgress(fresh, cloud) || fresh.updatedAt !== cloud.updatedAt) {
          throw new Error('云端进度已变更，请重新开始。');
        }
        saveCloudProgress(local, fresh);
        return { success: true, status: 'downloaded' };
      });
    } finally {
      progressTestRunning = false;
    }
  });
  ipcMain.handle('play-account-history', async (_event, seriesId, options) => {
    try {
      const sid = String(seriesId || '');
      if (!/^\d{1,30}$/.test(sid)) return { success: false, error: 'APP 观看记录编号无效' };
      const current = getService();
      const accountId = current.activeAccountId();
      const merged = options?.merged === true && progressSync;
      let source = merged && historySource();
      let row = merged ? source?.rows.find(item => item.series_id === sid) : current.row(sid);
      if (!row) {
        const refreshed = await current.refreshHistory();
        if (!refreshed.success) return refreshed;
        if (merged) source = historySource();
        row = current.row(sid);
      }
      if (!row) return { success: false, error: 'APP 观看记录已变化，请刷新后重试' };
      let entry = getSeriesRegistry().find(item => String(item.series_id) === sid);
      if (!entry) entry = upsertSeriesRegistry(await hongguo.fetchEpisodeList(sid));
      if (accountId !== current.activeAccountId()) return { success: false, error: '账号已退出，请重新登录' };
      if (!entry || !entry.episodes?.length) return { success: false, error: '暂时无法读取这部剧的分集' };
      if (merged) {
        const latest = historySource();
        row = latest?.rows.find(item => item.series_id === sid);
        if (!row || latest.accountId !== source?.accountId) {
          return { success: false, error: '观看记录已变化，请刷新后重试。' };
        }
        const local = progressSync.getPlayback()[sid];
        if (local?.vid_index > 0 && local.updatedAt >= row.updatedAt) {
          return navigateToPlayer({ seriesId: sid, vidIndex: local.vid_index, resume: true });
        }
        if (Number(local?.accountHidden?.[latest.accountId]) >= row.updatedAt) {
          return { success: false, error: 'APP 观看记录已变化，请刷新后重试' };
        }
      }
      const episode = entry.episodes.find(item => String(item.vid) === String(row.episode_id))
        || (!row.episode_id && options?.merged !== true && row.vid_index > 0 ? entry.episodes.find(item => Number(item.vid_index) === row.vid_index) : null);
      if (!episode) return { success: false, error: 'APP 进度对应的分集已变化，请先在 APP 中重新打开这部剧' };
      if (episode.locked) return { success: false, error: 'APP 进度对应的分集暂不可播放' };
      if (entry.dismissed) {
        entry.dismissed = false;
        entry.forgotten = false;
        saveSeriesRegistry();
      }
      resumePositions.set(sid, {
        episode_id: String(episode.vid),
        vid_index: Number(episode.vid_index),
        currentTime: Math.max(0, Number(row.currentTime) || 0),
        updatedAt: Number(row.updatedAt) || Date.now(),
      });
      return navigateToPlayer({ seriesId: sid, vidIndex: episode.vid_index, resume: true });
    } catch (error) {
      resumePositions.delete(String(seriesId || ''));
      return { success: false, error: safeMessage(error, '打开 APP 观看记录失败') };
    }
  });

  function takeResumePosition(seriesId) {
    const sid = String(seriesId);
    const position = resumePositions.get(sid);
    if (position) resumePositions.delete(sid);
    return position || null;
  }

  function historySource() {
    const accountId = service?.activeAccountId?.();
    return accountId ? { accountId, rows: service.cachedHistory() } : service?.localHistory?.();
  }

  return {
    takeResumePosition,
    isSignedIn: () => !!service?.activeAccountId?.(),
    startProgressSync() {
      if (!progressSync || syncStopped || syncTimer) return;
      syncTimer = setInterval(() => { void syncProgress(); }, 30000);
      syncTimer.unref?.();
      void syncProgress();
    },
    syncProgress,
    flushProgress,
    stopProgressSync() { syncStopped = true; clearInterval(syncTimer); },
    mergedHistory(rows) {
      const source = progressSync && historySource();
      return source ? mergeAccountWatchHistory(rows, source.rows, progressSync.getPlayback(), source.accountId) : rows;
    },
    hideAccountHistory(_sid, previous) {
      const accountId = progressSync && historySource()?.accountId;
      if (!accountId) return null;
      return { accountHidden: { ...previous?.accountHidden, [accountId]: Date.now() } };
    },
    trackPlayback(series, record, metadata) {
      if (!progressSync || !service) return record;
      const position = makePosition(series, record, metadata, service.activeAccountId());
      if (!position) return record;
      return { ...record, accountSyncPending: { ...record.accountSyncPending, [position.accountId]: position } };
    },
    recordProgressForTest(series, record, metadata) {
      if (!progressTest || !service) return;
      const position = makePosition(series, record, metadata, service.activeAccountId());
      if (position) progressCandidate = position;
    },
    peekWebSession: () => webSession,
    ready: () => webSessionReady,
  };
}

module.exports = { createAccountController };
