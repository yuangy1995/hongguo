const { requestJson, signedAccountRequest } = require('./app-source');
const { getPlaybackDevice } = require('./playback-device');

const SERIES_SEASONS_PATH = '/reading/bookapi/plan/v';
const validId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
const exactId = value => typeof value === 'string' ? value
  : Number.isSafeInteger(value) ? String(value) : '';
const text = value => typeof value === 'string' ? value.trim() : '';
const flag = value => [true, 1, '1', 'true'].includes(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function parseSeriesSeasons(payload) {
  // The season endpoint can return this envelope for titles without series information.
  if (payload?.code === 101116 && payload.message === 'SERVICE_ERROR' && payload.data === null) return null;
  if (payload?.code !== 0 && payload?.code !== '0') throw new Error('红果未确认系列剧查询，请稍后重试。');
  if (payload.data == null) return [];
  if (!Array.isArray(payload.data)) throw new Error('官方系列剧列表格式已变化。');
  const seasons = new Map();
  for (const block of payload.data) {
    if (!object(block)) throw new Error('官方系列剧列表格式已变化。');
    if (block.video_data == null) continue;
    if (!Array.isArray(block.video_data)) throw new Error('官方系列剧列表格式已变化。');
    for (const row of block.video_data) {
      if (!object(row)) throw new Error('官方系列剧列表格式已变化。');
      const detail = { ...row, ...row.video_detail };
      const seriesId = exactId(detail.series_id_str || detail.series_id);
      const title = text(detail.title) || text(detail.series_title);
      if (!validId(seriesId) || !title || seasons.has(seriesId)) continue;
      const label = Array.isArray(detail.secondary_info_list)
        ? detail.secondary_info_list.map(item => text(item?.content).replace(/\s+/g, '')).find(item => /^第[1-9]\d*季$/.test(item))
        : undefined;
      const season = label ? Number(label.slice(1, -1)) : Number(detail.season_index);
      const firstVideo = exactId(detail.first_vid_str || detail.first_vid || detail.vid_str || detail.vid);
      const episodeCount = Number(detail.episode_cnt ?? detail.episode_count);
      const subscription = detail.subscribe_item;
      const upcoming = object(subscription) || !validId(firstVideo) || !(episodeCount > 0);
      const itemId = exactId(subscription?.item_id_str || subscription?.item_id);
      seasons.set(seriesId, {
        series_id: seriesId,
        series_title: title,
        season: Number.isSafeInteger(season) && season > 0 ? season : null,
        playable: !upcoming && !flag(detail.disable_play),
        upcoming,
        ...(upcoming && validId(itemId) ? { reservationId: itemId } : {}),
      });
    }
  }
  return [...seasons.values()];
}

async function fetchHongguoSeriesSeasons(seriesId, { request = requestJson, identity = getPlaybackDevice } = {}) {
  if (!validId(seriesId)) throw new Error('剧集编号无效。');
  const deadline = Date.now() + 18000;
  const signal = AbortSignal.timeout(18000);
  const device = await identity(request);
  const params = {
    scene: 10, from: 'single_col_same_ip_series', offset: 0, limit: 0,
    total_chapter_num: 0, current_chapter_num: 0, post_id: 0, is_horizontal_screen: 'false',
    bookstore_tab: 0, bookstore_tab_type: 0, book_id: seriesId, filter_ids: seriesId,
  };
  const signed = signedAccountRequest(SERIES_SEASONS_PATH, params, device);
  const payload = await request(signed.url, {
    method: 'GET', headers: signed.headers,
    preserveLargeIntegerFields: ['series_id', 'vid', 'first_vid', 'item_id'],
  }, deadline, signal);
  return parseSeriesSeasons(payload);
}

module.exports = { fetchHongguoSeriesSeasons, parseSeriesSeasons };
