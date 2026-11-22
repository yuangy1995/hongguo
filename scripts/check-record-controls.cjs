// In-memory records only. Never reads the user's local storage or Electron profile.
const i18nStub = { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' };
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function fixture() {
  const storage = new Map(), events = new Map();
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    dispatchEvent: event => events.get(event.type)?.(event), electronAPI: {},
  };
  const load = (file, imports = {}) => {
    const module = { exports: {} };
    const code = transformSync(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
    vm.runInNewContext(code, { module, exports: module.exports, require: name => name === '../i18n' ? i18nStub : name === './historyGroups.mjs' ? require('../src/components/historyGroups.mjs') : imports[name] || {}, window, Event, setTimeout, clearTimeout });
    return module.exports;
  };
  const mount = (file, imports = {}, props = {}) => {
    let cursor = 0, tree;
    const slots = [], effects = [], cleanups = [];
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
      useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
      useMemo: fn => { cursor++; return fn(); },
      useCallback: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i].deps[j]))) slots[i] = { fn, deps }; return slots[i].fn; },
      useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(fn); } },
    };
    react.useLayoutEffect = react.useEffect;
    const component = load(file, { ...imports, react }).default;
    const render = () => { cursor = 0; tree = component(props); effects.splice(0).forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); }); };
    const nodes = () => { const result = []; const visit = n => { if (!n || typeof n !== 'object') return; result.push(n); n.children?.forEach(visit); }; visit(tree); return result; };
    render();
    return { render, nodes, result: () => tree, find: fn => nodes().find(fn), unmount: () => cleanups.splice(0).forEach(fn => fn()), flush: async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } } };
  };
  return { storage, window, load, mount };
}

test('one search history term is removed and a failed write keeps stored history', () => {
  const h = fixture(), search = h.load('searchHistory.js');
  search.saveSearchTerm('甲'); search.saveSearchTerm('乙');
  assert.equal(typeof search.removeSearchTerm, 'function');
  assert.equal(JSON.stringify(search.removeSearchTerm('甲')), '["乙"]');
  h.window.localStorage.setItem = () => { throw new Error('full'); };
  assert.throws(() => search.removeSearchTerm('乙'), /full/);
  assert.equal(JSON.stringify(search.readSearchHistory()), '["乙"]');
});

test('favorite poster survives toggle and removal preserves other records and corrupt storage', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, cover: 'https://fixture.invalid/poster.jpg' });
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: true });
  let saved = library.saveLocalSeries({ id: 'a', title: '甲', favorite: false });
  assert.equal(saved.items.find(item => item.id === 'a').cover, 'https://fixture.invalid/poster.jpg');
  saved = library.removeLocalSeries('a');
  assert.equal(JSON.stringify(saved.items.map(item => item.id)), '["b"]');
  h.window.localStorage.setItem = () => { throw new Error('full'); };
  assert.match(library.removeLocalSeries('b').error, /full/);
  assert.equal(library.readLocalLibrary().items.length, 1);
  h.storage.set('hongguo:public-library:v1', '{broken');
  assert.ok(library.removeLocalSeries('b').error);
  assert.equal(h.storage.get('hongguo:public-library:v1'), '{broken');
});

test('search x deletes a term without selecting it or starting a search', async () => {
  const h = fixture(), search = h.load('searchHistory.js');
  search.saveSearchTerm('甲'); search.saveSearchTerm('乙');
  const media = { sources: [{ id: 'hongguo', label: '红果' }], revision: 0, loading: false };
  const ui = h.mount('components/SearchPanel.jsx', { '../searchHistory': search, './useMediaSources': { default: () => media, __esModule: true } });
  const remove = ui.find(n => n.props['aria-label'] === '删除搜索历史：甲');
  assert.ok(remove);
  remove.props.onClick(); await ui.flush();
  assert.equal(JSON.stringify(search.readSearchHistory()), '["乙"]');
  assert.equal(ui.find(n => n.type === 'input').props.value, '');
  assert.ok(!ui.find(n => n.props['aria-label'] === '删除搜索历史：甲'));
});

test('search dismisses native suggestions on container scroll and resize without losing the keyword', () => {
  const h = fixture(), search = h.load('searchHistory.js');
  const media = { sources: [{ id: 'hongguo', label: '红果' }], revision: 0, loading: false };
  const ui = h.mount('components/SearchPanel.jsx', { '../searchHistory': search, './useMediaSources': { default: () => media, __esModule: true } });
  const input = ui.find(n => n.type === 'input');
  let blurs = 0;
  input.props.ref.current = { blur: () => blurs++ };
  input.props.onChange({ target: { value: '测试剧名' } }); ui.render();
  h.window.dispatchEvent(new Event('scroll'));
  h.window.dispatchEvent(new Event('resize'));
  assert.equal(blurs, 2, 'native datalist must close when its anchor moves');
  assert.equal(ui.find(n => n.type === 'input').props.value, '测试剧名');
  ui.unmount();
  h.window.dispatchEvent(new Event('scroll'));
  h.window.dispatchEvent(new Event('resize'));
  assert.equal(blurs, 2, 'unmounted search must remove both listeners');
});

test('watch row removal calls only the removal API and retains row on error', async () => {
  const h = fixture(); let fail = true, calls = 0, removed = false;
  h.window.electronAPI = {
    getWatchHistory: async () => ({ success: true, results: removed ? [] : [{ series_id: 'a', series_title: '甲', vid_index: 1, total: 2, updatedAt: Date.now() }] }),
    removeWatchHistory: async id => { assert.equal(id, 'a'); calls++; if (!fail) removed = true; return fail ? { success: false, error: 'fixture failure' } : { success: true }; },
  };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const remove = () => ui.find(n => n.props['aria-label'] === '移除观看记录《甲》');
  assert.ok(remove());
  await remove().props.onClick(); await ui.flush();
  assert.ok(remove(), 'failed persistence must retain the row');
  assert.ok(ui.find(n => n.props.role === 'alert'));
  fail = false; await remove().props.onClick(); await ui.flush();
  assert.equal(calls, 2); assert.ok(!remove());
});

test('watch filters require completion evidence and retain resume, removal, counts and update behavior', async () => {
  const h = fixture(); let updated, played, removed;
  let rows = [
    { series_id: 'done', series_title: '已到片尾', vid_index: 2, total: 2, completed: true },
    { series_id: 'partial', series_title: '末集未完', vid_index: 2, total: 2, completed: false },
    { series_id: 'legacy', series_title: '旧记录', vid_index: 2, total: 2 },
  ].map((row, index) => ({ ...row, currentTime: 30, updatedAt: 1000 - index }));
  h.window.electronAPI = {
    getWatchHistory: async () => ({ success: true, results: rows }),
    onWatchHistoryUpdated: fn => { updated = fn; return () => {}; },
    playSeries: async request => { played = request; return { success: true }; },
    acknowledgeWatchUpdates: async () => ({ success: true }),
    removeWatchHistory: async id => { removed = id; rows = rows.filter(row => row.series_id !== id); return { success: true }; },
  };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const filter = label => ui.find(n => n.type === 'button' && n.children.join('') === label);
  const visible = () => ui.nodes().filter(n => n.props.className === 'history-name').map(n => n.children.filter(c => typeof c === 'string').join(''));
  assert.ok(filter('全部 3'), 'all filter and its total must be visible');
  assert.equal(filter('全部 3').props['aria-pressed'], true);
  filter('未看完 2').props.onClick(); await ui.flush();
  assert.deepEqual(visible(), ['末集未完', '旧记录']);
  filter('已看完 1').props.onClick(); await ui.flush();
  assert.deepEqual(visible(), ['已到片尾']);
  await ui.find(n => n.props.className === 'history-resume').props.onClick(); await ui.flush();
  assert.equal(JSON.stringify(played), JSON.stringify({ seriesId: 'done', vidIndex: 2, resume: true }));
  rows = rows.map(row => row.series_id === 'done' ? { ...row, total: 3, completed: false } : row);
  updated(); await ui.flush();
  assert.ok(filter('已看完 0'));
  assert.deepEqual(visible(), []);
  assert.ok(ui.find(n => n.type === 'h2' && n.children.includes('还没有已看完的短剧')));
  filter('查看全部').props.onClick(); await ui.flush();
  assert.equal(visible().length, 3);
  filter('未看完 3').props.onClick(); await ui.flush();
  await ui.find(n => n.props['aria-label'] === '移除观看记录《旧记录》').props.onClick(); await ui.flush();
  assert.equal(removed, 'legacy');
  assert.ok(filter('全部 2')); assert.ok(filter('未看完 2'));
  rows = rows.map(row => ({ ...row, completed: true })); updated(); await ui.flush();
  assert.ok(ui.find(n => n.type === 'h2' && n.children.includes('没有未看完的短剧')));
});

test('calendar displays saved poster and removes only the selected entry', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, cover: 'https://fixture.invalid/poster.jpg' });
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: false });
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useAccountLibrary': h.load('components/useAccountLibrary.js') });
  assert.equal(ui.find(n => n.type === 'img')?.props.src, 'https://fixture.invalid/poster.jpg');
  const remove = ui.find(n => n.props['aria-label'] === '移除《甲》');
  assert.ok(remove); remove.props.onClick(); ui.render();
  assert.equal(JSON.stringify(library.readLocalLibrary().items.map(item => item.id)), '["b"]');
});

test('legacy calendar uses local catalog posters without restoring removed rows', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true });
  let resolve;
  h.window.electronAPI.getSeriesList = () => new Promise(done => { resolve = done; });
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useAccountLibrary': h.load('components/useAccountLibrary.js') });
  assert.equal(typeof resolve, 'function');
  resolve([{ series_id: 'a', cover: 'https://fixture.invalid/old.jpg' }]); await ui.flush();
  assert.equal(ui.find(n => n.type === 'img')?.props.src, 'https://fixture.invalid/old.jpg');
  ui.find(n => n.props['aria-label'] === '移除《甲》').props.onClick(); await ui.flush();
  assert.equal(library.readLocalLibrary().items.length, 0);
  assert.ok(!ui.find(n => n.type === 'img'));
});

test('calendar shows empty cloud favorites when signed in and empty local favorites when signed out', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const imports = { '../localLibrary': library, './useAccountLibrary': h.load('components/useAccountLibrary.js') };
  const accountLibrary = { signedIn: true, ready: true, lists: { favorite: { loaded: true, items: [] } } };
  library.saveLocalSeries({ id: 'a', title: '仅浏览短剧', favorite: false });
  const ui = h.mount('components/ReleaseCalendar.jsx', imports, { accountLibrary });
  const heading = label => ui.find(node => node.type === 'h3' && node.children.includes(label));
  const label = text => ui.find(node => node.children.includes(text));
  ui.find(node => node.type === 'button' && node.children.includes('收藏')).props.onClick();
  ui.render();
  assert.ok(heading('云端收藏'));
  assert.ok(label('暂无云端记录'));
  assert.equal(heading('本机收藏'), undefined);
  assert.equal(heading('还没有本机收藏'), undefined);

  accountLibrary.lists.favorite.items = [{ id: 'cloud', title: '云端短剧' }];
  ui.render();
  assert.ok(label('云端短剧'));
  assert.equal(heading('本机收藏'), undefined);
  assert.equal(heading('还没有本机收藏'), undefined);

  library.saveLocalSeries({ id: 'b', title: '本机短剧', favorite: true });
  ui.render();
  assert.ok(heading('云端收藏'));
  assert.ok(heading('本机收藏'));
  assert.ok(label('本机短剧'));

  library.removeLocalSeries('b');
  ui.render();
  assert.equal(heading('本机收藏'), undefined);
  assert.equal(heading('还没有本机收藏'), undefined);

  accountLibrary.signedIn = false;
  ui.render();
  assert.equal(heading('云端收藏'), undefined);
  assert.equal(label('云端短剧'), undefined);
  assert.equal(label('暂无云端记录'), undefined);
  assert.ok(heading('还没有本机收藏'));
  assert.ok(label('在剧集详情点「收藏到本机」。'));
  ui.unmount();
});

test('calendar defaults to cards and remembers its list choice across tabs and mounts', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const imports = { '../localLibrary': library, './useAccountLibrary': h.load('components/useAccountLibrary.js') };
  library.saveLocalSeries({ id: 'a', title: '本机短剧', favorite: true });
  const reservation = { id: '', reservationId: '1001', title: '待上线短剧', online: false, scheduled: '12月15日上线' };
  const released = { id: '1003', reservationId: '1002', title: '已上线短剧', online: true };
  const actions = [];
  const props = { accountLibrary: {
    signedIn: true, ready: true,
    lists: { reservation: { loaded: true, items: [reservation, released] } },
    change: async action => { actions.push(action); return { success: true }; },
  }, onPlay() {} };
  const ui = h.mount('components/ReleaseCalendar.jsx', imports, props);
  const button = label => ui.find(node => node.type === 'button' && node.children.includes(label));
  assert.equal(ui.result().props['data-view'], 'cards');
  assert.equal(button('卡片').props['aria-pressed'], true);
  button('我的预约').props.onClick();
  ui.render();
  assert.equal(ui.result().props['data-view'], 'cards');
  assert.equal(button('已上线').props['aria-pressed'], true);
  assert.equal(button('待上线').props['aria-pressed'], false);
  for (const tab of ['已上线', '待上线']) {
    assert.ok(button(tab).children.some(node => node?.props?.className === 'release-reservation-count' && node.children.map(String).includes('1')));
  }
  assert.ok(ui.find(node => node.type === 'strong' && node.children.includes(released.title)));
  assert.ok(button('播放'));
  assert.equal(button('取消预约'), undefined);
  assert.ok(!button('移除预约记录').props.disabled);
  await button('移除预约记录').props.onClick();
  assert.equal(actions[0].item, released);
  assert.equal(actions[0].value, false);
  button('待上线').props.onClick();
  ui.render();
  assert.ok(ui.find(node => node.type === 'strong' && node.children.includes(reservation.title)));
  assert.ok(ui.find(node => node.type === 'span' && node.children.includes(reservation.scheduled)));
  assert.equal(button('播放'), undefined);
  assert.equal(button('移除预约记录'), undefined);
  button('列表').props.onClick();
  ui.render();
  assert.equal(ui.result().props['data-view'], 'list');
  assert.equal(button('列表').props['aria-pressed'], true);
  assert.ok(ui.find(node => node.type === 'span' && node.children.includes(reservation.scheduled)));
  await button('取消预约').props.onClick();
  assert.equal(actions[1].item, reservation);
  assert.equal(actions[1].value, false);
  button('收藏').props.onClick();
  ui.render();
  assert.equal(ui.result().props['data-view'], 'list');
  assert.ok(ui.find(node => node.type === 'strong' && node.children.includes('本机短剧')));
  const reopened = h.mount('components/ReleaseCalendar.jsx', imports, props);
  assert.equal(reopened.result().props['data-view'], 'list');
  button('卡片').props.onClick();
  reopened.render();
  assert.equal(h.storage.get('hongguo:release-calendar-display'), 'cards');
  ui.unmount();
  reopened.unmount();
});

test('moving a favorite changes only the selected local favorite after current-account confirmation', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const [a, b, c] = ['a', 'b', 'c'].map(id => ({ id, title: id.toUpperCase(), favorite: true, published_at: 1762041600000 }));
  for (const item of [a, b, c]) library.saveLocalSeries(item);
  const localIds = () => Array.from(library.readLocalLibrary().items.filter(item => item.favorite), item => item.id);
  let onAccount, finish, sessionId = '', cloud = [];
  h.window.electronAPI = {
    getAccountStatus: async () => ({ success: true, signedIn: !!sessionId, librarySession: sessionId }),
    onAccountUpdated: fn => { onAccount = fn; },
    getAccountLibrary: async () => ({ success: true, items: cloud }),
    changeAccountLibrary: (token, change) => {
      assert.equal(token, sessionId);
      assert.equal(change.kind, 'favorite');
      assert.equal(change.seriesId, c.id);
      assert.equal(change.value, true);
      return new Promise(resolve => { finish = resolve; });
    },
  };
  const ui = h.mount('components/useAccountLibrary.js', { '../localLibrary': library });
  const switchSession = async value => { sessionId = value; onAccount({ signedIn: !!value }); await ui.flush(); };
  const move = () => ui.result().change({ kind: 'favorite', item: c, value: true, move: true });
  try {
    await switchSession('first');
    assert.deepEqual(localIds(), ['a', 'b', 'c']);
    await switchSession('');
    assert.deepEqual(localIds(), ['a', 'b', 'c']);
    await switchSession('second');
    const denied = move();
    finish({ success: false, error: '云端拒绝' });
    assert.equal((await denied).success, false);
    assert.deepEqual(localIds(), ['a', 'b', 'c']);
    const stale = move();
    await switchSession('');
    await switchSession('third');
    finish({ success: true, entry: c, items: [c] });
    assert.equal((await stale).cancelled, true);
    assert.deepEqual(localIds(), ['a', 'b', 'c']);
    const confirmed = move();
    cloud = [c];
    finish({ success: true, entry: c, items: cloud });
    assert.equal((await confirmed).success, true);
    await ui.flush();
    assert.equal(ui.result().lists.favorite.items[0].id, c.id);
    assert.equal(library.readLocalLibrary().items.find(item => item.id === c.id).published_at, c.published_at);
    await switchSession('');
    assert.equal(ui.result().lists.favorite, undefined);
    assert.deepEqual(localIds(), ['a', 'b']);
    await switchSession('fourth');
    await ui.result().refresh('favorite');
    await ui.flush();
    assert.equal(ui.result().lists.favorite.items[0].id, c.id);
  } finally { ui.unmount(); }
});
