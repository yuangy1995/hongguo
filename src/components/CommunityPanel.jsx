import { t, useLanguage, getLanguage } from '../i18n';
import React, { useEffect, useId, useState } from 'react';
import { readLocalLibrary, saveLocalSeries, subscribeLocalLibrary, publicDateKey } from '../localLibrary';
import './CommunityPanel.css';

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString(getLanguage()) : '暂无数据';
const reviewDate = value => {
  if (!value) return '';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(getLanguage(), { timeZone: 'Asia/Shanghai' });
};

export default function CommunityPanel({ seriesId, episodeId, title, cover, accountLibrary, active = true }) {
  useLanguage();
  const id = String(seriesId || '');
  const panelId = useId();
  const [openedSeries, setOpenedSeries] = useState('');
  const opened = !!id && openedSeries === id;
  const [scope, setScope] = useState('series');
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const showToast = (msg, type = 'success') => setToast(msg ? { text: msg, type, seq: Date.now() } : null);
  useEffect(() => {
    if (!toast || typeof setTimeout !== 'function') return undefined;
    const timer = setTimeout(() => setToast(null), toast.type === 'error' ? 4200 : 2800);
    return () => clearTimeout(timer);
  }, [toast]);
  const [library, setLibrary] = useState(readLocalLibrary);
  const requestKey = `${id}:${episodeId || ''}:${retry}`;
  const detail = result?.key === requestKey ? result.data : null;
  const favorite = library.items.some(item => item.id === id && item.favorite);
  const currentEpisodeId = String(episodeId || '');
  const signedIn = accountLibrary?.signedIn === true;
  const ready = accountLibrary?.ready !== false;
  const cloudFavorites = accountLibrary?.lists.favorite;
  const cloudLikes = accountLibrary?.lists.like;
  const cloudFavorite = cloudFavorites?.items.some(item => item.id === id) || false;
  const episodeLiked = cloudLikes?.items.some(item => item.id === id && item.episodeId === currentEpisodeId) || false;
  const watch = accountLibrary?.watch;
  const sessionId = accountLibrary?.sessionId;
  const hasSeries = !!id;

  useEffect(() => subscribeLocalLibrary(setLibrary), []);
  useEffect(() => {
    if (!watch || !sessionId || !active || !hasSeries) return;
    const stopFavorites = watch('favorite');
    const stopLikes = watch('like');
    return () => { stopFavorites(); stopLikes(); };
  }, [watch, sessionId, active, hasSeries]);
  useEffect(() => { setScope('series'); }, [id]);
  useEffect(() => {
    if (!opened) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        if (!window.electronAPI?.getPublicDetails) throw new Error('当前环境暂不支持读取公开剧评');
        const data = await window.electronAPI.getPublicDetails(id, episodeId || undefined);
        if (!data?.success) throw new Error(data?.error || '公开剧评暂时无法加载');
        if (cancelled) return;
        setResult({ key: requestKey, data });
        setLibrary(saveLocalSeries({ id, title, cover, published_at: data.published_at }));
      } catch (failure) {
        if (!cancelled) setError(failure.message || '公开剧评暂时无法加载');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [opened, id, episodeId, title, cover, requestKey]);

  if (!id) return null;
  const episodeScope = scope === 'episode' && !!episodeId;
  const reviews = episodeScope ? detail?.episode_reviews : detail?.reviews;
  const items = Array.isArray(reviews?.items) ? reviews.items.filter(item => item && typeof item.content === 'string') : [];
  const publishedDate = publicDateKey(detail?.published_at);
  const emptyText = episodeScope
    ? reviews ? '本次未返回公开评论。' : '当前来源暂未提供单集评论。'
    : reviews ? '本次未返回公开评论。' : '当前来源暂未提供整剧剧评。';
  const partialText = reviews?.total != null && reviews.total > items.length
    ? `本次展示 ${items.length} 条公开评论，公开总数 ${count(reviews.total)}；更多评论可在红果 App 查看。`
    : `本次展示 ${items.length} 条公开评论；更多评论可在红果 App 查看。`;

  const updateCloud = async (kind, value, move = false) => {
    const result = await accountLibrary.change({ kind, value, move, item: { id, title, cover, episodeId: currentEpisodeId } });
    if (!result.cancelled && !result.success) showToast(result.error, 'error');
  };

  return <section className="community-panel" aria-label={t("剧评与收藏")}>
    <div className="community-heading">
      <div className="community-heading-top">
        <div><h3>{t("剧评与收藏")}</h3></div>
        <button type="button" className="btn btn-outline community-share-btn" onClick={async () => {
          try {
            await navigator.clipboard.writeText(`https://hongguoduanju.com/detail?series_id=${encodeURIComponent(id)}`);
            showToast('官方分享链接已复制', 'success');
          } catch { showToast('复制失败，请重试', 'error'); }
        }}>{t("复制分享链接")}</button>
      </div>
      <div className="community-actions">
        {signedIn ? <>
          <button type="button" className={`btn ${cloudFavorite ? 'community-favorited' : 'btn-outline'}`}
            aria-pressed={cloudFavorite} disabled={!title || !cloudFavorites?.loaded || cloudFavorites.busy}
            onClick={() => updateCloud('favorite', !cloudFavorite)}>{t(cloudFavorite ? '已收藏到云端' : '收藏到云端')}</button>
          {favorite && <><span className="community-local-label">{t('本机收藏')}</span>
            <button type="button" className="btn btn-outline" disabled={cloudFavorites?.busy}
              onClick={() => updateCloud('favorite', true, true)}>{t('移到账号收藏')}</button></>}
        </> : <button type="button" className={`btn ${favorite ? 'community-favorited' : 'btn-outline'}`} aria-pressed={favorite} disabled={!ready || !title} onClick={() => {
          const next = !favorite;
          const updated = saveLocalSeries({ id, title, cover, favorite: next });
          setLibrary(updated);
          if (!updated.error) showToast(next ? '已收藏到本机' : '已取消本机收藏', next ? 'success' : 'info');
        }}>{t(favorite ? '已收藏到本机' : '收藏到本机')}</button>}
        <button type="button" className={`btn community-episode-like ${episodeLiked ? 'community-favorited' : 'btn-outline'}`}
          aria-pressed={episodeLiked} disabled={!signedIn || !currentEpisodeId || !cloudLikes?.loaded || cloudLikes.busy}
          onClick={() => updateCloud('like', !episodeLiked)}>
          <span className="community-heart" aria-hidden="true">{episodeLiked ? '♥' : '♡'}</span>
          {t(signedIn ? (episodeLiked ? '取消本集点赞' : '点赞本集') : '登录后可点赞')}
        </button>
        <button type="button" className="btn btn-outline" aria-expanded={opened && !episodeScope} aria-controls={panelId} onClick={() => {
          if (opened && !episodeScope) setOpenedSeries('');
          else { setScope('series'); setOpenedSeries(id); }
        }}>{t(opened && !episodeScope ? '收起剧评' : '查看公开剧评')}</button>
        {episodeId && <button type="button" className="btn btn-outline community-episode-button" aria-expanded={opened && episodeScope} aria-controls={panelId} onClick={() => {
          if (opened && episodeScope) setOpenedSeries('');
          else { setScope('episode'); setOpenedSeries(id); }
        }}>{t(opened && episodeScope ? '收起当前集评论' : '当前集评论')}</button>}
      </div>
    </div>
    {library.error && <p className="community-error" role="alert">{t(library.error)}</p>}
    {accountLibrary?.statusError && <p className="community-error" role="alert">{t(accountLibrary.statusError)}</p>}
    {signedIn && (cloudFavorites?.error || cloudLikes?.error) && <div className="community-error" role="alert">
      <p>{t(cloudFavorites?.error || cloudLikes?.error)}</p><button type="button" className="btn btn-sm" onClick={() => {
        if (cloudFavorites?.error) void accountLibrary.refresh('favorite');
        if (cloudLikes?.error) void accountLibrary.refresh('like');
      }}>{t('刷新云端')}</button>
    </div>}
    {toast && <div className={`dm-toast dm-toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} onClick={() => showToast('')}>{t(toast.text)}</div>}
    {opened && <div id={panelId} className="community-content" aria-busy={loading}>
      {loading && <p className="community-status" role="status">{t("正在读取公开评分与评论…")}</p>}
      {!loading && error && <div className="community-error" role="alert"><p>{t(error)}</p><button type="button" className="btn btn-sm" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></div>}
      {!loading && !error && detail && <>
        <dl className="community-metrics">
          <div><dt>{t("公开评分")}</dt><dd>{t(count(detail.rating))}</dd></div>
          <div><dt>{t("评分人数")}</dt><dd>{t(count(detail.rating_count))}</dd></div>
          <div><dt>{t("公开点赞")}</dt><dd>{t(count(detail.like_count))}</dd></div>
          <div><dt>{t("公开收藏")}</dt><dd>{t(count(detail.favorite_count))}</dd></div>
        </dl>
        {publishedDate && <p className="community-date">{t("首次公开：")}{t(publishedDate)}{t("（北京时间）")}</p>}
        <div className="community-review-heading">
          <div className="community-switch" role="group" aria-label={t("评论范围")}>
            <button type="button" aria-pressed={!episodeScope} onClick={() => setScope('series')}>{t("整剧剧评")}</button>
            <button type="button" aria-pressed={episodeScope} disabled={!episodeId} onClick={() => setScope('episode')}>{t("当前集评论")}</button>
          </div>
          <span>{t(reviews?.total != null ? `公开总数 ${count(reviews.total)} · ` : '')}{t("本次返回 ")}{t(items.length)}{t(" 条")}</span>
        </div>
        {items.length ? <ul className="community-reviews">{items.map((review, index) => <li key={`${review.created_at || ''}:${index}`}>
          <div className="community-review-meta"><strong>{(typeof review.author === 'string' && review.author.trim() ? review.author : t('公开用户'))}</strong><span>{t(reviewDate(review.created_at))}</span></div>
          <p>{review.content}</p>
          <div className="community-review-foot">{review.rating != null && <span>{t("评分 ")}{t(count(review.rating))}</span>}{review.likes != null && <span>{t("公开点赞 ")}{t(count(review.likes))}</span>}</div>
        </li>)}</ul> : <p className="community-status">{t(emptyText)}</p>}
        {items.length > 0 && <p className="community-note">{t(partialText)}</p>}
      </>}
    </div>}
  </section>;
}
