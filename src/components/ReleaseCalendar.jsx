import { t, useLanguage } from '../i18n';
import React, { useEffect, useMemo, useState } from 'react';
import { publicDateKey, readLocalLibrary, removeLocalSeries, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';
import { EMPTY_ACCOUNT_LIST } from './useAccountLibrary';
import './ReleaseCalendar.css';

const VIEWS = [
  ['recent', '全部已浏览'], ['favorites', '收藏'], ['like', '我的点赞'],
  ['reservation', '我的预约'], ['upcoming', '预约新剧'],
];
const DISPLAY_KEY = 'hongguo:release-calendar-display';
const DISPLAY_MODES = [['cards', '卡片'], ['list', '列表']];

export default function ReleaseCalendar({ onPlay, opening = '', active = true, accountLibrary }) {
  useLanguage();
  const [library, setLibrary] = useState(readLocalLibrary);
  const [chosenView, setChosenView] = useState('recent');
  const [reservationOnline, setReservationOnline] = useState(true);
  const [display, setDisplay] = useState(() => {
    try { return window.localStorage.getItem(DISPLAY_KEY) === 'list' ? 'list' : 'cards'; }
    catch { return 'cards'; }
  });
  const [chosenMonth, setChosenMonth] = useState('');
  const [catalogCovers, setCatalogCovers] = useState(() => new Map());
  const [feedback, setFeedback] = useState('');
  const signedIn = accountLibrary?.signedIn === true;
  const ready = accountLibrary?.ready !== false;
  const sessionId = accountLibrary?.sessionId;
  const watch = accountLibrary?.watch;
  const view = signedIn || chosenView === 'favorites' ? chosenView : 'recent';
  const favoritesOnly = view === 'favorites';
  const localView = view === 'recent' || favoritesOnly;
  const kind = localView ? 'favorite' : view;
  const cloud = accountLibrary?.lists[kind] || EMPTY_ACCOUNT_LIST;
  const reservations = accountLibrary?.lists.reservation || EMPTY_ACCOUNT_LIST;
  const releasedReservations = reservations.items.filter(item => item.online);
  const pendingReservations = reservations.items.filter(item => !item.online);
  const pending = new Set(pendingReservations.map(item => item.reservationId));

  useEffect(() => subscribeLocalLibrary(setLibrary), []);
  useEffect(() => {
    setFeedback('');
    if (sessionId && active && watch) {
      const stop = watch(kind);
      const stopReservations = kind === 'upcoming' ? watch('reservation') : undefined;
      return () => { stop(); stopReservations?.(); };
    }
  }, [active, kind, sessionId, watch]);
  useEffect(() => {
    if (!library.items.some(item => !item.cover) || !window.electronAPI?.getSeriesList) return;
    let cancelled = false;
    window.electronAPI.getSeriesList().then(items => {
      if (!cancelled && Array.isArray(items)) setCatalogCovers(new Map(items.map(item => [String(item.series_id), item.cover || ''])));
    }).catch(() => {}); // Missing local metadata leaves the poster placeholder available.
    return () => { cancelled = true; };
  }, []);
  const rows = useMemo(() => library.items.map(item => ({ ...item, cover: item.cover || catalogCovers.get(item.id) || '', date: publicDateKey(item.published_at) })), [library.items, catalogCovers]);
  const localById = useMemo(() => new Map(rows.map(item => [item.id, item])), [rows]);
  const dated = rows.filter(item => item.date).sort((a, b) => b.date.localeCompare(a.date));
  const filtered = rows.filter(item => !favoritesOnly || item.favorite);
  const months = [...new Set(filtered.filter(item => item.date).map(item => item.date.slice(0, 7)))].sort().reverse();
  const month = months.includes(chosenMonth) ? chosenMonth : months[0] || '';
  const monthItems = filtered.filter(item => item.date.startsWith(`${month}-`)).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN'));
  const days = [...new Set(monthItems.map(item => item.date))];
  const undated = filtered.filter(item => !item.date);
  const favoritesCount = rows.filter(item => item.favorite).length;
  const cloudIds = new Set(cloud.items.map(item => item.id));

  const change = async (type, item, value, move = false) => {
    setFeedback('');
    const result = await accountLibrary.change({ kind: type, item, value, move });
    if (!result.success && !result.cancelled) setFeedback(result.error);
  };

  const renderRow = (item, { key = item.id, label, info, canPlay = true, actions }) => {
    const title = item.title || t('剧集信息暂未加载');
    return <li key={key} className="release-row">
      <div className="release-poster" aria-hidden="true"><span>{t("暂无海报")}</span>{item.cover && <img key={item.cover} src={item.cover} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}</div>
      <div className="release-title">
        <strong title={title}>{title}</strong>
        {(label || info) && <span>{label && <small className="release-source">{t(label)}</small>}{info}</span>}
      </div>
      <div className="release-row-actions">
        {actions}
        {canPlay && item.id && <button type="button" className="btn btn-sm" disabled={!onPlay || !!opening || !active} aria-label={t(`播放《${title}》`)} onClick={() => onPlay?.({ seriesId: item.id, episodeId: item.episodeId })}>{t(opening === item.id ? '打开中…' : '播放')}</button>}
      </div>
    </li>;
  };

  const localRow = item => {
    const useCloud = signedIn && !item.favorite;
    const saved = useCloud ? cloudIds.has(item.id) : item.favorite;
    return renderRow(item, {
      label: item.favorite ? '本机' : '',
      info: t(item.date ? `首次公开 ${item.date}` : '暂无首次公开时间'),
      actions: <>
        <button type="button" className="btn btn-sm btn-outline" aria-pressed={saved}
          disabled={!ready || (signedIn && (cloud.busy || (useCloud && !cloud.loaded)))}
          onClick={() => useCloud ? change('favorite', item, !saved) : setLibrary(saveLocalSeries({ ...item, favorite: !saved }))}>
          {t(useCloud ? (saved ? '已收藏到云端' : '收藏到云端') : (saved ? '取消本机收藏' : '收藏到本机'))}
        </button>
        {signedIn && item.favorite && <button type="button" className="btn btn-sm btn-outline" disabled={cloud.busy} onClick={() => change('favorite', item, true, true)}>{t('移到账号收藏')}</button>}
        <button type="button" className="btn btn-sm btn-outline" aria-label={t(`移除《${item.title}》`)} disabled={signedIn && cloud.busy}
          title={t("仅移除本机收藏与日历记录，不删除视频文件")} onClick={() => setLibrary(removeLocalSeries(item.id))}>{t("移除")}</button>
      </>,
    });
  };

  const cloudRow = item => {
    const completedReservation = kind === 'reservation' && item.online;
    const upcoming = kind === 'upcoming';
    const isReservation = kind === 'reservation' || upcoming;
    const reserved = kind === 'reservation' || pending.has(item.reservationId);
    const local = localById.get(item.id);
    const action = completedReservation ? '移除预约记录'
      : isReservation ? (reserved ? '取消预约' : '预约')
        : kind === 'like' ? '取消本集点赞' : '取消云端收藏';
    const actionId = item.reservationId || (completedReservation ? item.id : '');
    return renderRow({ ...item, title: item.title || local?.title, cover: item.cover || local?.cover }, {
      key: item.reservationId || item.episodeId || item.id,
      label: upcoming ? '' : '云端',
      info: isReservation ? t(completedReservation ? '已上线' : item.scheduled || '待上线')
        : kind === 'like' && item.episodeIndex > 0 ? t(`第 ${item.episodeIndex} 集`) : null,
      canPlay: !isReservation || completedReservation,
      actions: <button type="button" className="btn btn-sm btn-outline"
        disabled={isReservation ? !actionId || !reservations.loaded || reservations.busy : cloud.busy}
        onClick={() => change(isReservation ? 'reservation' : kind, item, isReservation && !reserved)}>{t(action)}</button>,
    });
  };

  const showCloudList = signedIn && (favoritesOnly || !localView);
  const showLocalList = localView && (!favoritesOnly || !signedIn || favoritesCount > 0);
  const cloudError = cloud.error || (view === 'upcoming' ? reservations.error : '');
  const cloudItems = view === 'reservation' ? (reservationOnline ? releasedReservations : pendingReservations) : cloud.items;
  const cloudEmpty = view === 'reservation' ? (reservationOnline ? '暂无已上线的预约' : '暂无待上线的预约')
    : view === 'upcoming' ? '暂无可预约的新剧' : '暂无云端记录';

  return <section className="release-calendar" data-view={display}>
    <header className="duplicate-page-title"><h2>{t("收藏与上新")}</h2></header>
    {localView && library.error && <div className="release-error" role="alert"><p>{t(library.error)}</p><button type="button" className="btn btn-sm" onClick={() => setLibrary(readLocalLibrary())}>{t("重新读取")}</button></div>}
    <div className="release-toolbar">
      <div className="release-filter" role="group" aria-label={t("日历范围")}>
        {VIEWS.slice(0, signedIn ? VIEWS.length : 2).map(([id, label]) => <button type="button" key={id}
          aria-pressed={view === id} onClick={() => setChosenView(id)}>{t(!signedIn && id === 'favorites' ? '本机收藏' : label)}{!signedIn && id === 'favorites' && ` ${favoritesCount}`}</button>)}
      </div>
      <div className="release-toolbar-actions">
        {localView && months.length > 0 && <label className="release-month">{t("月份")}<select value={month} onChange={event => setChosenMonth(event.target.value)}>{months.map(value => <option key={value} value={value}>{t(value.slice(0, 4))}{t(" 年 ")}{t(Number(value.slice(5)))}{t(" 月")}</option>)}</select></label>}
        <div className="account-history-views" role="group" aria-label={t("显示方式")}>
          {DISPLAY_MODES.map(([mode, label]) => <button type="button" key={mode} aria-pressed={display === mode} onClick={() => {
            setDisplay(mode);
            try { window.localStorage.setItem(DISPLAY_KEY, mode); } catch {}
          }}>{t(label)}</button>)}
        </div>
        {signedIn && <button type="button" className="btn btn-sm btn-outline" disabled={cloud.busy || (view === 'upcoming' && reservations.busy)} onClick={() => {
          void accountLibrary.refresh(kind);
          if (view === 'upcoming') void accountLibrary.refresh('reservation');
        }}>{t('刷新云端')}</button>}
      </div>
      {view === 'recent' && dated.length > 0 && <small className="release-coverage">{t("北京时间 · 已浏览剧集")}</small>}
    </div>
    {(feedback || cloudError || accountLibrary?.statusError) && <p className="release-error" role="alert">{t(feedback || cloudError || accountLibrary.statusError)}</p>}
    {showCloudList && <section className="release-undated">
      {favoritesOnly && <h3>{t('云端收藏')}</h3>}
      {view === 'reservation' && <div className="account-history-views release-reservation-views" role="group" aria-label={t('预约状态')}>
        {[[true, '已上线', releasedReservations.length], [false, '待上线', pendingReservations.length]].map(([online, label, count]) =>
          <button type="button" key={label} aria-pressed={reservationOnline === online} onClick={() => setReservationOnline(online)}>
            {t(label)}{cloud.loaded && <span className="release-reservation-count"> · {t(count)}</span>}
          </button>)}
      </div>}
      {!cloud.loaded && !cloud.error && <p role="status">{t('正在同步云端记录…')}</p>}
      {cloud.loaded && !cloudItems.length && <p>{t(cloudEmpty)}</p>}
      {!!cloudItems.length && <ul className="release-items">{cloudItems.map(cloudRow)}</ul>}
    </section>}
    {showLocalList && <>
      {signedIn && favoritesOnly && <h3 className="release-library-heading">{t('本机收藏')}</h3>}
      {!library.error && !filtered.length && <div className="release-empty"><h3>{t(favoritesOnly ? '还没有本机收藏' : '还没有可展示的剧集')}</h3><p>{t(favoritesOnly ? '在剧集详情点「收藏到本机」。' : '打开剧集的「公开剧评」可记录首次公开日期。')}</p></div>}
      {days.map(day => <section className="release-day" key={day} aria-label={t(`${day} 首次公开`)}><h3><span>{t(Number(day.slice(8)))}</span><small>{t(Number(day.slice(5, 7)))}{t(" 月")}</small></h3><ul className="release-items">{monthItems.filter(item => item.date === day).map(localRow)}</ul></section>)}
      {undated.length > 0 && <section className="release-undated"><h3>{t("公开日期待提供 ")}<span>{t(undated.length)}{t(" 部")}</span></h3><ul className="release-items">{undated.map(localRow)}</ul></section>}
    </>}
  </section>;
}
