// In-memory App -> real play-series IPC -> Player contract; no network or user files.
const i18nStub = { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { transformSync } = require('esbuild');
const { mount: mountPlayer } = require('./check-player-resume.cjs');
const appSource = transformSync(fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const playHandler = mainSource.slice(mainSource.indexOf('function navigateToPlayer'), mainSource.indexOf('// ===== 在线播放 ====='));
assert.match(playHandler, /function navigateToPlayer[\s\S]*ipcMain\.handle\('play-series'/, 'real playback IPC must be found');

function fixture({ exists = true, dismissed = false, saveError = '', resolveError = '', playError = '', missingMessage = '', resolveGate, episodes } = {}) {
  const registry = exists ? [{ series_id: 'A', dismissed, forgotten: dismissed, episodes }] : [];
  const requests = [], resolutions = [], slots = [], effects = [];
  let cursor = 0, tree, navigate, handler;
  const component = name => ({ __esModule: true, default: name });
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback: fn => { cursor++; return fn; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(fn); } },
  };
  react.useLayoutEffect = react.useEffect;
  vm.runInNewContext(playHandler, {
    ipcMain: { handle: (_, fn) => { handler = fn; } }, seriesRegistry: registry,
    saveSeriesRegistry: () => { if (saveError) throw new Error(saveError); },
    sendToRenderer: (_, payload) => navigate(payload),
  });
  const api = {
    getAppInfo: async () => ({ preview: true }),
    onNavigate: fn => { navigate = fn; return () => {}; },
    playSeries: async payload => {
      requests.push({ ...payload });
      if (playError) return { success: false, error: playError };
      const result = await handler({}, payload);
      return !result.success && missingMessage ? { ...result, error: missingMessage } : result;
    },
    searchResolve: async id => {
      resolutions.push(id);
      if (resolveGate) await resolveGate;
      if (resolveError) return { success: false, error: resolveError };
      if (!registry.some(item => item.series_id === id)) registry.push({ series_id: id });
      return { success: true, data: { series_id: id } };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(appSource, { module, exports: module.exports, window: { electronAPI: api }, navigator: {},
    require: name => name === './i18n' ? i18nStub : name === 'react' ? react : name === './theme' ? { initializeTheme() {} }
      : ['./components/useStealthWindow', './components/useAccountLibrary'].includes(name) ? { __esModule: true, default: () => ({}) } : component(name),
  });
  const render = () => { cursor = 0; tree = module.exports.default({}); effects.splice(0).forEach(fn => fn()); };
  const find = predicate => {
    const visit = node => { if (!node || typeof node !== 'object') return; if (predicate(node)) return node; return node.children?.map(visit).find(Boolean); };
    return visit(tree);
  };
  const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } };
  render();
  find(node => node.type === 'button' && node.children.some(child => child?.children?.includes('收藏与上新'))).props.onClick();
  render();
  return { registry, requests, resolutions, find, flush,
    go: label => find(node => node.type === 'button' && node.children.some(child => child?.children?.includes(label))).props.onClick(),
    play: async (episodeId) => { await find(node => node.type === './components/ReleaseCalendar').props.onPlay({ seriesId: 'A', episodeId }); await flush(); },
    directPlay: payload => handler({}, payload),
    target: () => find(node => node.type === './components/Player')?.props.target,
    error: () => find(node => node.props.role === 'alert')?.children[0]?.children[0],
  };
}

test('a liked episode navigates using its registered VID rather than a stale episode number', async () => {
  const episodeId = '7500000000000000011';
  const app = fixture({ episodes: [{ vid: '7500000000000000012', vid_index: 1 }, { vid: episodeId, vid_index: 2 }] });
  await app.play(episodeId);
  assert.equal(app.resolutions.length, 0);
  assert.equal(app.target().seriesId, 'A');
  assert.equal(app.target().vidIndex, 2);
  assert.equal(app.target().resume, false);
  assert.equal((await app.directPlay({ seriesId: 'A', episodeId: '7500000000000000013' })).code, 'EPISODE_NOT_FOUND');
});

for (const dismissed of [false, true]) for (const saved of [null, { vid_index: 2, currentTime: 37 }]) {
  test(`offline calendar playback: dismissed=${dismissed}, saved=${!!saved}`, async () => {
    const app = fixture({ dismissed, resolveError: 'offline' });
    await app.play();
    assert.equal(app.resolutions.length, 0, 'existing local archive must not require online resolution');
    assert.equal(app.error(), undefined);
    assert.equal(app.registry[0].dismissed, false);
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].resume, true);
    assert.equal(app.target()?.seriesId, 'A');
    const player = mountPlayer({ local: true, saved, lockedIndexes: saved ? [] : [1], props: { target: app.target() } });
    try {
      await player.flush(); player.metadata();
      assert.equal(player.find(node => node.type === 'video').props.src, 'file:///mock-2.mp4');
      assert.equal(player.media.paused, false, 'play must start media, not merely open the library');
      assert.equal(player.media.currentTime, saved?.currentTime || 0);
      assert.equal(player.prepares.length, 0, 'local video must not request an online source');
    } finally { player.unmount(); }
  });
}

test('only a missing archive resolves online, then sends a real play command', async () => {
  const app = fixture({ exists: false, missingMessage: '档案已移除' }); await app.play();
  assert.deepEqual(app.resolutions, ['A']);
  assert.equal(app.requests.length, 2);
  assert.ok(app.requests.every(request => request.seriesId === 'A' && request.resume === true));
  assert.equal(app.target()?.seriesId, 'A'); assert.equal(app.error(), undefined);
});

for (const saveError of ['', '磁盘已满']) test(`explicit first-episode playback restores a dismissed archive: saveError=${!!saveError}`, async () => {
  const app = fixture({ dismissed: true, saveError });
  const result = await app.directPlay({ seriesId: 'A', vidIndex: 1 });
  assert.equal(result.success, !saveError);
  assert.equal(app.registry[0].dismissed, !!saveError);
  assert.equal(app.registry[0].forgotten, !!saveError);
  assert.equal(result.error, saveError || undefined);
  if (!saveError) {
    await app.flush();
    const player = mountPlayer({ local: true, lockedIndexes: [1], saved: { vid_index: 2, currentTime: 37 }, props: { target: app.target() } });
    try {
      await player.flush(); player.metadata();
      assert.equal(player.find(node => node.type === 'video').props.src, 'file:///mock-2.mp4');
      assert.equal(player.media.currentTime, 0, 'explicit sequel playback must start the first unlocked episode from the beginning');
      assert.equal(player.prepares.length, 0);
    } finally { player.unmount(); }
  }
});

for (const all of [false, true]) for (const failure of ['success', 'partial', 'ipc', 'records']) test(`download deletion refreshes detail and storage after ${failure}: all=${all}`, async () => {
  let deleted = false, detailReads = 0, storageReads = 0;
  const remove = async () => {
    deleted = true;
    if (failure === 'ipc') throw new Error('IPC disconnected');
    return { success: failure === 'success', count: 1, failed: failure === 'records' ? 0 : 2, freed: 12, error: failure === 'records' ? '任务记录保存失败' : '文件占用' };
  };
  const player = mountPlayer({ local: true, apiOverrides: {
    getSeriesEpisodes: async () => {
      detailReads++;
      return { success: true, data: { series_id: 'A', series_title: '测试剧', total: 3, completedCount: deleted ? 2 : 3, episodes: [
        { vid_index: 1, vid: 'v1', status: deleted ? 'missing' : 'completed', ...(deleted ? {} : { fileUrl: 'file:///mock-1.mp4' }) },
      ] } };
    },
    getStorageUsage: async () => {
      storageReads++;
      return { success: true, series: [{ series_id: 'A', files: deleted ? 2 : 3, bytes: deleted ? 24 : 36 }], totalFiles: deleted ? 2 : 3, totalBytes: deleted ? 24 : 36 };
    },
    deleteSeriesFiles: remove, deleteAllDownloaded: remove,
  } });
  try {
    await player.flush();
    player.button('切换剧集').props.onClick(); await player.flush();
    const beforeDetail = detailReads, beforeStorage = storageReads;
    const downloadText = () => player.find(node => node.props.className === 'series-row-sub')?.children.join('');
    assert.match(downloadText(), /已下载.*3.*3/);
    const button = all ? player.button('删除全部已下载') : player.find(node => node.type === 'button' && node.props.title?.startsWith('删除本地文件'));
    button.props.onClick({ stopPropagation() {} }); await player.flush();
    await player.button(all ? '全部删除' : '删除文件').props.onClick(); await player.flush();
    assert.ok(detailReads > beforeDetail, 'partial deletion must reload episode paths');
    assert.ok(storageReads > beforeStorage, 'partial deletion must reload remaining storage');
    const toast = player.find(node => node.props.className === 'dm-toast dm-toast-success')?.children.join('');
    if (failure === 'partial') { assert.match(toast, /已删除 1 个/); assert.match(toast, /2 个.*失败/); }
    else if (failure === 'ipc') assert.match(toast, /IPC disconnected/);
    else assert.match(toast, /已删除 1 个/);
    assert.match(downloadText(), /已下载.*2.*3/, 'download count must reflect remaining episodes after any deletion outcome');
    assert.ok(player.find(node => node.props.className === 'series-picker-usage')?.children.includes(2));
  } finally { player.unmount(); }
});

test('failed online resolution keeps calendar visible and reports the source error', async () => {
  const app = fixture({ exists: false, resolveError: 'offline' }); await app.play();
  assert.equal(app.requests.length, 1); assert.equal(app.target(), undefined);
  assert.equal(app.error(), 'offline');
});

test('failed archive restoration stays local and retains its dismissed state', async () => {
  const app = fixture({ dismissed: true, saveError: '磁盘已满' }); await app.play();
  assert.equal(app.resolutions.length, 0); assert.equal(app.target(), undefined);
  assert.equal(app.error(), '磁盘已满'); assert.equal(app.registry[0].dismissed, true);
  assert.equal(app.registry[0].forgotten, true);
});

test('blocked playback does not turn into online resolution', async () => {
  const app = fixture({ playError: '正在退出' }); await app.play();
  assert.equal(app.resolutions.length, 0); assert.equal(app.target(), undefined);
  assert.equal(app.error(), '正在退出');
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const returnToCalendar of [false, true]) test(`leaving calendar during archive resolution cancels retry: return=${returnToCalendar}`, async () => {
  const pending = deferred(), app = fixture({ exists: false, resolveGate: pending.promise });
  const playing = app.play(); await app.flush();
  app.go('发现短剧'); await app.flush();
  if (returnToCalendar) { app.go('收藏与上新'); await app.flush(); }
  pending.resolve(); await playing;
  assert.equal(app.requests.length, 1, 'stale resolution must not issue a second navigation');
  assert.equal(app.target(), undefined);
});

test('calendar suppresses repeated playback clicks until resolution completes', async () => {
  const pending = deferred(), app = fixture({ exists: false, resolveGate: pending.promise });
  const first = app.play(), second = app.play(); await app.flush();
  pending.resolve(); await Promise.all([first, second]);
  assert.equal(app.resolutions.length, 1); assert.equal(app.requests.length, 2);
});

function mountHistoryNavigation(overrides = {}) {
  const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/WatchHistory.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const slots = [], effects = [], layoutEffects = [], cleanups = [], calls = [], pending = deferred();
  const props = { active: true }; let cursor = 0, tree;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  react.useLayoutEffect = (fn, deps) => {
    const i = cursor++;
    if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) {
      slots[i] = deps; layoutEffects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); });
    }
  };
  const api = {
    getWatchHistory: async () => ({ success: true, results: [{ series_id: 'A', series_title: '原剧', sequels: [{ series_id: 'B', series_title: '续作' }] }] }),
    playSeries: async payload => { calls.push(['play', payload.seriesId]); return calls.filter(c => c[0] === 'play').length === 1 ? { success: false, code: 'SERIES_NOT_FOUND' } : { success: true }; },
    searchResolve: async () => { calls.push(['resolve']); await pending.promise; return { success: true, data: { episodes: [{ vid_index: 1 }] } }; },
    acknowledgeWatchUpdates: async () => { calls.push(['ack']); return { success: true }; },
    ...overrides,
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === '../i18n' ? i18nStub : name === './historyGroups.mjs' ? require('../src/components/historyGroups.mjs') : name === 'react' ? react : {}, window: { electronAPI: api }, document: { querySelector: () => null } });
  const render = (runPassive = true) => {
    cursor = 0; tree = module.exports.default(props);
    layoutEffects.splice(0).forEach(fn => fn());
    if (runPassive) effects.splice(0).forEach(fn => fn());
  };
  const find = predicate => { const visit = node => { if (!node || typeof node !== 'object') return; if (predicate(node)) return node; return node.children?.map(visit).find(Boolean); }; return visit(tree); };
  const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } };
  render();
  return { props, api, calls, pending, find, flush, commit: render, open: () => find(node => node.type === 'button' && node.children.includes('续作')).props.onClick(), unmount: () => cleanups.forEach(fn => fn?.()) };
}

test('history reads official seasons on demand and opens a confirmed season without clearing the original update', async () => {
  const current = { series_id: '7500000000000000001', series_title: '我合成了全世界第2季', unreadEpisodes: 1,
    similarSeries: [{ series_id: '7500000000000000011', series_title: '同名搜索结果' }] };
  const first = { series_id: '7500000000000000002', series_title: '我合成了全世界第1季', playable: true };
  const upcoming = { series_id: '7500000000000000003', series_title: '我合成了全世界啊第4季', upcoming: true, playable: false };
  const calls = [], lookup = deferred();
  const ui = mountHistoryNavigation({
    getWatchHistory: async () => ({ success: true, results: [current] }),
    findSeriesSeasons: async id => { calls.push(['lookup', id]); return lookup.promise; },
    playSeries: async ({ seriesId, vidIndex }) => { calls.push(['play', seriesId, vidIndex]); return { success: true }; },
    acknowledgeWatchUpdates: async id => { calls.push(['ack', id]); return { success: true }; },
  });
  await ui.flush();
  assert.deepEqual(calls, []);
  const textNode = label => ui.find(node => node.children.includes(label));
  const seasonButton = label => ui.find(node => node.type === 'button' && node.children.includes(label));
  const trigger = textNode('系列剧');
  assert.equal(trigger.props.popovertarget, `history-seasons-${current.series_id}`);
  assert.equal(textNode('疑似同剧（仅提示）'), undefined);
  assert.equal(textNode('同名搜索结果'), undefined);
  const reading = trigger.props.onClick();
  await trigger.props.onClick();
  ui.commit();
  assert.ok(textNode('正在读取官方系列剧…'));
  assert.deepEqual(calls, [['lookup', current.series_id]]);
  lookup.resolve({ official: true, results: [first, { ...current, playable: true }, upcoming] });
  await reading; await ui.flush();
  assert.equal(seasonButton(current.series_title).props['aria-current'], 'true');
  assert.equal(seasonButton(upcoming.series_title).props.disabled, true);
  assert.ok(textNode('待上线'));
  seasonButton(first.series_title).props.onClick({ currentTarget: { closest: () => null } });
  await ui.flush();
  assert.deepEqual(calls, [['lookup', current.series_id], ['play', first.series_id, 1]]);
  assert.ok(ui.find(node => node.props.className === 'history-dot'));
  ui.unmount();
});

test('official season lookup can serve a history entry without a local archive', async () => {
  const handlerSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('find-series-seasons'"), mainSource.indexOf('// 搜索选中某部剧后'));
  const calls = [];
  let seasons = id => [{ series_id: id }];
  let handler;
  vm.runInNewContext(handlerSource, {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    visibleSeries: () => [],
    watchHistory: require('../src/native/watch-history'),
    fetchHongguoSeriesSeasons: async id => { calls.push(id); return seasons(id); },
  });
  const id = '7500000000000000001';
  const result = await handler({}, id);
  assert.equal(result.official, true);
  assert.equal(result.results[0].series_id, id);
  assert.equal((await handler({}, Number(id))).unsupported, true);
  assert.equal((await handler({}, 'hema:1')).unsupported, true);
  assert.deepEqual(calls, [id]);
  seasons = () => null;
  const unavailable = await handler({}, id);
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.results.length, 0);
  assert.equal(unavailable.partial, undefined);
});

for (const unavailable of [false, true]) test(`history offers a retry only on lookup failure, unavailable=${unavailable}`, async () => {
  let attempts = 0;
  const ui = mountHistoryNavigation({
    getWatchHistory: async () => ({ success: true, results: [{ series_id: '7500000000000000001', series_title: '单独一部剧' }] }),
    findSeriesSeasons: async () => {
      if (++attempts === 1) return { official: true, partial: true, results: [] };
      return { official: true, results: [], unavailable };
    },
  });
  await ui.flush();
  const node = label => ui.find(element => element.children.includes(label));
  await node('系列剧').props.onClick();
  await ui.flush();
  assert.ok(node('系列剧查询失败。'));
  await node('重新查找').props.onClick();
  await ui.flush();
  assert.ok(node(unavailable ? '暂无系列剧信息。' : '暂未找到其他季。'));
  assert.equal(node('系列剧查询失败。'), undefined);
  assert.equal(node('重新查找'), undefined);
  ui.unmount();
});

for (const change of ['leave', 'return', 'unmount', 'repeat']) test(`history missing-archive resolution respects ${change}`, async () => {
  const ui = mountHistoryNavigation(); await ui.flush();
  const opening = ui.open(); await ui.flush();
  let repeated;
  if (change === 'repeat') repeated = ui.open();
  else if (change === 'unmount') ui.unmount();
  else { ui.props.active = false; await ui.flush(); if (change === 'return') { ui.props.active = true; await ui.flush(); } }
  ui.pending.resolve(); await opening; await repeated;
  assert.deepEqual(ui.calls, change === 'repeat' ? [['play', 'B'], ['resolve'], ['play', 'B'], ['ack']] : [['play', 'B'], ['resolve']]);
});

for (const returnToHistory of [false, true]) test(`history resolve before passive cleanup cannot retry: return=${returnToHistory}`, async () => {
  const ui = mountHistoryNavigation(); await ui.flush();
  const opening = ui.open(); await ui.flush();
  ui.props.active = false; ui.commit(false);
  if (returnToHistory) { ui.props.active = true; ui.commit(false); }
  ui.pending.resolve(); await opening;
  assert.deepEqual(ui.calls, [['play', 'B'], ['resolve']], 'a committed page change must invalidate resolution before passive effects run');
  await ui.flush(); ui.unmount();
});

test('history acknowledges successful retry even when playback navigation commits immediately', async () => {
  const ui = mountHistoryNavigation(); await ui.flush();
  const opening = ui.open(); await ui.flush();
  ui.api.playSeries = async payload => {
    ui.calls.push(['play', payload.seriesId]);
    ui.props.active = false; ui.commit(false);
    return { success: true };
  };
  ui.pending.resolve(); await opening;
  assert.deepEqual(ui.calls, [['play', 'B'], ['resolve'], ['play', 'B'], ['ack']]);
  await ui.flush(); ui.unmount();
});
