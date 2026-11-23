const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccountController } = require('./account-controller');

test('account controller scopes resume positions and registers the existing IPC contract', async () => {
  const handlers = new Map();
  const sent = [];
  let navigation;
  let signedIn = false;
  let partitionCleared = 0, partitionProxied = 0;
  const partition = {
    clearStorageData: async () => { partitionCleared++; },
    fetch: async () => ({ status: 200, headers: new Map(), text: async () => '' }),
  };
  const service = {
    async status() { return { success: true, signedIn }; },
    activeAccountId() { return signedIn ? '42' : ''; },
    async startLogin() { signedIn = true; return { success: true, loginId: 'login' }; },
    async pollLogin() { return { success: true, status: 'signed-in' }; },
    row(id) { return id === '1000001' ? { episode_id: 'v1', vid_index: 1, currentTime: 12, updatedAt: 1 } : null; },
    async refreshHistory() { return { success: true }; },
    async history() { return { success: true, rows: [] }; },
    cancelLogin() {},
  };
  const entries = [{ series_id: '1000001', series_title: 'Fixture', episodes: [{ vid: 'v1', vid_index: 1 }] }];
  const controller = createAccountController({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => '/fixture' },
    session: {
      fromPartition: () => partition,
      defaultSession: { cookies: { get: async () => [], remove: async () => {} } },
    },
    safeStorage: {},
    platform: 'darwin',
    BrowserWindow: class {},
    createAccountService: options => {
      assert.equal(options.local, true);
      assert.match(options.filePath, /account-session\.json$/);
      return service;
    },
    safeMessage: error => error.message,
    hongguo: { fetchEpisodeList: async () => entries[0] },
    getSeriesRegistry: () => entries,
    upsertSeriesRegistry: () => entries[0],
    saveSeriesRegistry() {},
    navigateToPlayer: value => { navigation = value; return { success: true }; },
    send: (...value) => sent.push(value),
    applyProxyToSession: async session => {
      assert.equal(session, partition);
      partitionProxied++;
    },
  });

  assert.equal((await handlers.get('get-account-status')({})).success, true);
  assert.deepEqual(await handlers.get('play-account-history')({}, '1000001'), { success: true });
  assert.deepEqual(navigation, { seriesId: '1000001', vidIndex: 1, resume: true });
  assert.deepEqual(controller.takeResumePosition('1000001'), { episode_id: 'v1', vid_index: 1, currentTime: 12, updatedAt: 1 });
  assert.equal(controller.takeResumePosition('1000001'), null);
  assert.equal((await handlers.get('start-account-login')({})).success, true);
  assert.equal(partitionProxied, 1);
  assert.ok(partitionCleared >= 1, 'starting a new login must clear the dedicated partition cookies');
  await handlers.get('poll-account-login')({}, 'login');
  assert.ok(sent.some(([name, payload]) => name === 'account-updated' && payload.signedIn === true));
  assert.equal(handlers.has('test-account-progress-sync'), false);
});

test('automatic sync uses newer timestamps, owns its queued writes and resumes the exact cloud episode', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const handlers = new Map();
  const writes = [];
  const playback = {};
  const series = id => ({ series_id: id, series_title: `剧集 ${id}`,
    episodes: [{ vid: '2000001', vid_index: 1 }, { vid: '2000002', vid_index: 2 }] });
  const entries = ['1000001', '1000002', '1000003'].map(series);
  const cloud = { series_id: '1000001', series_title: entries[0].series_title,
    episode_id: '2000001', vid_index: 1, currentTime: 25, updatedAt: 300 };
  let accountId = '';
  let navigation;
  let resolveCycle;
  let pullCount = 0;
  const cycle = new Promise(resolve => { resolveCycle = resolve; });
  const service = {
    async status() { return { success: true, signedIn: !!accountId }; },
    activeAccountId: () => accountId,
    async refreshHistory() { pullCount++; return { success: true }; },
    row: id => id === cloud.series_id ? cloud : null,
    cachedHistory: () => [cloud],
    localHistory: () => ({ accountId: '42', rows: [cloud] }),
    async uploadProgress(owner, position, baseline, options) {
      writes.push({ owner, id: position.series_id, baseline, allowed: options.shouldSend() });
      if (writes.length > 1) return;
      const newPosition = { vid_index: 1, updatedAt: position.updatedAt, currentTime: 33 };
      playback[position.series_id] = controller.trackPlayback(entries[1], newPosition, { duration: 90 });
      assert.equal(options.shouldSend(), false);
    },
    async logout() {
      assert.equal(writes.length, 2, 'final pending checkpoint must upload before credentials are cleared');
      accountId = ''; return { success: true };
    },
  };
  const controller = createAccountController({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => '/fixture' },
    session: {
      fromPartition: () => ({ clearStorageData: async () => {} }),
      defaultSession: { cookies: { get: async () => [] } },
    },
    createAccountService: () => service,
    safeMessage: error => error.message,
    getSeriesRegistry: () => entries,
    navigateToPlayer: value => { navigation = value; return { success: true }; },
    send(name, payload) { if (name === 'account-progress-sync-status') resolveCycle(payload); },
    progressSync: { getPlayback: () => playback, updatePlayback: change => change(playback) },
  });
  t.after(() => controller.stopProgressSync());
  await handlers.get('get-account-status')({});
  const oldPosition = { vid_index: 2, updatedAt: 100, currentTime: 60 };
  assert.equal(controller.trackPlayback(entries[0], oldPosition, { duration: 90 }), oldPosition);
  accountId = '99';
  playback['1000003'] = controller.trackPlayback(entries[2], oldPosition, { duration: 90 });
  accountId = '42';
  for (const entry of entries.slice(0, 2)) {
    playback[entry.series_id] = controller.trackPlayback(entry, oldPosition, { duration: 90 });
  }
  controller.startProgressSync();
  const timeout = setTimeout(() => resolveCycle({ error: 'Automatic sync timed out' }), 1000);
  try { assert.deepEqual(await cycle, { error: '' }); } finally { clearTimeout(timeout); }
  assert.equal(pullCount, 1);
  assert.deepEqual(writes, [{ owner: '42', id: '1000002', baseline: null, allowed: true }]);
  assert.equal(playback['1000001'].accountSyncPending['42'], undefined);
  assert.equal(playback['1000002'].accountSyncPending['42'].currentTime, 33);
  assert.equal(playback['1000003'].accountSyncPending['99'].currentTime, 60);
  assert.deepEqual(await handlers.get('play-account-history')({}, '1000001', { merged: true }), { success: true });
  assert.deepEqual(navigation, { seriesId: '1000001', vidIndex: 1, resume: true });
  assert.deepEqual(controller.takeResumePosition('1000001'), { episode_id: '2000001', vid_index: 1, currentTime: 25, updatedAt: 300 });
  playback['1000001'] = { ...oldPosition, updatedAt: 400 };
  assert.deepEqual(await handlers.get('play-account-history')({}, '1000001', { merged: true }), { success: true });
  assert.equal(navigation.vidIndex, 2);
  assert.equal(controller.takeResumePosition('1000001'), null);
  assert.equal((await handlers.get('logout-account')({})).syncIncomplete, false);
  assert.equal(controller.mergedHistory([])[0].currentTime, 25);
  assert.equal(playback['1000002'].currentTime, 33, 'signing out preserves the desktop checkpoint');
  delete playback['1000001'];
  assert.deepEqual(await handlers.get('play-account-history')({}, '1000001', { merged: true }), { success: true });
  assert.deepEqual(controller.takeResumePosition('1000001'), { episode_id: '2000001', vid_index: 1, currentTime: 25, updatedAt: 300 });
  accountId = '42';
  t.mock.timers.tick(29999);
  assert.equal(pullCount, 2);
  t.mock.timers.tick(1);
  await controller.syncProgress();
  assert.equal(pullCount, 3, 'the periodic pull runs after 30 seconds even with no new playback');
});

test('the isolated sync action reads a newer cloud checkpoint into local storage after confirmation', async () => {
  const handlers = new Map();
  const calls = [];
  const series = { series_id: '1000001', series_title: '测试短剧',
    episodes: [{ vid: '2000001', vid_index: 1 }, { vid: '2000002', vid_index: 2 }] };
  const cloud = { series_id: '1000001', episode_id: '2000002', vid_index: 2, currentTime: 25, updatedAt: 1800000000000 };
  let confirmed = false;
  const service = {
    async status() { return { success: true, signedIn: true }; },
    activeAccountId: () => '42',
    row: () => cloud,
    async refreshHistory() { calls.push('read'); },
    async history({ refresh }) {
      if (refresh) calls.push('refresh');
      return { success: true, signedIn: true, results: [cloud] };
    },
    async uploadProgressForTest() { throw new Error('较新的云端记录不应被覆盖'); },
  };
  const controller = createAccountController({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => '/fixture' },
    session: {
      fromPartition: () => ({ clearStorageData: async () => {} }),
      defaultSession: { cookies: { get: async () => [] } },
    },
    createAccountService: () => service,
    safeMessage: error => error.message,
    getSeriesRegistry: () => [series],
    progressTest: {
      allowed: event => event.trusted === true,
      confirm: async ({ direction }) => { assert.equal(direction, 'download'); return confirmed; },
      saveLocal: (local, remote, episode) => {
        assert.equal(local.accountId, '42');
        assert.equal(remote.currentTime, 25);
        assert.equal(episode, 2);
        calls.push('save');
      },
    },
  });
  await handlers.get('get-account-status')({});
  controller.recordProgressForTest(series, { vid_index: 1, updatedAt: 1790000000000, currentTime: 12 }, { duration: 90 });
  const sync = handlers.get('test-account-progress-sync');
  assert.equal((await sync({})).success, false);
  assert.equal((await sync({ trusted: true })).status, 'cancelled');
  assert.deepEqual(calls, ['read']);
  confirmed = true;
  assert.equal((await sync({ trusted: true })).status, 'downloaded');
  assert.deepEqual(calls, ['read', 'read', 'read', 'save']);

  controller.recordProgressForTest(series, { vid_index: 1, updatedAt: 1790000000000, currentTime: 12 }, { duration: 90 });
  const refresh = handlers.get('get-account-history');
  const regularRead = await refresh({ trusted: true }, { refresh: true });
  assert.equal(regularRead.importedTestProgress, undefined);
  const isolatedRefresh = await refresh({ trusted: true }, { refresh: true, importTestProgress: true });
  assert.equal(isolatedRefresh.importedTestProgress, true);
  assert.deepEqual(isolatedRefresh.results, [cloud]);
  assert.deepEqual(calls, ['read', 'read', 'read', 'save', 'refresh', 'refresh', 'save']);
  const repeat = await refresh({ trusted: true }, { refresh: true, importTestProgress: true });
  assert.equal(repeat.importedTestProgress, undefined);
  assert.equal(calls.filter(call => call === 'save').length, 2);
});
