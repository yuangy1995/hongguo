// Focused 3.7 checks: family grouping, detection scopes, single-row refresh and split errors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const baseTitle = '聚宝仙盆之杂灵根才是真BOSS';

function fixture({ failId = '', now = Date.now(), remoteSeries = [], seasons = [1, 2, 3], notify = false, fetchWait } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-history-37-'));
  const handlers = {}, queries = [], fetches = [], notifications = [];
  const seriesList = seasons.map(season => ({
    series_id: `hema:${season}`,
    series_title: `${baseTitle}${season === 1 ? '' : `第${season}季`}`,
    total: 10,
    episodes: Array.from({ length: 10 }, (_, index) => ({ vid_index: index + 1, vid: `${season}-${index + 1}` })),
  }));
  const playback = Object.fromEntries(seriesList.map((item, index) => [item.series_id, {
    watched: true, vid_index: 1, currentTime: 5, updatedAt: now - index,
    knownTotal: 10, acknowledgedTotal: 10, completedEpisode: index === 0 ? 10 : 0,
    lastCheckedAt: now - 7 * 60 * 60 * 1000, lastSequelCheckAt: 1,
  }]));
  const app = new EventEmitter();
  Object.assign(app, { getVersion: () => '3.7.0', getPath: () => dir, commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, Notification: class {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on() {}
    show() { notifications.push(this.options); }
  }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} } };
  const store = {
    getSettings: () => ({ watch_updates_enabled: true, watch_sequels_enabled: true, watch_notifications_enabled: notify }),
    getPlayback: () => structuredClone(playback),
    savePlayback: next => { Object.keys(playback).forEach(key => delete playback[key]); Object.assign(playback, structuredClone(next)); },
    updatePlayback: updater => {
      const next = structuredClone(playback);
      const result = updater(next);
      Object.keys(playback).forEach(key => delete playback[key]);
      Object.assign(playback, next);
      return result;
    },
    saveSeries() {},
  };
  const hongguo = {
    fetchEpisodeList: async id => {
      fetches.push(String(id));
      await fetchWait;
      if (String(id) === failId) throw new Error('分集接口超时');
      return structuredClone(seriesList.find(item => item.series_id === String(id)));
    },
  };
  const hongguoSearch = {
    searchHongguo: async keyword => {
      queries.push(String(keyword));
      const results = String(keyword).toLowerCase() === baseTitle.toLowerCase() ? [...seriesList, ...remoteSeries] : [];
      return { results, total: results.length, page: 1, totalPages: 1, hasMore: false };
    },
  };
  const overrides = {
    electron, './src/store': store, './src/native/hongguo': hongguo,
    './src/native/hongguo-search': hongguoSearch,
    './src/native/xifan': { search: async () => ({ success: true, results: [] }) },
    './src/native/hema': { search: async keyword => ({ success: true, ...(await hongguoSearch.searchHongguo(keyword)) }) },
  };
  const context = vm.createContext({
    require: name => overrides[name] || req(name), __dirname: path.dirname(source), process,
    console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers,
    AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.fixture = seriesList;
  vm.runInContext('seriesRegistry = fixture', context);
  return {
    playback, queries, fetches, handlers, notifications,
    refresh: options => handlers['refresh-watch-history']({}, options),
    autoRefresh: () => vm.runInContext('refreshWatchHistory()', context),
    checkOne: id => handlers['check-watch-history-item']({}, id),
    clearSequelCache: () => vm.runInContext('historySequelCache.clear()', context),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('3.7 batch checks every season but searches the family sequel once', async () => {
  const h = fixture();
  try {
    const result = await h.refresh({ scope: 'all' });
    assert.equal(result.checked, 3);
    assert.deepEqual(h.fetches.sort(), ['hema:1', 'hema:2', 'hema:3']);
    assert.equal(h.queries.filter(keyword => keyword.toLowerCase() === baseTitle.toLowerCase()).length, 1,
      'the same family must not repeat the base search for every season');
    assert.equal(h.playback['hema:1'].sequels.length, 0, 'already watched seasons are not new sequels');
    assert.equal(h.playback['hema:2'].sequels.length, 0);
    assert.equal(h.playback['hema:3'].sequels.length, 0);
  } finally { h.cleanup(); }
});

test('#97 missing lower seasons are not updates after a higher season was watched', async () => {
  const missing = { series_id: 'hema:2', series_title: baseTitle + '第2季' };
  const future = { series_id: 'hema:5', series_title: baseTitle + '第5季' };
  for (const remoteSeries of [[missing], [missing, future]]) {
    const h = fixture({ seasons: [1, 3, 4], remoteSeries, notify: true });
    try {
      h.playback['hema:1'].sequels = [missing];
      const cached = (await h.handlers['get-watch-history']({})).results;
      assert.ok(cached.every(row => !row.sequels.some(item => item.series_id === missing.series_id)),
        'old saved candidates must be filtered before another network check');
      assert.ok(cached.every(row => !row.hasUpdates), 'a missing lower season cannot create an unread dot');
      await h.refresh({ scope: 'all' });
      const expected = remoteSeries.includes(future) ? [future.series_id] : [];
      for (const id of ['hema:1', 'hema:3', 'hema:4']) {
        assert.deepEqual(h.playback[id].sequels.map(item => item.series_id), expected,
          'every record must use the highest watched season, even with gaps');
      }
      assert.equal(h.queries.filter(keyword => keyword.toLowerCase() === baseTitle.toLowerCase()).length, 1);
      assert.equal(h.notifications.length, expected.length, 'only a future season can produce a system notification');
    } finally { h.cleanup(); }
  }
});

test('#97 late checks use seasons watched while the network request was pending', async () => {
  for (const single of [false, true]) for (const future of [false, true]) {
    let finish;
    const fetchWait = new Promise(resolve => { finish = resolve; });
    const h = fixture({ seasons: [1, 3, 4, 5], notify: true, fetchWait,
      remoteSeries: future ? [{ series_id: 'hema:6', series_title: baseTitle + '第6季' }] : [] });
    delete h.playback['hema:5'];
    try {
      const pending = single ? h.checkOne('hema:1') : h.refresh({ scope: 'all' });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(h.fetches.length, 'the request must start before playback changes');
      h.playback['hema:5'] = { ...h.playback['hema:4'], vid_index: 3, currentTime: 42, updatedAt: Date.now() };
      finish();
      await pending;
      const expected = future ? ['hema:6'] : [];
      for (const id of single ? ['hema:1'] : ['hema:1', 'hema:3', 'hema:4']) {
        assert.deepEqual(h.playback[id].sequels.map(item => item.series_id), expected,
          'a newly watched season must not be saved as a new sequel');
      }
      assert.equal(h.notifications.length, expected.length, 'only a still-unwatched future season may notify');
      assert.equal(h.playback['hema:5'].currentTime, 42, 'late checks must preserve concurrent playback');
      assert.ok((await h.handlers['get-watch-history']({})).results.every(row =>
        row.sequels.every(item => item.series_id !== 'hema:5')));
    } finally { finish(); h.cleanup(); }
  }
});

test('3.7 latest scope and single-row check touch only the requested row', async () => {
  const latest = fixture();
  try {
    assert.equal((await latest.refresh({ scope: 'latest' })).checked, 1);
    assert.deepEqual(latest.fetches, ['hema:3']);
  } finally { latest.cleanup(); }

  const single = fixture();
  try {
    const result = await single.checkOne('hema:1');
    assert.equal(result.success, true);
    assert.deepEqual(single.fetches, ['hema:1']);
    assert.equal(single.queries.filter(keyword => keyword.toLowerCase() === baseTitle.toLowerCase()).length, 1,
      'single-row check still uses the latest family season for the shared sequel search');
    assert.equal(single.playback['hema:1'].sequels.length, 0, 'single-row checks also respect the highest watched season');
  } finally { single.cleanup(); }
});

test('3.7 completed low seasons skip automatic 6-hour checks but remain manually checkable', async () => {
  const h = fixture();
  try {
    assert.equal((await h.autoRefresh()).checked, 2);
    assert.deepEqual(h.fetches.sort(), ['hema:2', 'hema:3']);
    assert.equal((await h.checkOne('hema:1')).success, true);
    assert.ok(h.fetches.includes('hema:1'));
  } finally { h.cleanup(); }
});

test('3.7 episode failures remain separate from sequel results', async () => {
  const h = fixture({ failId: 'hema:2' });
  try {
    const result = await h.refresh({ scope: 'all' });
    assert.equal(result.checked, 2);
    assert.equal(result.failed, 1);
    assert.match(h.playback['hema:2'].lastEpisodeCheckError, /超时/);
    assert.equal(h.playback['hema:2'].lastSequelCheckError, '');
    assert.equal(h.playback['hema:1'].lastEpisodeCheckError, '');
  } finally { h.cleanup(); }
});

test('Hongguo titles by themselves are suggestions and official membership groups renamed seasons', () => {
  const { listHistory, findSequels, findSimilarSeries, familyKey } = require('../src/native/watch-history');
  const original = { series_id: '1000011', series_title: '游戏入侵：普攻加血一箭亿万伤屠戮神明' };
  const variants = ['游戏入侵：普攻加血一箭亿万伤屠戮神明二', '游戏入侵：普攻加血一箭亿万伤屠戮神明2',
    '游戏入侵：普攻加血一箭亿万伤屠戮神明归来第二季', '游戏入侵：普攻回血一箭亿万伤屠戮神明第二季'];
  const candidates = variants.map((series_title, i) => ({ series_id: String(1000020 + i), series_title }));
  assert.deepEqual(findSimilarSeries(original, candidates).map(item => item.series_id), candidates.map(item => item.series_id));
  assert.deepEqual(findSequels(original, candidates), [], 'fuzzy matches must never enter confirmed sequel handling');
  for (const suffix of ['第2季', '第二季', '2季', '二部', '（第二季）', '(2部)', 'season 2']) {
    const next = { series_id: '1000030', series_title: original.series_title + suffix };
    assert.equal(familyKey(next), '', suffix);
    assert.equal(findSequels(original, [next]).length, 0, suffix);
    assert.equal(findSimilarSeries(original, [next]).length, 1, suffix);
  }
  const embedded = [{ series_id: '1000040', series_title: 'AAA1BBB' }, { series_id: '1000041', series_title: 'AAA2BBB' }];
  assert.equal(findSimilarSeries(embedded[0], [embedded[1], embedded[1]]).length, 1);
  assert.equal(findSimilarSeries({ ...embedded[0], series_title: 'AAA9BBB' }, [
    { ...embedded[1], series_title: 'AAA10BBB' }, { series_id: '1000042', series_title: 'AAA十二BBB' },
  ]).length, 2, 'embedded season numbers may grow or switch between Arabic and Chinese');
  const rows = [original, ...candidates, ...embedded].map(item => ({ ...item, total: 1 }));
  const playback = Object.fromEntries(rows.map(item => [item.series_id, { watched: true, vid_index: 1, currentTime: 1, updatedAt: 100 }]));
  assert.ok(listHistory(rows, playback).every(row => !row.hasHigherSeason && !row.hasUpdates), 'suggestions must neither hide rows nor create update dots');
  assert.ok(listHistory(rows, playback, false).every(row => row.similarSeries.length === 0), 'disabling sequel detection also hides suggestions');
  assert.deepEqual(findSimilarSeries(original, [
    { ...candidates[0], series_id: 'hema:2' }, { ...candidates[0], series_id: 'unknown:1' },
    { series_id: '1000050', series_title: '完全无关的另一部短剧第二季' },
  ]), [], 'unrelated titles and other sources must not be suggested');
  assert.deepEqual(findSimilarSeries({ ...original, series_title: '甲乙' }, [{ series_id: '1000051', series_title: '甲丙' }]), [], 'short generic titles are too ambiguous');
  const first = { series_id: '1000100', series_title: '南天门计划：天阙', season: 1, playable: true };
  const second = { series_id: '1000200', series_title: '镇辰', season: 2, playable: true };
  const family = [first, second].map(entry => ({ ...entry, officialSeasons: [first, second], total: 1 }));
  assert.equal(familyKey(family[0]), familyKey(family[1]));
  assert.deepEqual(findSequels(family[0], [second]), [second]);
  const seenFamily = Object.fromEntries(family.map(item => [item.series_id, { vid_index: 1, currentTime: 1, updatedAt: 100 }]));
  const grouped = listHistory(family, seenFamily);
  assert.equal(grouped[0].hasHigherSeason, true);
  assert.equal(grouped[1].isLatestSeason, true);
  assert.equal(grouped[0].hasUpdates, false, 'a watched upper season must not be an unread sequel');
  for (const suffix of ['（2024）', '(0)', '(100)', '(二〇二四)', '(二零二四)', '(一百)', '第0季']) {
    assert.deepEqual(findSequels(original, [{ series_id: '1000052', series_title: original.series_title + suffix }]), [], suffix);
  }
});

test('remote fuzzy candidates survive refresh as hints without becoming updates or hidden seasons', async () => {
  const candidate = { series_id: 'hema:99', series_title: baseTitle + '二' };
  const h = fixture({ remoteSeries: [candidate] });
  try {
    assert.equal((await h.checkOne('hema:3')).success, true);
    assert.deepEqual(h.playback['hema:3'].similarSeries, [candidate]);
    assert.deepEqual(h.playback['hema:3'].sequels, []);
    const result = await h.handlers['get-watch-history']({});
    const row = result.results.find(item => item.series_id === 'hema:3');
    assert.deepEqual(row.similarSeries, [candidate]);
    assert.equal(row.hasUpdates, false);
    assert.equal(row.hasHigherSeason, false);
  } finally { h.cleanup(); }
});

test('a renamed candidate replaces its old fuzzy title and becomes a confirmed sequel', async () => {
  const candidate = { series_id: 'hema:99', series_title: baseTitle + '二' };
  const h = fixture({ remoteSeries: [candidate] });
  try {
    await h.checkOne('hema:3');
    assert.equal(h.playback['hema:3'].similarSeries.length, 1);
    candidate.series_title = baseTitle + '第四季';
    h.clearSequelCache();
    await h.checkOne('hema:3');
    assert.deepEqual(h.playback['hema:3'].similarSeries, [], 'a fresh explicit title must replace the old fuzzy entry with the same ID');
    assert.deepEqual(h.playback['hema:3'].sequels, [candidate]);
  } finally { h.cleanup(); }
});
