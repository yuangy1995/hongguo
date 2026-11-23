const { setTimeout: delay } = require('node:timers/promises');

// Request and response contracts cross-checked against the public hongguoTV
// CloudAccount implementation and aston314/hongguo-tv's account list protocols.
const FAVORITES = '/reading/bookapi/bookshelf/video/info/v1/';
const FAVORITE_WRITE = '/reading/bookapi/bookshelf/video/update/v1/';
const LIKES = '/reading/ugc/action/mget/v';
const LIKE_WRITE = '/novel/articleapi/do_action/v1/';
const SUBSCRIPTIONS = '/reading/user/subscribe/list/v1/';
const RESERVATION_WRITE = '/reading/bookapi/search/uncover_subscribe/v';
const RESERVATION_REMOVE = '/reading/user/subscribe/delete/v';

const ID_FIELDS = ['series_id', 'book_id', 'vid', 'video_id', 'item_id', 'session_id'];
const reservationDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric',
});
const reservationTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const shanghaiDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const exactReleaseDate = /\d+\s*[日号]|\d{1,2}[-/.]\d{1,2}/;
const approximateReleaseDate = /\d+\s*[年月]|\d{1,2}:\d{2}|今天|明天|后天|[今明本下]周|周末|[上中下]旬|月初|月底|今年|明年/;
const genericReleaseStatus = /^(即将上线|待上线|上线时间暂未公布|敬请期待)(?:[\s，,。！!、]|$)/;
const isId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);
const idOf = value => typeof value === 'number' && !Number.isSafeInteger(value) ? '' : String(value ?? '');
const isTrue = value => value === true || value === 1 || value === '1' || value === 'true';
const isFalse = value => value === false || value === 0 || value === '0' || value === 'false';
const asObject = value => value && typeof value === 'object' && !Array.isArray(value);

function checkResponse(payload, accepted = ['0']) {
  const codes = [payload?.code, payload?.error_code, payload?.data?.code, payload?.data?.error_code];
  if (!accepted.includes(String(codes[0])) || codes.slice(1).some(code => code != null && !accepted.includes(String(code)))) {
    if (codes.some(code => String(code) === '401') ||
        /未登录|登录(?:态|状态)?(?:已)?(?:失效|过期)|请(?:先|重新)登录/.test(String(payload?.data?.description || payload?.message || ''))) {
      throw Object.assign(new Error('红果登录已失效，请重新登录'), { status: 401 });
    }
    throw new Error('红果未确认账号操作，请稍后重试');
  }
  return payload.data;
}

function list(data, field) {
  if (!asObject(data) || !Object.hasOwn(data, field)) throw new Error('红果账号列表格式已变化');
  if (data[field] === null) return [];
  if (!Array.isArray(data[field]) || data[field].some(row => !asObject(row))) throw new Error('红果账号列表格式已变化');
  return data[field];
}

function hasMore(value, optional = false) {
  if (value == null && optional) return false;
  if (!isTrue(value) && !isFalse(value)) throw new Error('红果账号列表分页格式已变化');
  return isTrue(value);
}

function nextOffset(value, offset, step) {
  const next = Number(value);
  return Number.isSafeInteger(next) && next > offset ? next : offset + step;
}

function seriesCard(id, detail, cleanText, cleanCover) {
  return {
    id,
    title: cleanText(detail.series_title || detail.title || detail.book_name || detail.name),
    cover: cleanCover(detail.series_cover_url || detail.series_cover || detail.cover || detail.cover_url || detail.thumb_url),
  };
}

function reservationSeriesId(schema) {
  try {
    const url = new URL(schema);
    return url.protocol === 'dragon8662:' && url.hostname.toLowerCase() === 'shortseriesdetail'
      ? url.searchParams.get('series_id') : '';
  } catch { return ''; }
}

function reservationTimestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) return 0;
  if (timestamp >= 1e9 && timestamp < 1e10) return timestamp * 1000;
  return timestamp >= 1e12 && timestamp < 1e13 ? timestamp : 0;
}

function reservationSchedule(row, cleanText, now) {
  const subtitles = Array.isArray(row.sub_title_list) ? row.sub_title_list.map(entry => entry?.content) : [];
  const hints = [...subtitles, row.expected_rec_text, row.publish_time_text, row.sub_info].map(cleanText);
  const today = shanghaiDayFormatter.format(now);
  const timestamps = [row.schedule_publish_time, row.expected_publish_time].map(reservationTimestamp).filter(Boolean);
  const upcoming = timestamps.find(time => time >= now || shanghaiDayFormatter.format(time) === today);
  const timestamp = upcoming || timestamps[0];
  if (timestamp) {
    const date = reservationDateFormatter.format(timestamp);
    const clock = reservationTimeFormatter.format(timestamp);
    return `${upcoming ? '预计' : '原预计'}${date}${clock === '00:00' ? '' : ` ${clock}`}上线`;
  }
  return hints.find(text => exactReleaseDate.test(text))
    || hints.find(text => approximateReleaseDate.test(text))
    || hints.map(text => text.match(genericReleaseStatus)?.[1]).find(Boolean) || '';
}

function createAccountLibrary({ request, cleanText, cleanCover, now, signal }) {
  async function readFavorites() {
    const data = checkResponse(await request(FAVORITES));
    const favorites = new Map();
    for (const row of list(data, 'video_shelf_info')) {
      const video = row.video_data || {};
      const id = idOf(video.series_id_str || video.series_id || row.series_id_str || row.series_id || row.book_id);
      if (!isId(id)) throw new Error('红果云端收藏剧集编号无效');
      favorites.set(id, seriesCard(id, { ...row, ...video }, cleanText, cleanCover));
    }
    if (hasMore(data.has_more, true)) throw new Error('红果云端收藏未读取完整，请稍后重试');
    return [...favorites.values()];
  }

  async function readLikes() {
    const likes = new Map();
    const seenPages = new Set();
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      const data = checkResponse(await request(LIKES, { object_type_list: '6,15,10', action_type: '3', offset, count: 100 }));
      const rows = list(data, 'mixed_data_list');
      const pageKey = JSON.stringify(rows.map(row => row.video_data?.vid_str || row.video_data?.vid || row.video_data?.video_id || row.object_id));
      if (rows.length && seenPages.has(pageKey)) break;
      if (rows.length) seenPages.add(pageKey);
      for (const { video_data: video } of rows) {
        if (!asObject(video)) continue; // The endpoint also includes non-video objects.
        const detail = video.video_detail || {};
        const id = idOf(video.series_id_str || video.series_id);
        const episodeId = idOf(video.vid_str || video.vid || video.video_id);
        const detailId = idOf(detail.series_id_str || detail.series_id);
        const known = likes.get(episodeId);
        if (!isId(id) || !isId(episodeId) || (detailId && id !== detailId) || (known && known.id !== id)) {
          throw new Error('红果云端点赞分集身份无效');
        }
        likes.set(episodeId, {
          ...seriesCard(id, { ...video, ...detail }, cleanText, cleanCover),
          episodeId, episodeIndex: Number(video.vid_index) || 0,
        });
      }
      if (!hasMore(data.has_more)) return [...likes.values()];
      if (!rows.length) break;
      offset = nextOffset(data.next_offset, offset, 100);
    }
    throw new Error('红果云端点赞未读取完整，请稍后重试');
  }

  function reservationCard(row, online, calendar = false) {
    const rawItemId = idOf(row.item_id_str || row.item_id);
    const reservationId = isId(rawItemId) ? rawItemId : '';
    const summary = row.subscribe_data || row.video_data || {};
    const detail = summary.video_detail || summary;
    const id = idOf(detail.series_id_str || detail.series_id || detail.video_data?.series_id || row.series_id_str || row.series_id
      || summary.series_id_str || summary.series_id || row.book_id || reservationSeriesId(row.detail_schema));
    if (!reservationId && (!online || !isId(id))) return null;
    return {
      ...seriesCard(isId(id) ? id : '', { ...row, ...summary, ...detail }, cleanText, cleanCover),
      reservationId,
      online,
      scheduled: online ? '' : reservationSchedule(row, cleanText, now()),
      reserved: !calendar || isTrue(row.has_subscribed),
    };
  }

  async function readReservations(online) {
    const reservations = new Map();
    let offset = 0;
    let sessionId = '';
    for (let page = 0; page < 200; page++) {
      const data = checkResponse(await request(SUBSCRIPTIONS, {
        tab_type: 13, subscribe_order_type: 0, swipe_type: 0, need_calendar_schema: 'false',
        limit: 20, subscribe_offset: 0, is_online: String(online), offset,
        ...(sessionId ? { session_id: sessionId } : {}),
      }));
      const rows = list(data, 'subscribe_items');
      const before = reservations.size;
      for (const row of rows) {
        if (online ? isFalse(row.is_online) : isTrue(row.is_online)) throw new Error('红果预约上线状态已变化，请刷新后重试');
        const entry = reservationCard(row, online);
        if (!entry) throw new Error('红果云端预约项目编号无效');
        reservations.set(entry.reservationId || entry.id, entry);
      }
      if (!hasMore(data.has_more, true)) return [...reservations.values()];
      if (reservations.size === before) break;
      offset = nextOffset(data.next_offset, offset, 20);
      sessionId = idOf(data.session_id);
    }
    throw new Error('红果云端预约未读取完整，请稍后重试');
  }

  async function readUpcoming() {
    const upcoming = new Map();
    let offset = 0;
    let subscribeOffset = 0;
    let sessionId = '';
    for (let page = 0; page < 5; page++) {
      const data = checkResponse(await request(SUBSCRIPTIONS, {
        tab_type: 5, tab_style: 2, active_panel: 6, gender_type: 2, need_calendar_schema: 'true',
        offset, subscribe_offset: subscribeOffset, ...(sessionId ? { session_id: sessionId } : {}),
      }));
      for (const row of list(data, 'subscribe_items')) {
        if (isTrue(row.is_online)) continue;
        const entry = reservationCard(row, false, true);
        if (entry) upcoming.set(entry.reservationId, entry);
      }
      const next = Number(data.calendar_loc_info?.subscribe_offset);
      if (!isTrue(data.calendar_loc_info?.down_has_more) || !(next > subscribeOffset)) break;
      subscribeOffset = next;
      offset = Math.max(offset, Number(data.next_offset) || 0);
      sessionId = idOf(data.session_id);
    }
    return [...upcoming.values()];
  }

  const readers = new Map([
    ['favorite', readFavorites],
    ['like', readLikes],
    ['reservation', async () => (await Promise.all([readReservations(false), readReservations(true)])).flat()],
    ['pendingReservations', () => readReservations(false)],
    ['upcoming', readUpcoming],
  ]);
  const writes = new Set();

  return {
    async read(kind) {
      if (!readers.has(kind)) throw new Error('无效的账号列表');
      return readers.get(kind)();
    },
    async change({ kind, seriesId, episodeId, reservationId, value, online = false, reservationSeries = false }) {
      const fromSeries = kind === 'reservation' && reservationSeries === true;
      const removeReleased = kind === 'reservation' && online === true;
      const reservationKey = removeReleased ? reservationId || seriesId : reservationId;
      if (typeof value !== 'boolean' || (kind === 'reservation'
        ? typeof online !== 'boolean' || (removeReleased && value) || !isId(reservationKey)
          || (fromSeries && (online || !isId(seriesId)))
        : !isId(seriesId) || (kind === 'like' && !isId(episodeId)))) throw new Error('账号操作的剧集或分集编号无效');
      const settings = {
        favorite: {
          read: readFavorites, matches: row => row.id === seriesId, path: FAVORITE_WRITE,
          body: () => ({
            is_cancelled: false,
            update_bookshelf_video_list: [{
              book_id: seriesId, book_type: 2, modify_time: now(), video_shelf_operate_type: value ? 0 : 1,
              ...(!value ? { group_name: '' } : {}),
            }],
            ...(value ? { shark_extra: { enter_from: 'MainFragmentActivity', previous_page: '',
              page_list: 'MainFragmentActivity', is_active_behavior: 'true', inactive_type: '0' } } : {}),
          }),
        },
        like: {
          read: readLikes, matches: row => row.id === seriesId && row.episodeId === episodeId, path: LIKE_WRITE,
          body: () => ({
            action_category: 1, action_reason_remark: 'like_click', action_type: value ? 3 : 4,
            object_id: episodeId, object_type: 6,
            business_param: { book_id: 0, has_aigc_content: false, modify_count: 0, video_id: seriesId,
              shark_param: { enter_from: 'MainFragmentActivity', previous_page: '', page_list: 'MainFragmentActivity' } },
          }),
        },
        reservation: {
          read: () => readReservations(online),
          matches: row => (removeReleased ? row.reservationId || row.id : row.reservationId) === reservationKey
            || (fromSeries && (row.id === seriesId || row.reservationId === seriesId)),
          path: removeReleased ? RESERVATION_REMOVE : RESERVATION_WRITE,
          body: row => removeReleased ? {
            item_id: [row.reservationId || row.id], is_online: true,
            all_select: false, not_del_item_id: [], tab_type: 13,
          } : {
            item_id: JSON.rawJSON(fromSeries ? seriesId : reservationId), item_type: 1, op_type: value ? 1 : 2, wish_list_all_del: 0,
            shark_param: { enter_from: 'BulletActivity', previous_page: 'MainFragmentActivity',
              page_list: 'MainFragmentActivity,BulletActivity' },
          },
        },
      };
      if (!Object.hasOwn(settings, kind) || writes.has(kind)) throw new Error('账号操作正在处理或类型无效');
      const { read, matches, path, body } = settings[kind];
      const result = items => ({
        entry: items.find(matches) || null,
        ...(kind !== 'reservation' ? { items } : !online ? { pendingItems: items } : {}),
      });
      writes.add(kind);
      try {
        const previous = result(await read());
        if (!!previous.entry === value) return previous;
        checkResponse(await request(path, {}, body(previous.entry)), kind === 'like' ? ['0', '101045', '101046'] : ['0']);
        for (const wait of [0, 700, 1600]) {
          if (wait) await delay(wait, undefined, { signal });
          const confirmed = result(await read());
          if (!!confirmed.entry === value) return confirmed;
        }
        throw new Error('红果云端尚未确认该操作，请刷新后重试');
      } finally {
        writes.delete(kind);
      }
    },
  };
}

module.exports = {
  createAccountLibrary, ID_FIELDS,
  LIBRARY_READ_PATHS: [FAVORITES, LIKES, SUBSCRIPTIONS],
  LIBRARY_WRITE_PATHS: [FAVORITE_WRITE, LIKE_WRITE, RESERVATION_WRITE, RESERVATION_REMOVE],
  LIBRARY_GZIP_PATHS: [RESERVATION_WRITE, RESERVATION_REMOVE],
};
