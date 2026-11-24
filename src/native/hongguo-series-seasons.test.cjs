const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchHongguoSeriesSeasons, parseSeriesSeasons } = require('./hongguo-series-seasons');
const { preserveLargeJsonIntegers } = require('./app-source');

test('the official selector looks up the exact ID and preserves provider order and upcoming status', async () => {
  const currentId = '7550000000000000006';
  const previousId = '7550000000000000001';
  const sevenId = '7550000000000000007';
  const reservationId = '7550000000000000019';
  const device = { device_id: '1234567', iid: '7654321', cdid: '12345678-1234-1234-1234-123456789012' };
  const cards = await fetchHongguoSeriesSeasons(currentId, {
    identity: async () => device,
    request: async (address, options) => {
      const url = new URL(address);
      assert.equal(options.method, 'GET');
      assert.ok(options.headers['x-medusa']);
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(url.pathname, '/reading/bookapi/plan/v');
      assert.equal(url.searchParams.get('from'), 'single_col_same_ip_series');
      assert.equal(url.searchParams.get('scene'), '10');
      assert.equal(url.searchParams.get('limit'), '0');
      assert.equal(url.searchParams.get('book_id'), currentId);
      assert.equal(url.searchParams.get('filter_ids'), currentId);
      const raw = `{"code":0,"data":[{"title":"其它区块","video_data":[{"series_id":"7550000000000000010","title":"无关剧","season_index":2}]},{"video_data":[
        {"series_id":${previousId},"title":"更名的官方首季","vid":"9000000000000000001","episode_cnt":30,"secondary_info_list":[{"content":"第1季"}]},
        {"series_id":"${currentId}","title":"当前剧集","first_vid":"9000000000000000006","episode_cnt":164,"season_index":6,"secondary_info_list":[{"content":"第3季"}]},
        {"series_id":${sevenId},"title":"新一季","vid":"9000000000000000007","episode_cnt":1,"subscribe_item":{"item_id":${reservationId}},"secondary_info_list":[{"content":"第7季"}]},
        {"series_id":"${previousId}","title":"重复"},
        {"series_id":"7550000000000000020","title":"当前不可播","vid":"9000000000000000020","episode_cnt":4,"disable_play":true}
      ]}]}`;
      return JSON.parse(preserveLargeJsonIntegers(raw, options.preserveLargeIntegerFields));
    },
  });
  assert.deepEqual(cards.map(item => [item.series_id, item.season, item.playable, item.upcoming]), [
    [previousId, 1, true, false], [currentId, 6, true, false], [sevenId, 7, false, true], ['7550000000000000020', null, false, false],
  ]);
  assert.equal(cards[2].reservationId, reservationId);
});

test('101116 without data means no series, other service errors stay retryable', () => {
  for (const payload of [{ code: 0, data: [] }, { code: 0, data: null }, { code: '0' }, { code: 101116, message: 'SERVICE_ERROR', data: null }]) {
    assert.deepEqual(parseSeriesSeasons(payload), []);
  }
  assert.throws(() => parseSeriesSeasons({ code: 0, data: {} }), /格式/);
  assert.throws(() => parseSeriesSeasons({ code: 101116, message: 'SERVICE_ERROR', data: [] }), /未确认/);
  assert.throws(() => parseSeriesSeasons({ code: 101117, message: 'SERVICE_ERROR', data: null }), /未确认/);
});
