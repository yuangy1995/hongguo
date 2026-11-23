const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { gunzipSync } = require('node:zlib');
const {
  createAccountService, secureSessionStore, parseQr, parseHistory,
} = require('./account-session');
const { preserveLargeJsonIntegers } = require('./app-source');
const { chooseAccountProgress, verifyAccountProgressWrite, mergeAccountWatchHistory } = require('./account-progress-sync');

function webPayload(data) {
  return { status: 200, headers: {}, data: JSON.stringify({ message: 'success', data }) };
}

function fakeEncryption() {
  const key = Buffer.from('hongguo-account-fixture');
  const transform = value => Buffer.from(value).map((byte, index) => byte ^ key[index % key.length]);
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => transform(Buffer.from(value, 'utf8')),
    decryptString: value => transform(value).toString('utf8'),
  };
}

test('account library confirms mobile favorites, exact episode likes and reservations using signed requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-account-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seriesId = '7481000000000000001';
  const episodeId = '7481000000000000002';
  const otherEpisodeId = '7481000000000000003';
  const reservationId = '7481000000000000004';
  const releasedItemId = '7481000000000000005';
  const fallbackSeriesId = '7481000000000000006';
  const fixtureCover = 'https://example.com/poster.jpg';
  const identity = { device_id: '123456789', iid: '987654321', cdid: '12345678-1234-1234-1234-123456789012' };
  const liked = new Set([otherEpisodeId]);
  let favorite = false, reserved = false, writes = 0, activeCookie, delayedRead, releaseRead;
  let rejectRemove = false, rejectReleasedRead = false;
  const released = new Set([releasedItemId, fallbackSeriesId]);
  const favoriteRow = { series_id: seriesId, series_title: '测试剧', cover: fixtureCover };
  const upcomingRow = {
    item_id: reservationId, name: '待上线测试剧', is_online: false,
    sub_title_list: [{ content: '<span>12月上线</span>' }], expected_rec_text: '即将上线，火速预约',
    schedule_publish_time: Date.UTC(2026, 11, 14, 16) / 1000,
  };
  const upcomingRows = [upcomingRow,
    { item_id: '1007', expected_rec_text: '12月18日上线', sub_info: '即将上线，火速预约' },
    { item_id: '1008', expected_rec_text: '即将上线', schedule_publish_time: upcomingRow.schedule_publish_time },
    { item_id: '1009', expected_publish_time: String(Date.UTC(2026, 11, 9, 16)) },
    { item_id: '1010', expected_rec_text: '815万期待', sub_info: '即将上线，火速预约' },
    { item_id: '1011', schedule_publish_time: 0, expected_publish_time: -1 },
    { item_id: '1012', sub_title_list: [{ content: '即将上线' }], expected_publish_time: upcomingRow.schedule_publish_time },
    { item_id: '1013', sub_title_list: [{ content: '11月30日上线' }], expected_publish_time: Date.UTC(2026, 11, 15, 10, 45) },
    { item_id: '1014', sub_title_list: [{ content: '12月上线' }] },
    { item_id: '1015', sub_title_list: [{ content: '即将上线' }], expected_publish_time: Date.UTC(2026, 10, 20, 16) / 1000 },
    { item_id: '1016', sub_title_list: [{ content: '即将上线' }], expected_publish_time: Date.UTC(2026, 10, 19, 16) / 1000 },
    { item_id: '1017', schedule_publish_time: Date.UTC(2026, 10, 19, 16) / 1000, expected_publish_time: upcomingRow.schedule_publish_time },
    { item_id: '1018', schedule_publish_time: Date.UTC(2026, 10, 20, 10, 30) / 1000 },
    { item_id: '1019', expected_rec_text: '明天上线', expected_publish_time: Date.UTC(2026, 10, 23, 11, 45) },
  ];
  const ok = data => ({ code: 0, data });
  const service = createAccountService({
    filePath: path.join(root, 'account.json'), local: true,
    now: () => Date.UTC(2026, 10, 22, 12),
    webRequest: async () => webPayload({ user_id_str: '1234567', name: '账号测试' }),
    identityRequest: async () => identity,
    accountRequest: async (address, options, _deadline, signal) => {
      assert.equal(options.headers.Cookie, activeCookie);
      assert.ok(options.headers['x-gorgon']);
      assert.ok(options.preserveLargeIntegerFields.includes('series_id'));
      const url = new URL(address);
      assert.equal(url.hostname, 'api5-normal-sinfonlinea.fqnovel.com');
      if (options.method === 'POST') {
        writes++;
        assert.ok(options.headers['x-ss-stub']);
        const gzip = options.headers['Content-Encoding'] === 'gzip';
        const raw = (gzip ? gunzipSync(options.data) : options.data).toString();
        const body = JSON.parse(preserveLargeJsonIntegers(raw, ['item_id']));
        if (url.pathname.endsWith('/bookshelf/video/update/v1/')) {
          const [entry] = body.update_bookshelf_video_list;
          assert.equal(entry.book_id, seriesId);
          assert.equal(entry.book_type, 2);
          favorite = entry.video_shelf_operate_type === 0;
        } else if (url.pathname === '/novel/articleapi/do_action/v1/') {
          assert.equal(body.object_id, episodeId);
          assert.equal(body.business_param.video_id, seriesId);
          if (body.action_type === 3) liked.add(episodeId);
          else { assert.equal(body.action_type, 4); liked.delete(episodeId); }
        } else if (url.pathname === '/reading/user/subscribe/delete/v') {
          assert.equal(gzip, true);
          assert.equal(body.is_online, true);
          assert.equal(body.tab_type, 13);
          assert.equal(body.all_select, false);
          assert.deepEqual(body.not_del_item_id, []);
          assert.equal(body.item_id.length, 1);
          assert.ok(released.has(body.item_id[0]));
          if (rejectRemove) return { code: 103 };
          released.delete(body.item_id[0]);
        } else {
          assert.equal(url.pathname, '/reading/bookapi/search/uncover_subscribe/v');
          assert.equal(gzip, true);
          assert.ok(raw.includes(`"item_id":${reservationId}`));
          assert.equal(body.item_id, reservationId);
          reserved = body.op_type === 1;
        }
        return ok({});
      }
      if (url.pathname.endsWith('/bookshelf/video/info/v1/')) {
        if (delayedRead) {
          await new Promise(resolve => { releaseRead = resolve; });
          assert.equal(signal.aborted, true);
        }
        return ok({ video_shelf_info: favorite ? [favoriteRow] : null });
      }
      if (url.pathname === '/reading/ugc/action/mget/v') {
        assert.equal(url.searchParams.get('action_type'), '3');
        const entries = [...liked];
        const index = url.searchParams.get('offset') === '0' ? 0 : 1;
        return ok({ has_more: index === 0 && entries.length > 1, next_offset: 1,
          mixed_data_list: entries.slice(index, index + 1).map(vid => ({
            video_data: { vid, series_id: seriesId, vid_index: vid === episodeId ? 3 : 4, video_detail: favoriteRow },
          })) });
      }
      assert.equal(url.pathname, '/reading/user/subscribe/list/v1/');
      if (url.searchParams.get('tab_type') === '5') return ok({ subscribe_items: upcomingRows });
      assert.equal(url.searchParams.get('tab_type'), '13');
      if (rejectReleasedRead && url.searchParams.get('is_online') === 'true') return { code: 103 };
      return ok({ has_more: false, subscribe_items: url.searchParams.get('is_online') === 'true'
        ? [...released].map(key => key === releasedItemId
          ? { item_id: releasedItemId, is_online: true, subscribe_data: { video_detail: {
            series_id: seriesId, series_title: '已上线测试剧',
            series_cover: 'https://p3-reading-sign.fqnovelpic.com/fixture/poster~tplv-test.heic?signature=fixture',
          } } }
          : { item_id: '0', is_online: true, subscribe_data: { ...favoriteRow, series_id: fallbackSeriesId,
            video_detail: { series_title: '已上线封面回退测试剧' },
          } })
        : reserved ? [upcomingRow] : [] });
    },
  });
  const login = async cookie => {
    activeCookie = cookie;
    await service.completeWebLogin(cookie);
    return service.librarySessionId();
  };
  const first = await login('sessionid=fixture-a');
  assert.deepEqual(await service.readLibrary(first, 'favorite'), []);
  const save = { kind: 'favorite', seriesId, value: true };
  assert.equal((await service.changeLibrary(first, save)).entry.title, '测试剧');
  assert.equal((await service.changeLibrary(first, save)).entry.id, seriesId);
  assert.equal(writes, 1, 'a favorite already on the account needs no duplicate write');
  const like = { kind: 'like', seriesId, episodeId, value: true };
  const added = await service.changeLibrary(first, like);
  assert.deepEqual(added.items.map(item => item.episodeId), [otherEpisodeId, episodeId]);
  assert.equal(added.entry.episodeIndex, 3);
  assert.equal((await service.changeLibrary(first, { ...like, value: false })).entry, null);
  assert.deepEqual((await service.readLibrary(first, 'like')).map(item => item.episodeId), [otherEpisodeId]);
  const upcoming = await service.readLibrary(first, 'upcoming');
  assert.equal(upcoming[0].reservationId, reservationId);
  assert.deepEqual(upcoming.map(item => item.scheduled), [
    '预计12月15日上线', '12月18日上线', '预计12月15日上线', '预计12月10日上线', '即将上线', '',
    '预计12月15日上线', '预计12月15日 18:45上线', '12月上线', '原预计11月21日上线', '原预计11月20日上线', '预计12月15日上线',
    '原预计11月20日 18:30上线', '预计11月23日 19:45上线',
  ]);
  const reserve = { kind: 'reservation', reservationId, value: true };
  const confirmedReservation = await service.changeLibrary(first, reserve);
  assert.equal(confirmedReservation.entry.reservationId, reservationId);
  assert.equal(confirmedReservation.entry.scheduled, '预计12月15日上线');
  assert.deepEqual(confirmedReservation.pendingItems.map(item => item.reservationId), [reservationId]);
  rejectReleasedRead = true;
  await assert.rejects(service.readLibrary(first, 'reservation'), /未确认/);
  assert.deepEqual((await service.readLibrary(first, 'pendingReservations')).map(item => item.reservationId), [reservationId]);
  rejectReleasedRead = false;
  const reservations = await service.readLibrary(first, 'reservation');
  assert.deepEqual(reservations.map(item => item.online), [false, true, true]);
  assert.equal(reservations[1].cover, 'https://p3-novel.byteimg.com/fixture/poster~tplv-shrink:320:0.webp');
  assert.equal(reservations[2].cover, fixtureCover);
  const removeReleased = { kind: 'reservation', seriesId, reservationId: releasedItemId, online: true, value: false };
  rejectRemove = true;
  await assert.rejects(service.changeLibrary(first, removeReleased), /未确认/);
  assert.ok(released.has(releasedItemId));
  rejectRemove = false;
  assert.equal((await service.changeLibrary(first, removeReleased)).entry, null);
  assert.equal((await service.changeLibrary(first, { ...removeReleased, seriesId: fallbackSeriesId, reservationId: '' })).entry, null);
  assert.deepEqual((await service.readLibrary(first, 'reservation')).map(item => item.reservationId), [reservationId]);
  assert.equal((await service.changeLibrary(first, { ...reserve, value: false })).entry, null);
  assert.deepEqual(await service.readLibrary(first, 'reservation'), []);
  delayedRead = true;
  const staleRead = assert.rejects(service.readLibrary(first, 'favorite'), /账号已变更/);
  while (!releaseRead) await new Promise(resolve => setImmediate(resolve));
  await service.logout();
  assert.equal(service.librarySessionId(), '');
  releaseRead();
  await staleRead;
  delayedRead = false;
  const second = await login('sessionid=fixture-a');
  assert.notEqual(second, first);
  await assert.rejects(service.changeLibrary(first, { ...save, value: false }), /账号已变更/);
  assert.deepEqual((await service.readLibrary(second, 'favorite')).map(item => item.id), [seriesId]);
  assert.equal((await service.changeLibrary(second, { ...save, value: false })).entry, null);
});

test('account history parser keeps current APP rows with display metadata', () => {
  const rows = parseHistory({
    message: 'SUCCESS',
    data: { data_list: [
      { book_id: '1001', book_id_str: '1001', book_name: '春日来信', thumb_url: 'https://p9-reading-sign.fqnovelpic.com/novel-pic/cover~tplv-shrink:1200:0.heic?x=1', vid: '9001', vid_index: 3, current_play_position: 45000, duration: 90000, episode_cnt: 24, read_timestamp_ms: 1700000000000 },
      { book_id: '1002', book_name: '旧剧', vid: '9002', vid_index: 1, read_timestamp_ms: 1800000000000 },
      { book_id: 'bad', vid: '9003' },
      { book_id: '1003', book_name: '已删除', vid: '9004', is_delete: true },
    ] },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].series_id, '1002');
  assert.equal(rows[1].currentTime, 45);
  assert.equal(rows.find(row => row.series_id === '1001').series_title, '春日来信');
  assert.equal(rows.find(row => row.series_id === '1001').total, 24);
  assert.equal(rows.find(row => row.series_id === '1001').cover, 'https://p3-novel.byteimg.com/novel-pic/cover~tplv-shrink:320:0.webp');
});

test('account history keeps all distinct dramas returned by the source', () => {
  const records = Array.from({ length: 73 }, (_, index) => ({
    book_id_str: String(1000 + index),
    vid: String(9000 + index),
    vid_index: 1,
    read_timestamp_ms: 1700000000000 + index,
  }));
  const newest = { ...records[0], vid_index: 3, read_timestamp_ms: 1800000000000 };
  const results = parseHistory({ code: 0, data: { data_list: [...records, newest] } });
  assert.equal(results.length, 73);
  assert.equal(results[0].series_id, records[0].book_id_str);
  assert.equal(results[0].vid_index, 3);
});

test('explicit session expiry survives restart and logout retains the downloaded history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-history-offline-'));
  const filePath = path.join(root, 'session.json');
  const historyFilePath = path.join(root, 'history.json');
  let failures = 0;
  let status = 200;
  try {
    const serviceOptions = {
      filePath, historyFilePath, local: true,
      webRequest: async () => webPayload({ user_id_str: '42', name: '测试账号' }),
      identityRequest: async () => ({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' }),
      accountRequest: async () => {
        if (status !== 200) throw Object.assign(new Error(`HTTP ${status}`), { status });
        return { code: 0, data: { data_list: [{ book_id_str: '1000001', vid: '2000002', vid_index: 2,
          current_play_position: 23000, read_timestamp_ms: 1800000000000, book_name: '测试短剧' }] } };
      },
      onAccountExpired: () => { failures++; },
    };
    const service = createAccountService(serviceOptions);
    await service.completeWebLogin('sessionid=fixture');
    assert.equal((await service.refreshHistory()).results[0].currentTime, 23);
    status = 503;
    await assert.rejects(service.refreshHistory(), /503/);
    assert.equal((await service.status()).signedIn, true);
    status = 401;
    assert.equal((await service.refreshHistory()).expired, true);
    assert.equal(failures, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { expired: true });
    const reopened = createAccountService(serviceOptions);
    assert.equal((await reopened.status()).expired, true);
    assert.equal(reopened.localHistory().rows[0].currentTime, 23);
    await reopened.logout();
    assert.equal((await reopened.status()).expired, undefined);
    const signedOut = createAccountService(serviceOptions);
    assert.equal((await signedOut.status()).signedIn, false);
    assert.equal(signedOut.localHistory().rows[0].currentTime, 23);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('merged history deduplicates by series and keeps the newest viewing event, including rewatches', () => {
  const local = [
    { series_id: '1000001', vid_index: 8, currentTime: 42, updatedAt: 200, unreadEpisodes: 2, cover: 'local.jpg' },
    { series_id: '1000002', vid_index: 2, currentTime: 34, updatedAt: 400 },
    { series_id: 'xifan:fixture:drama', updatedAt: 150 },
  ];
  const cloud = [
    { series_id: '1000001', episode_id: '9000003', vid_index: 3, currentTime: 17, updatedAt: 300, cover: '' },
    { series_id: '1000002', episode_id: '9000007', vid_index: 7, currentTime: 53, updatedAt: 380 },
    { series_id: '1000003', episode_id: '9000010', vid_index: 10, currentTime: 30, duration: 30, total: 10, updatedAt: 510 },
  ];
  const playback = { '1000003': { accountHidden: { '99': 520 } } };
  const merged = mergeAccountWatchHistory(local, cloud, playback, '42');
  assert.deepEqual(merged.map(row => row.series_id), ['1000003', '1000002', '1000001', 'xifan:fixture:drama']);
  assert.ok(merged[0].account && merged[0].completed && !merged[0].hasLocal);
  assert.equal(merged[1], local[1]);
  assert.deepEqual(merged[2], { ...local[0], ...cloud[0], cover: 'local.jpg', account: true, hasLocal: true, total: 0, completed: false });
  assert.ok(!mergeAccountWatchHistory(local, cloud, playback, '99').some(row => row.series_id === '1000003'));
  assert.equal(mergeAccountWatchHistory(local, cloud, playback, ''), local);
});

test('concurrent history refreshes share pagination and a looping page does not replace the last good snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-account-pages-'));
  const offsets = [];
  let repeat = false;
  try {
    const pages = [0, 1].map(page => Array.from({ length: 55 }, (_, index) => ({
      book_id_str: String(1000000 + page * 55 + index), vid: String(2000000 + page * 55 + index),
      vid_index: 1, read_timestamp_ms: 1800000000000 + index,
    })));
    const service = createAccountService({
      filePath: path.join(root, 'session.json'), local: true,
      webRequest: async () => webPayload({ user_id_str: '42', name: '测试账号' }),
      identityRequest: async () => ({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' }),
      accountRequest: async url => {
        const { searchParams } = new URL(url);
        const offset = searchParams.get('offset');
        offsets.push(offset);
        assert.equal(searchParams.get('limit'), '0');
        return offset === '0' || repeat
          ? { code: 0, data: { data_list: pages[0], next_offset: Number(offset) + 55, has_more: true } }
          : { code: 0, data: { data_list: pages[1], has_more: false } };
      },
    });
    await service.completeWebLogin('sessionid=fixture');
    const first = service.refreshHistory();
    assert.equal(first, service.refreshHistory());
    assert.equal((await first).results.length, 110);
    assert.deepEqual(offsets, ['0', '55']);
    repeat = true;
    await assert.rejects(service.refreshHistory(), /云端观看记录未读取完整/);
    assert.deepEqual(offsets, ['0', '55', '0', '55']);
    assert.equal((await service.history()).results.length, 110);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sync chooses the newer playback event even if it is a rewatch of an earlier episode', () => {
  const local = { series_id: '1000001', episode_id: '2000001', vid_index: 1, currentTime: 11, updatedAt: 1900000000000 };
  const cloud = { ...local, episode_id: '2000009', vid_index: 9, currentTime: 31, updatedAt: 1800000000000 };
  assert.equal(chooseAccountProgress(local, cloud), 'upload');
  assert.equal(chooseAccountProgress(local, { ...cloud, updatedAt: 2000000000000 }), 'download');
  assert.equal(chooseAccountProgress(local, { ...local, currentTime: 11.5 }), 'unchanged');
  assert.throws(() => chooseAccountProgress(local, { ...cloud, updatedAt: local.updatedAt }), /更新时间相同/);
  assert.throws(() => verifyAccountProgressWrite({ message: 'success' }), /未确认写入/);
  assert.throws(() => verifyAccountProgressWrite({ code: 0, data: { error_code: 100103 } }), /未确认写入/);
});

test('single progress sync checks the baseline, sends both writes and reads the exact record back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-progress-test-'));
  const seriesId = '7705824595416190014', episodeId = '7705826348597529625';
  const pos = { series_id: seriesId, episode_id: episodeId, vid_index: 3, currentTime: 28.5,
    duration: 120, total: 80, updatedAt: 1790000000000 };
  let cloud = { series_id: seriesId, episode_id: episodeId, vid_index: 3, currentTime: 8, updatedAt: 1780000000000 };
  let previousReadback;
  const posts = [];
  try {
    const service = createAccountService({
      filePath: path.join(root, 'session.json'), local: true,
      webRequest: async () => webPayload({ user_id_str: '42', name: '独立测试账号' }),
      identityRequest: async () => ({
        device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003',
      }),
      accountRequest: async (url, req) => {
        const route = new URL(url).pathname;
        if (req.method === 'GET') {
          const latest = previousReadback || cloud;
          previousReadback = null;
          return { code: 0, data: { data_list: [{
            book_id_str: seriesId, vid: episodeId, vid_index: latest.vid_index,
            current_play_position: latest.currentTime * 1000, read_timestamp_ms: latest.updatedAt,
          }] } };
        }
        assert.equal(req.method, 'POST');
        assert.ok(req.headers['x-ss-stub']);
        const body = req.data.toString('utf8');
        posts.push(route);
        if (route.endsWith('read_history/update/v')) {
          assert.ok(body.includes(`"book_id":${seriesId}`));
          assert.ok(body.includes(`"vid":${episodeId}`));
        } else {
          assert.ok(body.includes(`"book_id":"${seriesId}"`));
          assert.ok(body.includes('"current_play_time":28500'));
          previousReadback = cloud;
          cloud = pos;
        }
        return { code: 0 };
      },
    });
    await service.completeWebLogin('sessionid=fixture');
    await assert.rejects(service.uploadProgressForTest('99', pos, cloud), /测试账号已变更/);
    await assert.rejects(service.uploadProgressForTest('42', pos, { ...cloud, updatedAt: 1 }), /云端进度已变更/);
    await assert.rejects(service.uploadProgress('42', pos, cloud, { allowNew: true, shouldSend: () => false }), /本机观看进度已更新/);
    assert.equal(posts.length, 0);
    const result = await service.uploadProgressForTest('42', pos, cloud);
    assert.equal(result.episode_id, episodeId);
    assert.equal(result.currentTime, 28.5);
    assert.deepEqual(posts, ['/reading/bookapi/read_history/update/v', '/reading/bookapi/read_progress/upload/v']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('large account episode IDs stay exact strings', () => {
  const raw = '{"vid":7390123456789012345,"other":7390123456789012345}';
  const preserved = preserveLargeJsonIntegers(raw, ['vid']);
  assert.equal(JSON.parse(preserved).vid, '7390123456789012345');
  assert.equal(typeof JSON.parse(preserved).other, 'number');
});

test('QR payload accepts server image data without exposing cookies', () => {
  const qr = parseQr({ message: 'success', data: { token: 'fixture-token', qrcode: '[image omitted]', expire_time: 180 } });
  assert.equal(qr.token, 'fixture-token');
  assert.match(qr.image, /^data:image\/png;base64,/);
  assert.equal(qr.expiresIn, 180);
});

test('encrypted session store never writes the raw cookie', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-store-'));
  const file = path.join(root, 'account-session.bin');
  try {
    const store = secureSessionStore({ filePath: file, safeStorage: fakeEncryption() });
    const session = { cookie: 'sessionid=private-fixture', deviceId: '1', installId: '2', cdid: '00000000-0000-4000-8000-000000000003' };
    store.save(session);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('private-fixture'));
    assert.deepEqual(store.load(), session);
    store.clear();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session store refuses basic_text backend, stays compatible without the API', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-backend-'));
  const file = path.join(root, 'account-session.bin');
  const session = { cookie: 'sessionid=private-fixture' };
  try {
    // Android 等平台没有 getSelectedStorageBackend：仍按 isEncryptionAvailable 工作。
    const legacy = secureSessionStore({ filePath: file, safeStorage: fakeEncryption() });
    legacy.save(session);
    assert.equal(legacy.load().cookie, session.cookie);

    const basicText = { ...fakeEncryption(), getSelectedStorageBackend: () => 'basic_text' };
    const store = secureSessionStore({ filePath: file, safeStorage: basicText });
    assert.throws(() => store.save(session), /安全存储不可用/);
    assert.throws(() => store.load(), /安全存储不可用/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Mac local login saves, restores and clears JSON without secure storage or legacy reads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-local-'));
  const filePath = path.join(root, 'account-session.json');
  const legacy = path.join(root, 'account-session.bin');
  const options = {
    filePath,
    local: true,
    safeStorage: new Proxy({}, { get() { throw new Error('Mac account must not consult secure storage'); } }),
    webRequest: async () => webPayload({ user_id_str: '42', name: '本地账号' }),
  };
  const fixture = 'sessionid=local-fixture';
  try {
    fs.writeFileSync(legacy, 'synthetic old session');
    const service = createAccountService(options);
    assert.equal((await service.status()).signedIn, false);
    const login = await service.completeWebLogin(fixture);
    assert.equal(login.storageWarning, '');
    assert.equal(login.status, 'signed-in');
    assert.ok(!JSON.stringify(login).includes(fixture));
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).cookie, fixture);
    if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    const restored = createAccountService(options);
    assert.equal((await restored.status()).account.nickname, '本地账号');
    await restored.logout();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'synthetic old session');
    fs.writeFileSync(filePath, 'invalid-local-fixture');
    const invalid = await createAccountService(options).status();
    assert.equal(invalid.signedIn, false);
    assert.match(invalid.error, /本机登录信息无效/);
    assert.ok(!JSON.stringify(invalid).includes('invalid-local-fixture'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restore returns a cached profile before background session verification finishes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-cache-'));
  const file = path.join(root, 'account-session.bin');
  const encryption = fakeEncryption();
  let verificationFinished = false;
  try {
    secureSessionStore({ filePath: file, safeStorage: encryption }).save({
      cookie: 'sessionid=private-fixture',
      deviceId: '7000000000000000001',
      installId: '7000000000000000002',
      cdid: '00000000-0000-4000-8000-000000000003',
      profile: { id: '42', nickname: '缓存账号' },
    });
    const service = createAccountService({
      filePath: file, safeStorage: encryption,
      webRequest: async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        verificationFinished = true;
        throw new Error('temporary network failure');
      },
    });
    const status = await service.status();
    assert.equal(status.signedIn, true);
    assert.equal(status.account.nickname, '缓存账号');
    assert.equal(verificationFinished, false);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(verificationFinished, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('website QR flow verifies account, loads APP history and keeps credentials out of renderer data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-flow-'));
  const file = path.join(root, 'account-session.bin');
  const webCalls = [];
    let activeVerificationCalls = 0;
    let maxActiveVerificationCalls = 0;
  try {
    const webRequest = async (url, options) => {
      webCalls.push({ url, cookie: options.headers.Cookie || '' });
      if (url.includes('/passport/web/get_qrcode/')) {
        return { status: 200, headers: { 'set-cookie': ['passport_csrf_token=csrf-fixture; Path=/; Secure'] }, data: JSON.stringify({
          message: 'SUCCESS', data: { token: 'login-token', qrcode: '[image omitted]', expire_time: 180 },
        }) };
      }
      if (url.includes('/passport/web/check_qrconnect/')) {
        return { status: 200, headers: {}, data: JSON.stringify({
          message: 'SUCCESS', data: { status: '3', redirect_url: '/passport/web/redirect' },
        }) };
      }
      if (url.includes('/passport/web/redirect')) {
        return { status: 200, headers: { 'set-cookie': ['sessionid=private-session; Path=/; Secure'] }, data: 'ok' };
      }
      if (url.includes('/passport/account/info/v2/')) {
        activeVerificationCalls++;
        maxActiveVerificationCalls = Math.max(maxActiveVerificationCalls, activeVerificationCalls);
        await new Promise(resolve => setTimeout(resolve, 60));
        activeVerificationCalls--;
        return { status: 200, headers: {}, data: JSON.stringify({
          message: 'SUCCESS', data: { user_id_str: '42', name: '测试账号' },
        }) };
      }
      throw new Error(`Unexpected website request: ${url}`);
    };
    const accountRequest = async (url, options) => {
      assert.deepEqual(options.preserveLargeIntegerFields, ['vid', 'video_id', 'item_id']);
      if (url.includes('/reading/bookapi/read_history/list/v1/')) return { code: 0, data: { data_list: [
        { book_id: '1001', book_name: '测试短剧', thumb_url: 'https://img.example/test.jpg', vid: '9001', vid_index: 2, current_play_position: 30000, duration: 60000, episode_cnt: 8, read_timestamp_ms: 1700000000000 },
      ] } };
      throw new Error(`Unexpected account request: ${url}`);
    };
    const service = createAccountService({
      filePath: file, safeStorage: fakeEncryption(), webRequest, accountRequest,
      identityRequest: async () => {
        activeVerificationCalls++;
        maxActiveVerificationCalls = Math.max(maxActiveVerificationCalls, activeVerificationCalls);
        await new Promise(resolve => setTimeout(resolve, 60));
        activeVerificationCalls--;
        return { device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' };
      },
    });
    const started = await service.startLogin();
    assert.equal(started.success, true);
    assert.match(started.image, /^data:image\/png;base64,/);
    const signedIn = await service.pollLogin(started.loginId);
    assert.equal(signedIn.status, 'signed-in');
    assert.equal(signedIn.account.nickname, '测试账号');
    assert.ok(!JSON.stringify(signedIn).includes('private-session'));
    const history = await service.history({ refresh: true });
    assert.equal(history.results.length, 1);
    assert.equal(service.row('1001').episode_id, '9001');
    assert.ok(fs.existsSync(file));
    assert.ok(webCalls.some(call => call.cookie.includes('passport_csrf_token=csrf-fixture')));
    assert.ok(webCalls.some(call => call.url.includes('/passport/account/info/v2/') && call.cookie.includes('sessionid=private-session')));
    assert.equal(maxActiveVerificationCalls, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verified website login does not require an anonymous playback device', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-web-login-'));
  let registrations = 0;
  try {
    const service = createAccountService({
      filePath: path.join(root, 'session.bin'), safeStorage: fakeEncryption(),
      webRequest: async () => webPayload({ user_id_str: '42', name: '测试账号' }),
      identityRequest: async () => { registrations++; throw new Error('device unavailable'); },
    });
    assert.equal((await service.completeWebLogin('sessionid=fixture')).status, 'signed-in');
    assert.equal((await service.status()).signedIn, true);
    assert.equal(registrations, 0);
    await assert.rejects(service.history({ refresh: true }), /device unavailable/);
    assert.equal((await service.status()).signedIn, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('confirmed QR login does not require an anonymous playback device', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-qr-login-'));
  try {
    const service = createAccountService({
      filePath: path.join(root, 'session.bin'), safeStorage: fakeEncryption(),
      identityRequest: async () => assert.fail('login must not register a device'),
      webRequest: async url => url.includes('get_qrcode') ? webPayload({ token: 'fixture', qrcode: 'fixture', expire_time: 180 })
        : url.includes('check_qrconnect') ? { ...webPayload({ status: '3' }), headers: { 'set-cookie': ['sessionid=fixture; Path=/'] } }
        : webPayload({ user_id_str: '42', name: '测试账号' }),
    });
    const started = await service.startLogin();
    assert.equal((await service.pollLogin(started.loginId)).status, 'signed-in');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('logout during lazy device registration cannot send the old account cookie', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-history-logout-'));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  try {
    const service = createAccountService({ filePath: path.join(root, 'session.bin'), safeStorage: fakeEncryption(),
      webRequest: async () => webPayload({ user_id_str: '42', name: '测试账号' }),
      identityRequest: async () => { entered(); await gate; return { device_id: '1', iid: '2', cdid: '00000000-0000-4000-8000-000000000003' }; },
      accountRequest: async () => assert.fail('logged-out account must not send cookies'),
    });
    await service.completeWebLogin('sessionid=fixture');
    const pending = service.history({ refresh: true });
    await waiting; await service.logout(); release();
    await assert.rejects(pending, /账号已退出/);
  } finally { release?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const action of ['cancelLogin', 'logout']) test(`${action} prevents a pending confirmation from saving credentials`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hg-login-cancel-'));
  let release, entered;
  const gate = new Promise(resolve=>release=resolve), waiting=new Promise(resolve=>entered=resolve);
  const filePath=path.join(root,'session.bin');
  const service=createAccountService({filePath,safeStorage:fakeEncryption(),identityRequest:async()=>({device_id:'1',iid:'2',cdid:'fixture'}),webRequest:async url=>{
    if(url.includes('get_qrcode'))return webPayload({token:'fixture',qrcode:'fixture',expire_time:180});
    if(url.includes('check_qrconnect'))return {...webPayload({status:'3'}),headers:{'set-cookie':['sessionid=fixture; Path=/']}};
    entered();await gate;return webPayload({user_id_str:'42',name:'Fixture'});
  }});
  try {const qr=await service.startLogin();const pending=service.pollLogin(qr.loginId);await waiting;await service[action](qr.loginId);release();assert.equal((await pending).status,'cancelled');assert.equal((await service.status()).signedIn,false);assert.equal(fs.existsSync(filePath),false);}finally{release();fs.rmSync(root,{recursive:true,force:true});}
});

test('a newer catalog clears outdated completion even when the local viewing event is newer', () => {
  const local = [{ series_id: '1000001', vid_index: 10, total: 10, completed: true, updatedAt: 200 }];
  const cloud = { series_id: '1000001', episode_id: '9000011', vid_index: 11, total: 11,
    currentTime: 10, duration: 90, updatedAt: 250 };
  assert.equal(mergeAccountWatchHistory(local, [cloud], {}, '42')[0].completed, false);
  const older = mergeAccountWatchHistory(local, [{ ...cloud, updatedAt: 100 }], {}, '42')[0];
  assert.equal(older.completed, false);
  assert.equal(older.total, 11);
  assert.equal(older.vid_index, 10);
  assert.equal(mergeAccountWatchHistory(local, [{ ...cloud, currentTime: 90 }], {}, '42')[0].completed, true);
});
