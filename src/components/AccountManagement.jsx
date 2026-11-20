import { t, useLanguage, getLanguage } from '../i18n';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Search, User, X } from './icons';
import './AccountManagement.css';

const HISTORY_VIEW_KEY = 'hongguo:account-history-view';

export default function AccountManagement({ active = true, loginDialog = false }) {
  useLanguage();
  const [account, setAccount] = useState(null);
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [historyView, setHistoryView] = useState(() => {
    try { return window.localStorage.getItem(HISTORY_VIEW_KEY) === 'list' ? 'list' : 'cards'; }
    catch { return 'cards'; }
  });
  const [qr, setQr] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState(loginDialog);
  const [progressTest, setProgressTest] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const request = useRef(0);
  const historyRequest = useRef(0);
  const generation = useRef(0);
  const pollTimer = useRef(null);
  const qrActive = useRef(false);
  const visibleQr = qr && (!loginDialog || secondsLeft > 0);
  const visibleRows = rows.filter(row => !query.trim() || row.series_title.includes(query.trim()));
  const showHistory = !loginDialog;

  const loadHistory = async (refresh = false) => {
    const version = ++historyRequest.current;
    setHistoryLoading(true);
    try {
      const result = await window.electronAPI.getAccountHistory?.({ refresh, importTestProgress: progressTest && refresh });
      if (version !== historyRequest.current) return;
      if (!result?.success) throw new Error(result?.error || 'APP 观看记录加载失败');
      setRows(result.signedIn ? result.results || [] : []);
      if (result.importedTestProgress) setStatus('已把云端的较新进度保存到测试版的本机记录。');
      else if (result.warning) setStatus(`已读取 APP 记录；${result.warning}`);
      else if (refresh) setStatus('已刷新账号观看记录。');
    } catch (failure) {
      if (version === historyRequest.current) setError(failure.message || 'APP 观看记录加载失败，请重试');
    } finally {
      if (version === historyRequest.current) setHistoryLoading(false);
    }
  };

  const load = async () => {
    const version = ++request.current;
    try {
      const result = await window.electronAPI.getAccountStatus?.();
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '账号状态读取失败');
      setAccount(result.account || null);
      setProgressTest(result.progressTest === true);
      setError(result.error || '');
      setLoading(false);
      if (result.signedIn && showHistory) {
        await loadHistory();
      } else {
        historyRequest.current++;
        setRows([]);
      }
    } catch (failure) {
      if (version === request.current) setError(failure.message || '账号状态读取失败，请重试');
    } finally {
      if (version === request.current) {
        setLoading(false);
      }
    }
  };

  const finishLogin = ({ status = '', error = '' }) => {
    generation.current++;
    clearTimeout(pollTimer.current);
    setQr(null);
    setBusy(false);
    setStatus(status);
    setError(error);
  };

  const schedulePoll = (loginId, token, expiresAt) => {
    clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      if (token !== generation.current) return;
      try {
        const result = await window.electronAPI.pollAccountLogin?.(loginId);
        if (token !== generation.current) return;
        if (!result?.success) throw new Error(result?.error || '扫码状态读取失败');
        if (result.status === 'signed-in') {
          qrActive.current = false;
          finishLogin({ status: result.storageWarning || '登录成功' });
          setAccount(result.account || null);
          if (showHistory) loadHistory();
          return;
        }
        if (result.status === 'cancelled') { finishLogin({ status: '扫码已取消' }); return; }
        if (result.status === 'expired' || (loginDialog && Date.now() >= expiresAt)) {
          if (loginDialog) void beginLogin();
          else {
            qrActive.current = false;
            finishLogin({ error: '二维码已过期，请重新获取。' });
          }
          return;
        }
        setStatus('等待手机确认扫码登录…');
        schedulePoll(loginId, token, expiresAt);
      } catch (failure) {
        if (token === generation.current) {
          finishLogin({ error: failure.message || '扫码登录未完成，请重试' });
        }
      }
    }, loginDialog ? Math.max(0, Math.min(1000, expiresAt - Date.now())) : 1000);
  };

  const beginLogin = async () => {
    const token = ++generation.current;
    clearTimeout(pollTimer.current);
    qrActive.current = true;
    setQr(null);
    setBusy(true); setError(''); setStatus('正在获取红果登录二维码…');
    try {
      const result = await window.electronAPI.startAccountLogin?.();
      if (token !== generation.current) return;
      if (!result?.success) throw new Error(result?.error || '二维码获取失败');
      const now = Date.now();
      const expiresAt = result.expiresAt ?? now + result.expiresIn * 1000;
      if (loginDialog && (!Number.isFinite(expiresAt) || expiresAt <= now)) throw new Error('二维码获取失败，请重试');
      setQr({ id: result.loginId, image: result.image, expiresAt });
      if (loginDialog) setSecondsLeft(Math.ceil((expiresAt - now) / 1000));
      setStatus(loginDialog ? '等待手机确认扫码登录…' : `请用手机红果 App 扫码，并在手机上确认登录。二维码约 ${result.expiresIn} 秒有效。`);
      schedulePoll(result.loginId, token, expiresAt);
    } catch (failure) {
      if (token === generation.current) {
        qrActive.current = false;
        finishLogin({ error: failure.message || '二维码获取失败，请重试' });
      }
    }
  };

  const cancelLogin = async () => {
    const id = qr?.id;
    qrActive.current = false;
    finishLogin({ status: '已取消扫码登录' });
    if (id) await window.electronAPI.cancelAccountLogin?.(id).catch(() => {});
  };

  const logout = async () => {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await window.electronAPI.logoutAccount?.();
      if (!result?.success) throw new Error(result?.error || '退出账号失败');
      historyRequest.current++;
      setAccount(null); setRows([]); setQuery(''); setStatus('已退出红果账号，本机记录不受影响。');
    } catch (failure) { setError(failure.message || '退出账号失败，请重试'); }
    finally { setBusy(false); }
  };

  const open = async row => {
    if (!active || busy) return;
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.playAccountHistory?.(row.series_id);
      if (!result?.success) throw new Error(result?.error || '打开 APP 观看记录失败');
    } catch (failure) { setError(failure.message || '打开 APP 观看记录失败，请重试'); }
    finally { setBusy(false); }
  };

  const testProgressSync = async () => {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await window.electronAPI.testAccountProgressSync();
      if (!result?.success) throw new Error(result?.error || '进度同步测试未完成。');
      if (result.status === 'uploaded') {
        await loadHistory();
        setStatus('云端已读回这条进度，请在手机红果 App 中刷新并核对。');
      } else if (result.status === 'downloaded') setStatus('已把云端的较新进度保存到测试版的本机记录。');
      else if (result.status === 'unchanged') setStatus('本机与云端的分集和断点已一致。');
    } catch (failure) { setError(failure.message || '进度同步测试未完成。'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (active && !loginDialog) load();
    return () => { request.current++; historyRequest.current++; };
  }, [active, loginDialog]);
  useEffect(() => window.electronAPI.onAccountUpdated?.(result => {
    if (!active || loginDialog) return;
    if (result?.error) setError(result.error);
    else {
      if (result?.storageWarning) setStatus(result.storageWarning);
      load();
    }
  }), [active, loginDialog]);
  useEffect(() => {
    const auto = loginDialog ? setTimeout(beginLogin, 0) : null;
    return () => {
      generation.current++;
      clearTimeout(auto);
      clearTimeout(pollTimer.current);
      if (loginDialog && qrActive.current) void window.electronAPI.cancelAccountLogin?.().catch(() => {});
    };
  }, [loginDialog]);
  useEffect(() => {
    if (!loginDialog || !qr) return;
    let timer;
    const update = () => {
      const remaining = qr.expiresAt - Date.now();
      setSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
      if (remaining > 0) timer = setTimeout(update, remaining % 1000 || 1000);
    };
    update();
    return () => clearTimeout(timer);
  }, [loginDialog, qr]);

  if (loading && !loginDialog) return <div className="account-page"><p role="status">{t("正在读取红果账号…")}</p></div>;

  const changeHistoryView = view => {
    setHistoryView(view);
    try { window.localStorage.setItem(HISTORY_VIEW_KEY, view); } catch {}
  };
  const feedback = <>
    {status && <p className="account-page-status" role="status">{t(status)}</p>}
    {error && <div className="history-error" role="alert"><span>{t(error)}</span></div>}
  </>;

  return <div className="account-page">
    {!loginDialog && <div className="account-page-header duplicate-page-title">
      <User size={22} />
      <h2>{t("红果账号")}</h2>
    </div>}
    <section className={account ? 'account-content' : loginDialog ? 'account-login-panel' : 'account-card'} data-signed-in={!!account} aria-label={t("红果账号状态")}>
      {account ? <>
        <header className="account-profile">
          <div className="account-identity">
            <span className="account-avatar" aria-hidden="true"><User size={24} /></span>
            <div><strong>{account.nickname}</strong><p>{t("已登录红果账号")}</p></div>
          </div>
          <div className="account-page-actions">
            {progressTest && <button className="btn btn-outline" type="button" disabled={busy || historyLoading}
              onClick={testProgressSync}>{t("测试同步最近观看")}</button>}
            <button className="btn btn-outline" type="button" disabled={busy || historyLoading} onClick={async () => {
              setBusy(true); setError(''); setStatus('');
              try { await loadHistory(true); } finally { setBusy(false); }
            }}><RefreshCw size={15} />{t("刷新记录")}</button>
            <button className="btn btn-outline" type="button" disabled={busy} onClick={logout}>{t("退出账号")}</button>
          </div>
        </header>
        {feedback}
        {showHistory && <>
        <div className="account-history-heading">
          <div className="account-history-title">
            <h3>{t("观看记录")}</h3>
            {(!historyLoading || !!rows.length) && <span>{t("共 {0} 条观看记录", [rows.length])}</span>}
          </div>
          <div className="account-history-tools">
            <label className="account-history-search">
              <Search size={15} aria-hidden="true" />
              <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                aria-label={t("搜索")} placeholder={t("输入剧名")} />
            </label>
            <div className="account-history-views" role="group" aria-label={t("显示方式")}>
              <button type="button" aria-pressed={historyView === 'cards'} onClick={() => changeHistoryView('cards')}>{t("卡片")}</button>
              <button type="button" aria-pressed={historyView === 'list'} onClick={() => changeHistoryView('list')}>{t("列表")}</button>
            </div>
          </div>
        </div>
        {t(historyLoading && !rows.length ? <div className="account-history-empty" role="status">{t("正在读取 APP 观看记录…")}</div>
          : !rows.length ? <div className="account-history-empty">{t("APP 还没有观看记录。")}</div>
          : !visibleRows.length ? <div className="account-history-empty">{t("没有匹配的 APP 记录。")}</div>
          : <ul className="account-history-list" data-view={historyView}>{visibleRows.map(row => <li key={row.series_id}>
            <button type="button" disabled={busy} onClick={() => open(row)} aria-label={t(`继续观看 ${row.series_title} 第${row.vid_index}集`)}>
              <span className="account-history-cover">
                {row.cover && <img key={row.cover} src={row.cover} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />}
                <Play size={18} aria-hidden="true" />
              </span>
              <span className="account-history-copy">
                <strong title={row.series_title}>{row.series_title}</strong>
                <small>{t("看到第 ")}{t(row.vid_index || '?')}{t(" 集")}{t(row.total ? ` / 共 ${row.total} 集` : '')} · {Math.floor((row.currentTime || 0) / 60)}:{String(Math.floor((row.currentTime || 0) % 60)).padStart(2, '0')}</small>
                <small>{t(row.updatedAt ? new Date(row.updatedAt).toLocaleString(getLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知')}</small>
              </span>
              <span className="account-history-action"><Play size={14} />{t("继续观看")}</span>
            </button>
          </li>)}</ul>)}
        </>}
      </> : <>
        <div className="account-login-copy">
          {!loginDialog && <span className="account-avatar" aria-hidden="true"><User size={22} /></span>}
          <h3>{t("扫码登录")}</h3>
          {loginDialog && visibleQr && <p>{t("手机红果 App → 我的 → 扫一扫")}</p>}
        </div>
        {visibleQr && <div className="account-qr">
          <img src={qr.image} alt={t("红果登录二维码")} />
          {loginDialog ? <time dateTime={`PT${secondsLeft}S`}>{t("有效期剩余 {0} 秒", [secondsLeft])}</time>
            : <span>{t("手机红果 App → 我的 → 扫一扫")}</span>}
        </div>}
        {loginDialog && feedback}
        <div className="account-page-actions">
          {qr ? <button className="btn btn-outline" type="button" onClick={cancelLogin}>{t("取消扫码")}</button>
            : <button className="btn btn-primary" type="button" disabled={busy} onClick={beginLogin}>{t(busy ? '正在获取二维码…' : '获取登录二维码')}</button>}
          <button className="btn btn-outline" type="button" disabled={busy && (!loginDialog || !qr)} onClick={async () => {
            try {
              setError('');
              if (loginDialog && qrActive.current) {
                qrActive.current = false;
                finishLogin({});
                setBusy(true);
                await window.electronAPI.cancelAccountLogin?.(qr?.id);
              }
              const result = await window.electronAPI.openAccountWebLogin();
              if (!result?.success) throw new Error(result?.error || '打开官网登录失败');
            } catch (failure) { setError(failure.message); }
            finally { if (loginDialog) setBusy(false); }
          }}>{t("使用官网登录")}</button>
        </div>
        {!loginDialog && feedback}
      </>}
    </section>
  </div>;
}

export function AccountSidebar({ onCheckpoint }) {
  useLanguage();
  const [account, setAccount] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const dialog = useRef(null);
  const request = useRef(0);

  useEffect(() => {
    const read = async () => {
      const version = ++request.current;
      try {
        const value = await window.electronAPI.getAccountStatus();
        if (version === request.current) setAccount(value);
      } catch {
        if (version === request.current) setAccount({ error: true });
      }
    };
    void read();
    const unsubscribe = window.electronAPI.onAccountUpdated?.(result => {
      if (result?.signedIn) setOpen(false);
      if (result?.error) setFeedback(result.error);
      if (result?.storageWarning) setFeedback(result.storageWarning);
      void read();
    });
    return () => { request.current++; unsubscribe?.(); };
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, [open]);

  const logout = async () => {
    setBusy(true); setFeedback('');
    try {
      await onCheckpoint?.();
      const result = await window.electronAPI.logoutAccount();
      if (!result?.success) throw new Error(result?.error || '退出账号失败，请重试');
      request.current++;
      setAccount(result);
      setFeedback(result.storageWarning || (result.syncIncomplete ? '部分进度未同步，已保留本机记录。' : ''));
    } catch (error) { setFeedback(error.message || '退出账号失败，请重试'); }
    finally { setBusy(false); }
  };

  return <div className="sidebar-account">
    <div className="sidebar-account-status" role="status">
      <User size={17} aria-hidden="true" />
      <div><strong title={account?.account?.nickname}>{t('红果账号')}</strong>
        <small data-expired={account?.expired === true}>{t(!account ? '正在读取…' : account.expired ? '登录已失效，请重新登录' : account.signedIn ? '已登录' : account.error || account.success === false ? '登录状态暂时无法读取' : '未登录')}</small>
      </div>
    </div>
    {account && (account.signedIn
      ? <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={logout}>{t(busy ? '正在退出…' : '退出账号')}</button>
      : <button type="button" className="btn btn-outline btn-sm" aria-haspopup="dialog" onClick={() => { setFeedback(''); setOpen(true); }}>{t(account.expired ? '重新登录' : '登录')}</button>)}
    {feedback && <p className="sidebar-account-feedback" role="status">{t(feedback)}</p>}
    {open && <dialog className="account-login-dialog" ref={dialog} aria-label={t('红果账号登录')} onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <button className="btn btn-outline btn-sm account-dialog-close" type="button" aria-label={t('关闭')} onClick={() => setOpen(false)}><X size={16} /></button>
      <AccountManagement loginDialog />
    </dialog>}
  </div>;
}
