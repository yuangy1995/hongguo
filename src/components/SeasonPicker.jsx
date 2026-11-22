import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { ChevronDown } from './icons';

function mergeSeasons(earlier, latest) {
  return [...new Map([...earlier, ...latest].map(item => [item.season, item])).values()]
    .sort((a, b) => a.season - b.season);
}

export default function SeasonPicker({ seriesId, active, seriesList, onSwitch, accountLibrary }) {
  const lookup = window.electronAPI.findSeriesSeasons;
  const popup = useRef(null);
  const cache = useRef(null);
  const openingRequest = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const [opening, setOpening] = useState('');
  const [openError, setOpenError] = useState('');
  const hongguo = /^[1-9]\d{5,29}$/.test(String(seriesId));
  const pendingReservations = accountLibrary?.lists?.pendingReservations;
  const reservations = pendingReservations?.loaded ? pendingReservations : accountLibrary?.lists?.reservation;
  const sessionId = accountLibrary?.sessionId;
  const watch = accountLibrary?.watch;
  const current = snapshot?.seriesId === seriesId ? snapshot : null;
  const supportsReservations = current?.results.some(season => season.upcoming && season.reservationId) === true;

  useEffect(() => {
    if (active && sessionId && supportsReservations) return watch?.('pendingReservations');
  }, [active, sessionId, supportsReservations, watch]);

  useLayoutEffect(() => {
    popup.current?.hidePopover?.();
    setOpening('');
    setOpenError('');
    return () => { openingRequest.current = null; };
  }, [seriesId, active]);

  useEffect(() => {
    if (!active || !seriesId || !lookup) return;
    const cached = cache.current;
    const saved = cached && Date.now() - cached.time < 10 * 60 * 1000
      && (cached.seriesId === seriesId || cached.results.some(item => item.series_id === seriesId)) ? cached : null;
    if (saved?.attempt === attempt && !saved.partial) {
      setSnapshot({ ...saved, seriesId });
      return;
    }

    const known = saved?.results || [];
    let cancelled = false;
    setSnapshot({ seriesId, results: known, pending: true, official: hongguo });
    const timeout = setTimeout(() => {
      cancelled = true;
      setSnapshot(current => ({ ...current, pending: false, partial: true }));
    }, 25000);
    (async () => {
      try {
        if (!hongguo) {
          const local = await lookup(seriesId, { localOnly: true });
          if (cancelled) return;
          setSnapshot({ ...local, seriesId, results: local.unsupported ? [] : mergeSeasons(known, local.results), pending: !local.unsupported });
          if (local.unsupported) return;
        }
        const result = await lookup(seriesId);
        if (cancelled) return;
        const results = result.partial ? (hongguo ? known : mergeSeasons(known, result.results)) : result.results;
        const complete = { ...result, results, seriesId, attempt, time: Date.now() };
        if (!result.unsupported) cache.current = complete;
        setSnapshot(complete);
      } catch {
        if (!cancelled) setSnapshot(current => ({ ...current, pending: false, partial: true }));
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [active, seriesId, attempt, lookup, hongguo]);

  const select = async season => {
    if (openingRequest.current || season.series_id === seriesId || season.playable === false) return;
    const request = {};
    openingRequest.current = request;
    setOpening(season.series_id);
    setOpenError('');
    try {
      const needsRegistration = !seriesList.some(item => String(item.series_id) === season.series_id);
      if (needsRegistration) {
        const result = await window.electronAPI.searchResolve(season.series_id);
        if (openingRequest.current !== request) return;
        if (!result?.success || !result.data?.episodes?.length) throw new Error();
      }
      popup.current?.hidePopover?.();
      onSwitch(season.series_id, needsRegistration);
    } catch {
      if (openingRequest.current === request) setOpenError('无法打开这一季，请稍后重试。');
    } finally {
      if (openingRequest.current === request) {
        openingRequest.current = null;
        setOpening('');
      }
    }
  };

  const changeReservation = async (season, value) => {
    if (!accountLibrary?.signedIn || openingRequest.current) return;
    const request = {};
    openingRequest.current = request;
    setOpening(season.series_id);
    setOpenError('');
    try {
      const result = await accountLibrary.change({
        kind: 'reservation', value,
        item: { id: season.series_id, title: season.series_title, reservationId: season.reservationId, reservationSeries: true },
      });
      if (openingRequest.current === request && !result.success && !result.cancelled) setOpenError(result.error);
    } finally {
      if (openingRequest.current === request) {
        openingRequest.current = null;
        setOpening('');
      }
    }
  };

  if (!active || !seriesId || !lookup) return null;
  const currentSeason = current?.results.find(item => item.series_id === seriesId);
  if (current?.unsupported || (!hongguo && !currentSeason)) return null;

  return <>
    <button type="button" className="btn btn-outline btn-sm player-season-trigger" popovertarget="player-seasons"
      title={t(hongguo ? "系列剧" : "切换季数")} data-player-menu>
      {currentSeason?.season ? t("第 {0} 季", [currentSeason.season]) : t("系列剧")}<ChevronDown size={14} />
    </button>
    <section ref={popup} id="player-seasons" className="desktop-popover player-season-menu" popover="auto" role="dialog" aria-label={t(hongguo ? "系列剧" : "切换季数")}>
      <div className="player-season-list">
        {(current?.results || []).map(season => {
          const selected = season.series_id === seriesId;
          const label = season.season ? <strong>{t("第 {0} 季", [season.season])}</strong> : <span />;
          if (season.playable === false) {
            const canReserve = season.upcoming && !!season.reservationId && !selected;
            const reserved = canReserve && accountLibrary?.signedIn && reservations?.items.some(item => !item.online && (item.id === season.series_id
              || item.reservationId === season.reservationId || item.reservationId === season.series_id));
            const action = !accountLibrary?.signedIn ? '登录后可预约' : opening === season.series_id ? '处理中…' : reserved ? '取消预约' : '预约';
            return <div key={season.series_id} className="player-season-unavailable" aria-current={selected ? 'true' : undefined}>
              <div className="player-season-copy">
                {label}<span className="player-season-name">{season.series_title}
                  <small>{t(season.upcoming ? "待上线" : "暂不可播放")}{reserved && <> · <span className="player-season-reserved">{t("已预约")}</span></>}</small>
                </span>
              </div>
              {canReserve && <button type="button" className={`btn btn-sm player-season-reservation ${reserved ? 'btn-outline' : 'btn-primary'}`}
                disabled={!accountLibrary?.signedIn || !!opening} onClick={() => changeReservation(season, !reserved)}>{t(action)}</button>}
            </div>;
          }
          return <button type="button" key={season.series_id} className="btn btn-outline" aria-current={selected ? 'true' : undefined}
            disabled={selected || !!opening} onClick={() => select(season)}>
            {label}<span className="player-season-name">{season.series_title}</span>
            {opening === season.series_id && <span role="status">{t("打开中…")}</span>}
          </button>;
        })}
      </div>
      <div className="player-season-feedback">
        {(!current || current.pending) && <p role="status">{t(hongguo ? "正在读取官方系列剧…" : "正在查找各季…")}</p>}
        {current?.partial && <p role="status">{t(current.error || (hongguo ? "官方系列剧暂时无法读取，请稍后重试。" : "部分查询未完成，可稍后重试。"))}</p>}
        {current && !current.pending && !current.partial && !current.results.some(item => item.series_id !== seriesId) && <p role="status">{t("暂未找到其他季。")}</p>}
        {supportsReservations && accountLibrary?.signedIn && pendingReservations?.error && !reservations?.loaded &&
          <p role="status">{t("预约状态暂时无法读取。")} <button type="button" className="btn btn-outline btn-sm"
            onClick={() => accountLibrary.refresh('pendingReservations')}>{t("重新读取")}</button></p>}
        {openError && <p role="alert">{t(openError)}</p>}
        {current && !current.pending && (current.partial || current.results.length <= 1) &&
          <button type="button" className="btn btn-outline btn-sm" disabled={!!opening} onClick={() => setAttempt(value => value + 1)}>{t("重新查找")}</button>}
      </div>
    </section>
  </>;
}
