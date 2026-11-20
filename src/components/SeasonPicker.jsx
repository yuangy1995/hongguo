import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { ChevronDown } from './icons';

function mergeSeasons(earlier, latest) {
  return [...new Map([...earlier, ...latest].map(item => [item.season, item])).values()]
    .sort((a, b) => a.season - b.season);
}

export default function SeasonPicker({ seriesId, active, seriesList, onSwitch }) {
  const lookup = window.electronAPI.findSeriesSeasons;
  const popup = useRef(null);
  const cache = useRef(null);
  const openingRequest = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const [opening, setOpening] = useState('');
  const [openError, setOpenError] = useState('');

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
      && cached.results.some(item => item.series_id === seriesId) ? cached : null;
    if (saved?.attempt === attempt && !saved.partial) {
      setSnapshot({ ...saved, seriesId });
      return;
    }

    const known = saved?.results || [];
    let cancelled = false;
    setSnapshot({ seriesId, results: known, pending: true });
    const timeout = setTimeout(() => {
      cancelled = true;
      setSnapshot(current => ({ ...current, pending: false, partial: true }));
    }, 25000);
    (async () => {
      try {
        const local = await lookup(seriesId, { localOnly: true });
        if (cancelled) return;
        setSnapshot({ ...local, seriesId, results: local.unsupported ? [] : mergeSeasons(known, local.results), pending: !local.unsupported });
        if (local.unsupported) return;
        const result = await lookup(seriesId);
        if (cancelled) return;
        const results = result.partial ? mergeSeasons(known, result.results) : result.results;
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
  }, [active, seriesId, attempt, lookup]);

  const select = async season => {
    if (openingRequest.current || season.series_id === seriesId) return;
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

  if (!active || !seriesId || !lookup) return null;
  const current = snapshot?.seriesId === seriesId ? snapshot : null;
  const currentSeason = current?.results.find(item => item.series_id === seriesId);
  if (!currentSeason) return null;

  return <>
    <button type="button" className="btn btn-outline btn-sm player-season-trigger" popovertarget="player-seasons"
      title={t("切换季数")} data-player-menu>
      {t("第 {0} 季", [currentSeason.season])}<ChevronDown size={14} />
    </button>
    <section ref={popup} id="player-seasons" className="desktop-popover player-season-menu" popover="auto" role="dialog" aria-label={t("切换季数")}>
      <div className="player-season-list">
        {(current?.results || []).map(season => {
          const selected = season.series_id === seriesId;
          return <button type="button" key={season.series_id} className="btn btn-outline" aria-current={selected ? 'true' : undefined}
            disabled={selected || !!opening} onClick={() => select(season)}>
            <strong>{t("第 {0} 季", [season.season])}</strong><span>{season.series_title}</span>
            {opening === season.series_id && <span role="status">{t("打开中…")}</span>}
          </button>;
        })}
      </div>
      <div className="player-season-feedback">
        {current.pending && <p role="status">{t("正在查找各季…")}</p>}
        {current.partial && <p role="status">{t("部分查询未完成，可稍后重试。")}</p>}
        {!current.pending && !current.partial && current.results.length === 1 && <p role="status">{t("暂未找到其他季。")}</p>}
        {openError && <p role="alert">{t(openError)}</p>}
        {!current.pending && (current.partial || current.results.length <= 1) &&
          <button type="button" className="btn btn-outline btn-sm" disabled={!!opening} onClick={() => setAttempt(value => value + 1)}>{t("重新查找")}</button>}
      </div>
    </section>
  </>;
}
