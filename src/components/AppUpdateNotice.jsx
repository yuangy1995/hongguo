import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import { X } from './icons';
import './AppUpdateNotice.css';

export default function AppUpdateNotice({ playbackActive: initialPlaybackActive = false } = {}) {
  useLanguage();
  const [release, setRelease] = useState(null);
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [playbackActive, setPlaybackActive] = useState(Boolean(initialPlaybackActive));
  const [error, setError] = useState('');
  const [state, setState] = useState({ supported: false, reason: '正在读取更新方式…', status: 'idle', percent: 0 });
  const currentState = useRef(state);
  const enabled = useRef(true);
  const playbackActiveRef = useRef(Boolean(initialPlaybackActive));
  const actionPending = useRef(false);
  const actionGeneration = useRef(0);
  const openingRelease = useRef(false);
  const checkPending = useRef(false);
  const requestedManually = useRef(false);
  const dismissed = useRef(new Set());
  const cancelledVersions = useRef(new Set());
  const deferredAutoCheck = useRef(false);
  const deferredAutoInstall = useRef(false);
  const playbackCancelPending = useRef(false);
  const checkNow = useRef(null);
  const downloadAndInstallNow = useRef(null);
  const closedAt = useRef(0);

  useEffect(() => {
    let generation = 0, stateRevision = 0, active = true, idleRetryTimer;
    checkPending.current = false;
    actionPending.current = false;
    deferredAutoCheck.current = false;
    deferredAutoInstall.current = false;
    playbackCancelPending.current = false;
    void window.electronAPI.setAppUpdatePlaybackActive?.(playbackActiveRef.current).catch(() => {});
    const receiveState = next => {
      if (!active || !next) return;
      const previousStatus = currentState.current.status;
      stateRevision++;
      currentState.current = next;
      setState(next);
      if (next.retryWhenIdle) retryInstallWhenIdle();
      if (next.status === 'error' && (previousStatus === 'installing' || next.downloaded === true)) setVisible(true);
    };
    const performInstall = async (request, retrying = false) => {
      actionPending.current = 'installAppUpdate';
      const installResult = await window.electronAPI.installAppUpdate();
      if (!active || request !== actionGeneration.current) return;
      if (installResult?.state) {
        currentState.current = installResult.state;
        setState(installResult.state);
      }
      if (installResult?.state?.fallbackManual) {
        setVisible(true);
        return;
      }
      if (installResult?.retryWhenIdle) retryInstallWhenIdle();
      if (!installResult?.success && enabled.current) {
        setError(installResult?.error || '无法启动更新安装，请重试。');
        if (!retrying || !installResult?.retryWhenIdle) setVisible(true);
      }
    };
    const installDeferred = async (retrying = false) => {
      if (!active || !enabled.current || actionPending.current || playbackActiveRef.current) return;
      const request = ++actionGeneration.current;
      setPending(true);
      setError('');
      try {
        await performInstall(request, retrying);
      } catch {
        if (active && request === actionGeneration.current && enabled.current) {
          setError('更新操作失败，请确认网络连接后重试。');
          setVisible(true);
        }
      } finally {
        if (active && request === actionGeneration.current) {
          actionPending.current = false;
          setPending(false);
        }
      }
    };
    const retryInstallWhenIdle = () => {
      clearTimeout(idleRetryTimer);
      deferredAutoInstall.current = true;
      idleRetryTimer = setTimeout(() => {
        const current = currentState.current;
        if (!active || !enabled.current || !deferredAutoInstall.current || current.fallbackManual ||
          (current.status !== 'downloaded' && !(current.status === 'error' && current.downloaded))) return;
        if (playbackActiveRef.current) return;
        if (actionPending.current) { retryInstallWhenIdle(); return; }
        deferredAutoInstall.current = false;
        void installDeferred(true);
      }, 5000);
    };
    const runDownloadAndInstall = async (targetVersion, { fromAuto = false } = {}) => {
      if (!active || !enabled.current || actionPending.current) return;
      if (fromAuto && playbackActiveRef.current) { deferredAutoCheck.current = true; return; }
      if (['checking', 'downloading', 'installing'].includes(currentState.current.status)) return;
      if (targetVersion) cancelledVersions.current.delete(targetVersion);
      const request = ++actionGeneration.current;
      actionPending.current = 'downloadAppUpdate';
      setPending(true);
      setError('');
      try {
        const downloadResult = await window.electronAPI.downloadAppUpdate();
        if (!active || request !== actionGeneration.current) return;
        if (downloadResult?.state) {
          currentState.current = downloadResult.state;
          setState(downloadResult.state);
        }
        if (!downloadResult?.success) {
          const version = targetVersion || currentState.current.version || '';
          if (enabled.current && !cancelledVersions.current.has(version)) {
            setError(downloadResult?.error || '更新下载或校验失败，请检查网络后重试。');
            if (fromAuto && !playbackActiveRef.current) setVisible(true);
          }
          return;
        }
        if (!enabled.current || downloadResult?.state?.fallbackManual) {
          if (downloadResult?.state?.fallbackManual) setVisible(true);
          return;
        }
        if (playbackActiveRef.current) {
          deferredAutoInstall.current = true;
          setVisible(false);
          return;
        }
        await performInstall(request);
      } catch {
        if (active && request === actionGeneration.current && enabled.current) {
          setError('更新操作失败，请确认网络连接后重试。');
          if (fromAuto && !playbackActiveRef.current) setVisible(true);
        }
      } finally {
        if (active && request === actionGeneration.current) {
          actionPending.current = false;
          setPending(false);
        }
      }
    };
    downloadAndInstallNow.current = runDownloadAndInstall;

    const revision = stateRevision;
    const initialStatePromise = window.electronAPI.getAppUpdateState().then(next => {
      if (revision === stateRevision) receiveState(next);
      return next;
    }).catch(() => {
      const fallback = { supported: false, reason: '无法读取应用内更新状态。', status: 'idle', percent: 0 };
      if (revision === stateRevision) receiveState(fallback);
      return fallback;
    });

    const check = async (manual = false) => {
      if (!manual && playbackActiveRef.current) { deferredAutoCheck.current = true; return; }
      if (manual) {
        requestedManually.current = true;
        setVisible(true);
        setError('');
        dismissed.current.clear();
        cancelledVersions.current.clear();
      }
      if (checkPending.current || ['checking', 'downloading', 'downloaded', 'installing'].includes(currentState.current.status)) return;
      checkPending.current = true;
      requestedManually.current = manual;
      const request = ++generation;
      const closure = closedAt.current;
      setChecking(true);
      let nextRelease = null;
      let suppressed = false;
      try {
        await initialStatePromise;
        if (!active || request !== generation) return;
        if (currentState.current.downloaded === true || ['checking', 'downloading', 'downloaded', 'installing'].includes(currentState.current.status)) return;
        const result = await window.electronAPI.checkAppUpdate();
        if (!active || request !== generation) return;
        enabled.current = result?.enabled === true;
        if (!enabled.current) {
          setRelease(null);
          if (requestedManually.current) setError(result?.error || '更新检测已关闭，请在设置中开启后重试。');
          else setVisible(false);
          return;
        }
        if (result.error) {
          setRelease(null);
          setError(result.error);
          return;
        }
        setError('');
        setRelease(result.release || null);
        if (result.release) {
          if (playbackActiveRef.current) {
            deferredAutoCheck.current = true;
            if (!requestedManually.current) {
              setVisible(false);
              return;
            }
            if (closure !== closedAt.current) dismissed.current.add(result.release.version);
            else if (!dismissed.current.has(result.release.version)) setVisible(true);
            return;
          }
          suppressed = closure !== closedAt.current;
          if (suppressed) dismissed.current.add(result.release.version);
          else if (!dismissed.current.has(result.release.version)) setVisible(true);
          nextRelease = result.release;
        }
      } catch {
        if (active && request === generation) { setRelease(null); setError('检查更新失败，请确认网络连接后重试。'); }
      } finally {
        if (active && request === generation) { checkPending.current = false; setChecking(false); }
      }
      if (nextRelease && active && request === generation && !suppressed && enabled.current && currentState.current.supported && !cancelledVersions.current.has(nextRelease.version)) {
        if (playbackActiveRef.current) deferredAutoCheck.current = true;
        else void runDownloadAndInstall(nextRelease.version, { fromAuto: true });
      }
    };
    checkNow.current = check;
    const manualCheck = () => check(true);
    const onPlaybackActive = event => {
      const nextPlaying = Boolean(event?.detail);
      if (nextPlaying === playbackActiveRef.current) return;
      playbackActiveRef.current = nextPlaying;
      void window.electronAPI.setAppUpdatePlaybackActive?.(nextPlaying).catch(() => {});
      setPlaybackActive(nextPlaying);
      if (nextPlaying) {
        if (checkPending.current) deferredAutoCheck.current = true;
        const activeStatus = currentState.current.status;
        if (['checking', 'downloading'].includes(activeStatus) || actionPending.current === 'downloadAppUpdate') {
          deferredAutoCheck.current = true;
          actionGeneration.current++;
          actionPending.current = false;
          setPending(false);
          setVisible(false);
          setError('');
          playbackCancelPending.current = true;
          Promise.resolve(window.electronAPI.cancelAppUpdate?.()).then(res => {
            if (!active) return;
            if (res?.state) {
              currentState.current = res.state;
              setState(res.state);
            }
          }).catch(() => {}).finally(() => {
            playbackCancelPending.current = false;
            if (!active || playbackActiveRef.current || !enabled.current) return;
            if (deferredAutoCheck.current) {
              deferredAutoCheck.current = false;
              void check(false);
            }
          });
        } else if (activeStatus === 'downloaded' || actionPending.current === 'installAppUpdate') {
          deferredAutoInstall.current = true;
          setVisible(false);
          setError('');
        }
        return;
      }
      if (!active || !enabled.current) return;
      if (deferredAutoInstall.current && (currentState.current.status === 'downloaded' || currentState.current.downloaded === true) && !currentState.current.fallbackManual) {
        deferredAutoInstall.current = false;
        clearTimeout(idleRetryTimer);
        void installDeferred();
        return;
      }
      if (deferredAutoCheck.current && !playbackCancelPending.current) {
        deferredAutoCheck.current = false;
        void check(false);
      }
    };
    window.addEventListener('hongguo-check-app-update', manualCheck);
    window.addEventListener('hongguo-playback-active', onPlaybackActive);
    const unsubscribeState = window.electronAPI.onAppUpdateState(receiveState);
    const unsubscribePreference = window.electronAPI.onAppUpdatePreference(value => {
      generation++;
      actionGeneration.current++;
      checkPending.current = false;
      actionPending.current = false;
      cancelledVersions.current.clear();
      setChecking(false);
      setPending(false);
      enabled.current = value;
      if (value) {
        if (playbackActiveRef.current) deferredAutoCheck.current = true;
        else check();
      } else {
        deferredAutoCheck.current = false;
        deferredAutoInstall.current = false;
        playbackCancelPending.current = false;
        clearTimeout(idleRetryTimer);
        setVisible(false);
        setError('');
      }
    });
    check();
    const timer = setInterval(() => check(), 6 * 60 * 60 * 1000);
    return () => {
      active = false;
      generation++;
      actionGeneration.current++;
      checkNow.current = null;
      downloadAndInstallNow.current = null;
      clearInterval(timer);
      clearTimeout(idleRetryTimer);
      window.removeEventListener('hongguo-check-app-update', manualCheck);
      window.removeEventListener('hongguo-playback-active', onPlaybackActive);
      unsubscribeState();
      unsubscribePreference();
    };
  }, []);

  const close = () => {
    closedAt.current++;
    if (release) dismissed.current.add(release.version);
    setVisible(false);
    setError('');
  };
  useDialogKeyboard(visible, close, '.app-update-notice');
  const act = async kind => {
    if (kind === 'openAppUpdate') {
      if (!enabled.current || openingRelease.current) return;
      openingRelease.current = true;
      try {
        const result = await window.electronAPI.openAppUpdate();
        if (!result?.success && enabled.current) setError(result?.error || '无法打开发布页，请稍后重试。');
      } catch { if (enabled.current) setError('无法打开发布页，请稍后重试。'); }
      finally { openingRelease.current = false; }
      return;
    }
    const cancelling = kind === 'cancelAppUpdate';
    if (!enabled.current) return;
    if (cancelling) {
      if (actionPending.current === 'cancelAppUpdate' || !['checking', 'downloading'].includes(currentState.current.status) && actionPending.current !== 'downloadAppUpdate') return;
      const cancelledVersion = currentState.current.version || release?.version;
      if (cancelledVersion) cancelledVersions.current.add(cancelledVersion);
    } else if (actionPending.current || checkPending.current || ['checking', 'downloading', 'installing'].includes(currentState.current.status)) return;
    const request = ++actionGeneration.current;
    actionPending.current = kind;
    setPending(true);
    setError('');
    try {
      const result = await window.electronAPI[kind]();
      if (request !== actionGeneration.current) return;
      if (result?.state) { currentState.current = result.state; setState(result.state); }
      if (!result?.success && enabled.current) setError(result?.error || '更新操作失败，请稍后重试。');
    } catch {
      if (request === actionGeneration.current && enabled.current) setError('更新操作失败，请确认网络连接后重试。');
    } finally { if (request === actionGeneration.current) { actionPending.current = false; setPending(false); } }
  };

  if (!visible) return null;
  const downloading = state.status === 'downloading';
  const downloaded = state.status === 'downloaded' || state.status === 'error' && state.downloaded === true;
  const installing = state.status === 'installing';
  const preparingDownload = state.status === 'checking';
  const fallbackManual = state.fallbackManual === true;
  const busy = pending || checking || downloading || installing || preparingDownload;
  const version = (preparingDownload || downloading || downloaded || installing || state.status === 'error')
    ? state.version || release?.version : release?.version;
  const updateError = error || ((version || state.status === 'error') ? state.error : '');
  const percent = Math.max(0, Math.min(100, Math.round(state.percent || 0)));
  const title = checking ? '正在检查更新…'
    : installing ? '正在更新并重启…'
    : downloaded ? `新版 v${version} 已下载`
    : (downloading || preparingDownload) ? `正在下载 v${version}`
    : version ? `发现新版本 v${version}`
    : '检查更新';
  let description = '已是最新版本。';
  if (checking) description = '正在查询新版本，请稍候。';
  else if (installing) description = '正在应用内完成更新，完成后将自动重新打开。';
  else if (downloaded) description = fallbackManual
    ? '当前安装位置无法自动更新，请打开已下载的安装包，退出应用后将其拖入「应用程序」替换。'
    : playbackActive
      ? '当前正在播放视频，已暂停自动更新；暂停或结束播放后将自动重启更新。'
      : '新版已下载完成，可在任务空闲时立即重启并完成更新。';
  else if (downloading) description = '新版正在下载，播放和任务空闲后将自动安装并重启。';
  else if (preparingDownload) description = '检测到新版本，正在准备应用内下载…';
  else if (version) description = !state.supported ? state.reason
    : playbackActive
      ? '当前正在播放视频，已暂停自动下载与更新；暂停或结束播放后将自动继续。'
      : '可在应用内自动下载并完成更新。';
  else if (updateError) description = '可稍后重新检查。';
  const installLabel = fallbackManual ? '打开安装包' : '立即重启更新';
  const visualState = updateError ? 'error' : downloaded ? 'ready' : (checking || downloading || installing || preparingDownload) ? 'busy' : version ? 'available' : 'idle';
  return <div className="app-update-mask" onClick={close}>
    <section className="app-update-notice" data-state={visualState} role="dialog" aria-modal="true" aria-label={t("软件更新")} aria-describedby="app-update-description" tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div className="app-update-head">
        <span className="app-update-pill"><span className="app-update-dot" aria-hidden="true" /><span>{t("软件更新")}</span></span>
        <button type="button" className="icon-btn app-update-close" aria-label={t("关闭更新提醒")} title={t("关闭更新提醒")} onClick={close}><X size={16} /></button>
      </div>
      <h2 aria-live="polite">{t(title)}</h2>
      <div className="app-update-body">
        <p id="app-update-description">{t(description)}</p>
        {downloading && <div className="app-update-progress"><progress max="100" value={percent} aria-label={t("更新下载进度")} /><span>{t(percent)}%</span></div>}
      </div>
      {updateError && <p className="app-update-error" role="alert">{t(updateError)}</p>}
      <div className="app-update-actions">
        {(version || downloaded) && <button type="button" className="btn btn-primary" disabled={busy || !enabled.current} onClick={() => {
          if (downloaded) return act('installAppUpdate');
          if (state.supported) return downloadAndInstallNow.current?.(version);
          return act('openAppUpdate');
        }}>
          {t(installing ? '正在更新…' : (downloading || preparingDownload) ? '正在下载…' : pending ? '请稍候…' : downloaded ? installLabel : state.supported ? '下载并更新' : '前往 GitHub 下载')}
        </button>}
        {(!version || updateError) && !busy && <button type="button" className="btn btn-outline" onClick={() => checkNow.current?.(true)}>{t("重新检查")}</button>}
        {(downloading || preparingDownload || (pending && actionPending.current === 'downloadAppUpdate')) && <button type="button" className="btn btn-outline" disabled={actionPending.current === 'cancelAppUpdate' || !enabled.current} onClick={() => act('cancelAppUpdate')}>{t("取消下载")}</button>}
      </div>
    </section>
  </div>;
}
