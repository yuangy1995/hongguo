import { t, useLanguage, getLanguage } from '../i18n';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Play, RefreshCw, Clock, Search } from './icons';
import './WatchHistory.css';
import { groupHistory, historyGroupSuggestions } from './historyGroups.mjs';
import { RollingNumber } from './SoftControls';

const PREFERENCES_KEY = 'hongguo:watch-history-preferences';
const ACCOUNT_VIEW_KEY = 'hongguo:account-history-view';
const CARD_SIZE_KEY = 'hongguo:history-card-size';
const CARD_SIZES = ['small', 'standard', 'large'];
const OFFICIAL_SEASONS_TTL = 10 * 60 * 1000;

export default function WatchHistory({ active = true, onNavigate }) {
  useLanguage();
  const mobile = window.electronAPI?.platform === 'android';
  const Relations = mobile ? 'div' : 'details';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [accountSignedIn, setAccountSignedIn] = useState(false);
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState(() => {
    try { return window.localStorage.getItem(ACCOUNT_VIEW_KEY) === 'list' ? 'list' : 'cards'; }
    catch { return 'cards'; }
  });
  const [cardSize, setCardSize] = useState(() => {
    try {
      const saved = window.localStorage.getItem(CARD_SIZE_KEY);
      return CARD_SIZES.includes(saved) ? saved : 'standard';
    } catch { return 'standard'; }
  });
  const [checkingRow, setCheckingRow] = useState('');
  const [opening, setOpening] = useState('');
  const [removing, setRemoving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(null);
  const showNotice = (text, type = 'info', duration) => {
    if (typeof clearTimeout === 'function') clearTimeout(noticeTimer.current);
    setNotice(text ? { text, type } : null);
    if (text && typeof setTimeout === 'function') {
      const ms = duration ?? (type === 'error' || type === 'warning' ? 4500 : 3200);
      noticeTimer.current = setTimeout(() => setNotice(null), ms);
    }
  };
  useEffect(() => () => { if (typeof clearTimeout === 'function') clearTimeout(noticeTimer.current); }, []);
  const [expanded, setExpanded] = useState({});
  const [decisions, setDecisions] = useState(() => {
    try { const value = JSON.parse(localStorage.getItem('hongguo:history-groups')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const decide = (id, target) => {
    const next = { ...decisions };
    if (target === null) {
      const remaining = groupHistory(rows, decisions).find(items => items.some(row => row.series_id === id))?.filter(row => row.series_id !== id) || [];
      // Keep the new anchor manual so its automatic family cannot absorb other rows.
      for (const row of remaining) if (next[row.series_id] === id) next[row.series_id] = remaining[0].series_id;
    }
    if (target === undefined) delete next[id]; else next[id] = target;
    try { localStorage.setItem('hongguo:history-groups', JSON.stringify(next)); setDecisions(next); }
    catch { setError('分组未能保存，请检查本地存储后重试'); }
  };
  const [filter, setFilter] = useState('all');
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY));
      return {
        scope: ['all', 'latest', 'unfinished', 'skip-completed-low'].includes(saved?.scope) ? saved.scope : 'all',
        hideLowSeasons: saved?.hideLowSeasons === true,
      };
    } catch { return { scope: 'all', hideLowSeasons: false }; }
  });
  const { scope, hideLowSeasons } = preferences;
  const [progress, setProgress] = useState(null);
  const request = useRef(0);
  const openingRef = useRef(false);
  const openingRequest = useRef(0);
  const seasonRequest = useRef(null);
  const [seasonPanel, setSeasonPanel] = useState(null);
  const groups = groupHistory(rows, decisions);
  const groupById = new Map(groups.flatMap(items => items.map(row => [row.series_id, items])));
  const suggestionsByGroup = new Map(groups.map(items => [items, historyGroupSuggestions(items)]));
  const listedGroups = groups.map(items => hideLowSeasons && !expanded[items[0].series_id] ? items.slice(0, 1) : items);
  const listedRows = listedGroups.flat();
  const completedCount = listedRows.filter(row => row.completed === true).length;
  const visibleRows = listedGroups.map(items => items
    .filter(row => (filter === 'all' || (row.completed === true) === (filter === 'completed'))
      && (!accountSignedIn || row.series_title.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => b.updatedAt - a.updatedAt))
    .filter(items => items.length).sort((a, b) => b[0].updatedAt - a[0].updatedAt).flat();

  const savePreferences = next => {
    setPreferences(next);
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); }
    catch { showNotice('本次选择已生效，但未能保存；重启后可能恢复默认。', 'warning'); }
  };

  const load = async () => {
    const version = ++request.current;
    try {
      const result = await window.electronAPI.getWatchHistory();
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '观看记录加载失败');
      setRows(result.results || []);
      setAccountSignedIn(result.accountSignedIn === true);
      setError('');
    } catch (failure) {
      if (version === request.current) setError(failure.message || '观看记录加载失败，请重试');
    } finally { if (version === request.current) setLoading(false); }
  };

  useLayoutEffect(() => {
    setOpening(''); openingRef.current = false;
    if (!active) {
      document.querySelector?.('.history-seasons-menu:popover-open')?.hidePopover?.();
      setSeasonPanel(null);
    }
    return () => { openingRequest.current++; openingRef.current = false; seasonRequest.current = null; };
  }, [active]);
  useEffect(() => {
    if (active) {
      load();
      if (!mobile) void window.electronAPI.syncAccountProgress?.().catch(() => {});
    }
    else {
      document.querySelector?.('.history-menu:popover-open')?.hidePopover?.();
      if (typeof clearTimeout === 'function') clearTimeout(noticeTimer.current);
      setNotice(null);
    }
    return () => { request.current++; };
  }, [active, mobile]);
  useEffect(() => window.electronAPI.onWatchHistoryUpdated?.(() => { if (active) load(); }), [active]);
  useEffect(() => window.electronAPI.onAccountUpdated?.(() => { if (active) load(); }), [active]);
  useEffect(() => window.electronAPI.onWatchHistoryProgress?.(data => { if (active) setProgress(data); }), [active]);
  useEffect(() => window.electronAPI.onAccountProgressSyncStatus?.(data => setSyncError(data?.error || '')), []);

  const refreshAccount = async () => {
    setRefreshingAccount(true); setError(''); showNotice('');
    try {
      const result = await window.electronAPI.getAccountHistory({ refresh: true });
      if (!result?.success) throw new Error(result?.error || '账号观看记录同步失败，请稍后重试。');
      await load();
      showNotice('已同步账号观看记录。', 'success');
    } catch (failure) {
      const msg = failure.message || '账号观看记录同步失败，请稍后重试。';
      if (rows.length) showNotice(msg, 'error'); else setError(msg);
    }
    finally { setRefreshingAccount(false); }
  };

  const checkUpdates = async () => {
    setChecking(true); showNotice(''); setError(''); setProgress(null);
    try {
      const result = await window.electronAPI.refreshWatchHistory({ scope });
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      const msg = `已检查 ${result.checked} 部${result.failed ? `，${result.failed} 部未完成，可稍后重试` : ''}${result.remaining ? `；本次预算内还有 ${result.remaining} 部，点击继续检查` : ''}`;
      showNotice(msg, result.failed || result.remaining ? 'warning' : result.checked > 0 ? 'success' : 'info');
    } catch (failure) {
      const msg = failure.message || '检查失败，请重试';
      if (rows.length) showNotice(msg, 'error'); else setError(msg);
    }
    finally { setChecking(false); setProgress(null); }
  };

  const checkRow = async (row) => {
    if (checking || checkingRow) return;
    setCheckingRow(row.series_id); showNotice(''); setError('');
    try {
      const result = await window.electronAPI.checkWatchHistoryItem(row.series_id);
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      if (result.error) showNotice(`《${row.series_title}》分集已检查；续作检查未完成：${result.error}`, 'warning');
      else showNotice(`《${row.series_title}》${result.checked ? '已检测完成' : '没有可更新的记录'}。`, result.checked ? 'success' : 'info');
    } catch (failure) {
      await load();
      const msg = failure.message || '检查失败，请重试';
      if (rows.length) showNotice(msg, 'error'); else setError(msg);
    }
    finally { setCheckingRow(''); }
  };

  const remove = async (row) => {
    setRemoving(row.series_id); setError(''); showNotice('');
    try {
      const result = await window.electronAPI.removeWatchHistory(row.series_id);
      if (!result?.success) throw new Error(result?.error || '移除失败，请重试');
      setRows(current => current.filter(item => item.series_id !== row.series_id));
      showNotice(`已移除《${row.series_title}》的观看记录，视频文件不受影响。`, 'info');
      void load();
    } catch (failure) {
      const msg = failure.message || '移除失败，请重试';
      if (rows.length) showNotice(msg, 'error'); else setError(msg);
    }
    finally { setRemoving(''); }
  };

  const loadSeasons = async seriesId => {
    if (!active) return;
    const previous = seasonRequest.current;
    if (previous?.id === seriesId && (previous.pending || previous.expiresAt > Date.now())) return;
    const pending = { id: seriesId, pending: true };
    seasonRequest.current = pending;
    setSeasonPanel({ id: seriesId, loading: true });
    try {
      const result = await window.electronAPI.findSeriesSeasons(seriesId);
      if (seasonRequest.current !== pending) return;
      if (result?.official !== true || result.partial || !Array.isArray(result.results)) throw new Error();
      pending.expiresAt = Date.now() + OFFICIAL_SEASONS_TTL;
      setSeasonPanel({ id: seriesId, results: result.results });
    } catch {
      if (seasonRequest.current === pending) setSeasonPanel({ id: seriesId, error: true });
    } finally {
      pending.pending = false;
    }
  };

  const resume = async (row, sequel = null, acknowledge = true) => {
    if (!active || openingRef.current) return;
    const version = ++openingRequest.current;
    openingRef.current = true;
    setOpening(row.series_id); setError('');
    try {
      if (sequel) {
        let result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: 1 });
        if (!result?.success && version !== openingRequest.current) return;
        if (!result?.success && result?.code === 'SERIES_NOT_FOUND') {
          const detail = await window.electronAPI.searchResolve(sequel.series_id);
          if (version !== openingRequest.current) return;
          if (!detail?.success) throw new Error(detail?.error || '续作详情暂不可用');
          const episode = detail.data?.episodes?.find(item => !item.locked);
          if (!episode) throw new Error('续作暂时没有可播放的分集');
          result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: episode.vid_index });
        }
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      } else {
        const result = row.account && !mobile
          ? await window.electronAPI.playAccountHistory(row.series_id, { merged: true })
          : await window.electronAPI.playSeries({ seriesId: row.series_id, vidIndex: row.vid_index, resume: true });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      }
      // Opening a season from the catalogue or a similar title leaves the original updates unread.
      if (!acknowledge || (sequel && row.similarSeries?.some(item => item.series_id === sequel.series_id))) return;
      const group = groupById.get(row.series_id) || [row];
      const acknowledgedRows = sequel || visibleRows.find(item => groupById.get(item.series_id) === group) === row
        ? group.filter(item => item === row || item.sequels?.some(candidate => !sequel || candidate.series_id === sequel.series_id))
        : [row];
      for (const target of acknowledgedRows) {
        if (target.hasLocal === false) continue;
        const resumedOriginal = !sequel && target === row;
        const snapshot = { total: resumedOriginal ? row.total : 0, sequelIds: sequel ? [sequel.series_id] : (target.sequels || []).map(item => item.series_id) };
        const acknowledged = await window.electronAPI.acknowledgeWatchUpdates(target.series_id, snapshot);
        if (!acknowledged?.success) throw new Error(acknowledged?.error || '更新标记保存失败');
        if (version === openingRequest.current) setRows(current => current.map(item => {
          if (item.series_id !== target.series_id) return item;
          const unreadEpisodes = resumedOriginal ? 0 : item.unreadEpisodes || 0;
          const unreadSequelIds = (item.unreadSequelIds || []).filter(id => !snapshot.sequelIds.includes(id));
          return { ...item, hasUpdates: unreadEpisodes > 0 || unreadSequelIds.length > 0, unreadEpisodes, unreadSequelIds };
        }));
      }
    } catch (failure) { if (version === openingRequest.current) setError(failure.message || '打开失败，请重试'); }
    finally { if (version === openingRequest.current) { setOpening(''); openingRef.current = false; } }
  };

  const emptyTitle = hideLowSeasons
    ? filter === 'completed' ? '最高季里没有已看完的短剧' : '最高季里没有未看完的短剧'
    : filter === 'completed' ? '还没有已看完的短剧' : '没有未看完的短剧';

  return <section className="history-container" aria-labelledby="history-title">
    <div className="history-header">
      <div className={accountSignedIn ? 'account-history-title' : 'duplicate-page-title'}>
        <h1 id="history-title">{t("观看记录")}</h1>
        {accountSignedIn && <span>{t("共 {0} 条观看记录", [rows.length])}</span>}
        {mobile && <p>{t("继续上次的故事。记录仅保存在这台电脑。")}</p>}
      </div>
      <div className="history-tools">
        {accountSignedIn && <button className="btn btn-outline" type="button" disabled={refreshingAccount} onClick={refreshAccount}>
          <RefreshCw size={15} className={refreshingAccount ? 'spin' : ''} />{t("同步账号记录")}
        </button>}
        <select className="history-scope" value={scope} onChange={event => savePreferences({ ...preferences, scope: event.target.value })} disabled={checking || !!checkingRow || loading} aria-label={t("批量检测范围")} title={t("批量检测范围")}>
          <option value="all">{t("全部记录")}</option>
          <option value="latest">{t("仅最高季")}</option>
          <option value="unfinished">{t("仅未看完")}</option>
          <option value="skip-completed-low">{t("排除已看完低季")}</option>
        </select>
        <button className="btn btn-outline" onClick={checkUpdates} disabled={checking || !!checkingRow || loading || !rows.some(row => row.hasLocal !== false)}>
          <RefreshCw size={15} className={checking ? 'spin' : ''} />{t(checking ? '正在检查更新…' : '检查更新')}
        </button>
      </div>
    </div>
    {mobile && <p className="history-hint">{t("运行期间自动检查新集；同一部剧的多个季会共用一次续作搜索，已看完的低季每 24 小时检测一次。不同剧号的新一季标为“疑似续作”。批量检测范围只决定本次检查哪些记录，不会隐藏记录或清除已有红点。同组续作和疑似同剧汇总到组头，子级红点仅表示新增分集。可在设置中关闭检测或开启系统通知。")}</p>}
    <div className="history-filter-bar">
      <div className="history-filter" role="group" aria-label={t("观看进度筛选")}>
        {[
          ['all', '全部', listedRows.length],
          ['unfinished', '未看完', listedRows.length - completedCount],
          ['completed', '已看完', completedCount],
        ].map(([value, label, count]) => <button key={value} type="button" aria-pressed={filter === value} disabled={loading} onClick={() => setFilter(value)}>{t(label)} <RollingNumber value={count} /></button>)}
      </div>
      {accountSignedIn && <div className="account-history-tools">
        <label className="account-history-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t("搜索")} placeholder={t("输入剧名")} />
        </label>
        <div className="account-history-views" role="group" aria-label={t("显示方式")}>
          {['cards', 'list'].map(mode => <button type="button" key={mode} aria-pressed={view === mode} onClick={() => {
            setView(mode);
            try { window.localStorage.setItem(ACCOUNT_VIEW_KEY, mode); } catch {}
          }}>{t(mode === 'cards' ? '卡片' : '列表')}</button>)}
        </div>
        {view === 'cards' && <div className="account-history-views history-card-sizes" role="group" aria-label={t("卡片大小")}>
          {[['small', '小'], ['standard', '中'], ['large', '大']].map(([size, label]) => <button type="button" key={size} aria-pressed={cardSize === size} onClick={() => {
            setCardSize(size);
            try { window.localStorage.setItem(CARD_SIZE_KEY, size); } catch {}
          }}>{t(label)}</button>)}
        </div>}
      </div>}
      <label className="history-display-option" title={t("只调整当前列表；批量检测范围不变，也不会删除记录")}>
        <input type="checkbox" checked={hideLowSeasons} disabled={loading} onChange={event => savePreferences({ ...preferences, hideLowSeasons: event.target.checked })} />
        <span>{t("折叠同剧低季")}</span>
      </label>
    </div>
    {mobile && <p className="history-hint">{t("按最近观看时间排序，检查更新不改变观看顺序。同组提醒汇总到首个可见记录。")}{t("按当前最后一集的片尾进度判断；隐藏低季后，计数仅代表列表中的季，旧记录可能显示未看完。")}</p>}
    {error && <div className="history-error" role="alert"><span>{t(error)}</span><button className="btn btn-outline btn-sm" onClick={load}>{t("重新加载")}</button></div>}
    {notice && <div className={`dm-toast dm-toast-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'} onClick={() => showNotice('')}>{t(notice.text)}</div>}
    {accountSignedIn && syncError && <p className="history-hint" role="status">{t("账号进度同步未完成，将稍后重试。")}</p>}
    {checking && progress?.total > 0 && <p className="history-hint" role="status">{t("正在检查 ")}{t((progress.checked || 0) + (progress.failed || 0) + (progress.skipped || 0))} / {t(progress.total)}{t(progress.current ? `：${progress.current}` : '')}
    </p>}
    {t(loading ? <p role="status">{t("正在读取观看记录…")}</p> : !rows.length ? <div className="history-empty">
      <Clock size={30} /><h2>{t("还没有观看记录")}</h2>{mobile && <p>{t("真正开始播放后，短剧和进度会出现在这里。")}</p>}
      <button className="btn btn-primary" onClick={() => onNavigate?.('browse')}>{t("去发现短剧")}</button>
    </div> : !visibleRows.length ? <div className="history-empty" role="status">
      <Clock size={30} /><h2>{t(accountSignedIn && query.trim() ? '没有匹配的观看记录' : emptyTitle)}</h2>
      <button type="button" className="btn btn-outline" onClick={() => { setFilter('all'); setQuery(''); }}>{t("查看全部")}</button>
    </div> : <ul className="history-list" data-view={accountSignedIn ? view : 'list'} data-card-size={cardSize}>{visibleRows.map(row => {
      const cardView = !mobile && accountSignedIn && view === 'cards';
      const group = groupById.get(row.series_id);
      const groupHeadId = group[0].series_id;
      const isHead = visibleRows.find(item => groupById.get(item.series_id) === group) === row;
      const { sequels, similarSeries: similar, hasUnreadSequels } = suggestionsByGroup.get(group);
      const hasUpdates = row.unreadEpisodes > 0 || (isHead && hasUnreadSequels);
      const menuId = `history-actions-${row.series_id}`;
      const officialSeasons = !mobile && typeof window.electronAPI.findSeriesSeasons === 'function'
        && /^[1-9]\d{5,29}$/.test(row.series_id);
      const sequelLabel = /^[1-9]\d{5,29}$/.test(row.series_id) ? '官方续作' : '疑似续作';
      const seasonMenuId = `history-seasons-${row.series_id}`;
      const seasons = seasonPanel?.id === row.series_id ? seasonPanel : null;
      const updateErrors = [
        ["分集更新检查未完成：", row.lastEpisodeCheckError],
        ["续作检查未完成：", row.lastSequelCheckError],
      ].filter(([, message]) => message);
      if (!updateErrors.length && row.lastCheckError) updateErrors.push(["更新检查未完成：", row.lastCheckError]);
      return <li className={`history-row ${!isHead ? 'history-child' : ''}`} key={row.series_id}>
      <div className="history-main">
      <button className="history-resume" onClick={() => resume(row)} disabled={!active || !!opening || !!removing} aria-label={row.vid_index > 0
        ? t(`继续观看 ${row.series_title} 第${row.vid_index}集${hasUpdates ? `，有更新${row.unreadEpisodes ? `，新增${row.unreadEpisodes}集` : `，发现${sequelLabel}`}` : ''}`)
        : t('继续观看 {0}', [row.series_title])}>
        {row.cover ? <img className="history-cover" src={row.cover} alt="" loading="lazy" /> : <span className="history-cover history-cover-empty"><Play size={20} /></span>}
        <span className="history-copy">
          <span className="history-name">{hasUpdates && <span className="history-dot" role="img" aria-label={t("有更新")} />}{row.series_title}</span>
          <span className="history-progress">{row.vid_index > 0 && <>{t("看到第 ")}{t(row.vid_index)}{row.total > 0 && <>{t(" 集 / 共 ")}{t(row.total)}</>}{t(" 集 · ")}</>}{t(Math.floor((row.currentTime || 0) / 60))}:{t(String(Math.floor((row.currentTime || 0) % 60)).padStart(2, '0'))}</span>
          <span className="history-time">{mobile && t("最近观看 ")}{t(new Date(row.updatedAt).toLocaleString(getLanguage(), { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }))}{row.completed && <span className="history-completed">{t(" · 已看完")}</span>}</span>
          {t(decisions[row.series_id] === null ? <span className="history-group-state">{t("独立显示 · 手动")}</span> : group.length > 1 && group.some(item => Object.hasOwn(decisions, item.series_id)) && <span className="history-group-state">{t("手动分组")}</span>)}
          {row.unreadEpisodes > 0 && <span className="history-update">{t("新增 ")}{t(row.unreadEpisodes)}{t(" 集")}</span>}
        </span>
        {!cardView && <span className="history-action"><Play size={15} />{t(opening === row.series_id ? '打开中…' : '继续观看')}</span>}
      </button>
      <div className="history-row-actions">
        {group.length > 1 && isHead && <button className="btn btn-outline btn-sm history-fold" aria-expanded={!hideLowSeasons || !!expanded[groupHeadId]} onClick={() => { if (!hideLowSeasons) savePreferences({ ...preferences, hideLowSeasons: true }); setExpanded(value => ({ ...value, [groupHeadId]: hideLowSeasons ? !value[groupHeadId] : false })); }}>{t(!hideLowSeasons || expanded[groupHeadId] ? '折叠组' : '展开组')}</button>}
        {!mobile && <button type="button" className="btn btn-outline btn-sm history-more" popovertarget={menuId}
          aria-label={t("更多操作")} title={t("更多操作")}><span aria-hidden="true">…</span></button>}
        <div className={mobile ? 'history-maintenance-actions' : 'desktop-popover history-menu'} id={menuId}
          popover={mobile ? undefined : 'auto'} onClick={mobile ? undefined : event => {
            const button = event.target.closest('button');
            if (button && !button.disabled) event.currentTarget.hidePopover?.();
          }}>
        {group.length > 1 && <button className="btn btn-outline btn-sm" onClick={() => decide(row.series_id, null)}>{t("独立显示")}</button>}
        {Object.hasOwn(decisions, row.series_id) && <button className="btn btn-outline btn-sm" onClick={() => decide(row.series_id, undefined)}>{t("恢复自动分组")}</button>}
        {row.hasLocal !== false && <button type="button" className="btn btn-outline btn-sm history-check" disabled={checking || !!checkingRow || !!removing || !!opening} aria-label={t(`检测《${row.series_title}》的更新`)} title={t("只检测这一条观看记录")} onClick={() => checkRow(row)}>
          <RefreshCw size={14} className={checkingRow === row.series_id ? 'spin' : ''} />{t(checkingRow === row.series_id ? '检测中…' : '检测')}
        </button>}
        <button type="button" className="btn btn-outline btn-sm history-remove" disabled={!!removing || !!opening || !!checkingRow} aria-label={t(`移除观看记录《${row.series_title}》`)} title={t("仅移除观看记录，不删除视频文件")} onClick={() => remove(row)}>{t(removing === row.series_id ? '移除中…' : '移除')}</button>
        </div>
      </div>
      </div>
      {isHead && !!sequels.length && <Relations className={mobile ? "history-sequels" : "history-related"}>
        {mobile ? <span>{t(sequelLabel)}</span> : <summary>{t(sequelLabel)} · {sequels.length}</summary>}
        <div className="history-related-actions">{sequels.map(sequel => <button key={sequel.series_id} className="btn btn-outline btn-sm" disabled={!active || !!opening || !!removing} onClick={() => resume(sequel.origin, sequel)}>{sequel.series_title}</button>)}</div>
      </Relations>}
      {officialSeasons && <div className="history-related history-series">
        <button type="button" className="btn btn-outline btn-sm" popovertarget={seasonMenuId}
          disabled={!active || !!opening || !!removing} onClick={() => loadSeasons(row.series_id)}>{t('系列剧')}</button>
        <section className="desktop-popover history-seasons-menu" id={seasonMenuId} popover="auto" role="dialog" aria-label={t('系列剧')}>
          {seasons?.loading && <p role="status">{t('正在读取官方系列剧…')}</p>}
          {seasons?.error && <>
            <p role="status">{t('系列剧查询失败。')}</p>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => loadSeasons(row.series_id)}>{t('重新查找')}</button>
          </>}
          {seasons?.results && (seasons.results.some(season => season.series_id !== row.series_id)
            ? <div className="history-seasons-list">{seasons.results.map(season => {
              const selected = season.series_id === row.series_id;
              return <button type="button" key={season.series_id} className="btn btn-outline" aria-current={selected ? 'true' : undefined}
                disabled={!season.playable || !active || !!opening || !!removing} onClick={event => {
                  event.currentTarget.closest('.history-seasons-menu')?.hidePopover?.();
                  const existing = rows.find(item => item.series_id === season.series_id);
                  if (existing) void resume(existing);
                  else void resume(row, season, false);
                }}>
                {season.series_title}
                {!season.playable && <small>{t(season.upcoming ? '待上线' : '暂不可播放')}</small>}
              </button>;
            })}</div>
            : <p role="status">{t('暂未找到其他季。')}</p>)}
        </section>
      </div>}
      {isHead && !!similar.length && !officialSeasons && <Relations className={mobile ? "history-sequels" : "history-related"} title={t("名称相近，仅供核对；不会用于隐藏低季或批量归组")}>
        {mobile ? <span>{t("疑似同剧（仅提示）")}</span> : <summary>{t("疑似同剧（仅提示）")} · {similar.length}</summary>}
        <div className="history-related-actions">{similar.map(candidate => <button key={candidate.series_id} className="btn btn-outline btn-sm" disabled={!active || !!opening || !!removing} onClick={() => resume(candidate.origin, candidate)}>{candidate.series_title}</button>)}
        {similar.filter(candidate => rows.some(item => item.series_id === candidate.series_id)).map(candidate => <button key={`group:${candidate.series_id}`} className="btn btn-outline btn-sm" onClick={() => decide(candidate.series_id, row.series_id)}>{t("确认《")}{candidate.series_title}{t("》为同剧")}</button>)}</div>
      </Relations>}
      {!!updateErrors.length && <Relations className={mobile ? undefined : 'history-related history-check-summary'}>
        {!mobile && <summary><AlertCircle size={14} />{t("检查未完成，可稍后重试")}</summary>}
        {updateErrors.map(([label, message]) => <p className="history-check-error" key={label}>{t(label)}{t(message)}</p>)}
      </Relations>}
      {cardView && <button type="button" className="history-action history-card-cta" disabled={!active || !!opening || !!removing} onClick={() => resume(row)}>
        <Play size={15} />{t(opening === row.series_id ? '打开中…' : '继续观看')}
      </button>}
    </li>; })}</ul>)}
  </section>;
}
