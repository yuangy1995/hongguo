// Focused offline checks: bounded source searches and strict sequel identity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const file = path.join(__dirname, '../src/native/series-search.js');
const { findSequels } = require('../src/native/watch-history');
const first = { series_id: '1000001', series_title: '双子房客' };
const second = { series_id: '1000002', series_title: '双子房客第二季' };
const third = { series_id: '1000003', series_title: '双子房客第三季' };
const fourth = { series_id: '1000004', series_title: '双子房客第四季' };
const ok = results => ({ success: true, results });
let failures = 0;
async function check(name, fn) { if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return; try { await fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); } }
function searchModule() { assert.ok(fs.existsSync(file), 'bounded search module is missing'); return require(file); }
(async () => {
  await check('short titles supplement the first missing season with at most two extra queries', async () => {
    const calls = [];
    const result = await searchModule().searchSeries('双子房客', async kw => { calls.push(kw); return ok(kw === '双子房客' ? [first, second] : kw === '双子房客第三季' ? [third] : [third, fourth]); });
    assert.deepEqual(calls, ['双子房客', '双子房客第三季', '双子房客第3季']);
    assert.deepEqual(result.results.map(item => item.series_id), ['1000001', '1000002', '1000003', '1000004']);
    const unrelated = [];
    await searchModule().searchSeries('双子房客', async kw => { unrelated.push(kw); return ok([{ series_id: '1999999', series_title: '另一部剧' }]); });
    assert.deepEqual(unrelated, ['双子房客']);
  });
  await check('explicit season stays exact-first and falls back to the base once when absent', async () => {
    const calls = [];
    const result = await searchModule().searchSeries('双子房客第三季', async kw => { calls.push(kw); return ok(kw === '双子房客第三季' ? [second] : [first, third]); });
    assert.deepEqual(calls, ['双子房客第三季', '双子房客']);
    assert.equal(result.results[0].series_id, third.series_id);
    const exactCalls = [];
    await searchModule().searchSeries('双子房客第三季', async kw => { exactCalls.push(kw); return ok([second, third]); });
    assert.deepEqual(exactCalls, ['双子房客第三季']);
  });
  await check('supplement failure preserves initial results and reports a partial search', async () => {
    const result = await searchModule().searchSeries('双子房客', async kw => kw === '双子房客' ? ok([first, second]) : Promise.reject(new Error('offline')));
    assert.equal(result.success, true); assert.equal(result.partial, true);
    assert.deepEqual(result.results.map(item => item.series_id), ['1000001', '1000002']);
    assert.match(result.error, /补充搜索/);
  });
  await check('sequel matching is same-source, same-base, explicit and nearest-season-first', () => {
    const results = findSequels(first, [fourth, { series_id: 'hema:7', series_title: third.series_title }, third, second, second, { series_id: '1999999', series_title: '双子房客番外' }]);
    assert.deepEqual(results.map(item => item.series_id), ['1000002', '1000003', '1000004']);
  });
  await check('bracketed years remain part of the base title while unsafe explicit seasons are rejected', async () => {
    const original = { ...first, series_title: '年轮（2024）' }, sequel = { ...second, series_title: '年轮（2024）第二季' };
    assert.deepEqual(findSequels(original, [sequel]).map(item => item.series_id), [second.series_id]);
    const local = await searchModule().findSeriesSequels(original, [sequel], async () => { throw new Error('localOnly must not search'); }, { localOnly: true });
    assert.equal(local.success, true); assert.equal(local.results[0].series_id, second.series_id);
    assert.deepEqual(findSequels({ ...first, series_title: '年轮第999999999999999999999季' }, [sequel]), []);
  });
  await check('local sequel candidates survive remote failure and localOnly makes no requests', async () => {
    const { findSeriesSequels } = searchModule(); let calls = 0;
    const search = async () => { calls++; throw new Error('offline'); };
    const local = await findSeriesSequels(first, [fourth, second], search, { localOnly: true });
    assert.equal(calls, 0); assert.deepEqual(local.results.map(item => item.series_id), ['1000002', '1000004']);
    const result = await findSeriesSequels(first, [fourth, second], search);
    assert.ok(calls > 0); assert.equal(result.success, true); assert.equal(result.partial, true);
    assert.deepEqual(result.results.map(item => item.series_id), ['1000002', '1000004']);
    assert.match(result.error, /offline/);
  });
  await check('sequel search uses the current season even when the source base query omits it', async () => {
    const calls = [];
    const result = await searchModule().findSeriesSequels(second, [], async kw => { calls.push(kw); return ok(kw === '双子房客' ? [first] : [third]); });
    assert.deepEqual(calls, ['双子房客', '双子房客第三季', '双子房客第3季']);
    assert.equal(result.results[0].series_id, third.series_id);
  });
  await check('non-contiguous search seasons supplement the first missing season', async () => {
    const calls = [];
    const result = await searchModule().searchSeries('双子房客', async kw => {
      calls.push(kw); return ok(kw === '双子房客' ? [first, third] : [second]);
    });
    assert.deepEqual(calls, ['双子房客', '双子房客第二季', '双子房客第2季']);
    assert.ok(result.results.some(item => item.series_id === second.series_id));
  });
  await check('non-contiguous sequel candidates never skip the missing season after the current one', async () => {
    const calls = [];
    const result = await searchModule().findSeriesSequels(second, [fourth], async kw => {
      calls.push(kw); return ok(kw === '双子房客' ? [fourth] : [third]);
    });
    assert.deepEqual(calls, ['双子房客', '双子房客第三季', '双子房客第3季']);
    assert.deepEqual(result.results.map(item => item.series_id), [third.series_id, fourth.series_id]);
  });
  await check('an expired total budget skips supplements but keeps the primary results', async () => {
    const calls = [];
    const result = await searchModule().searchSeries('双子房客', async kw => { calls.push(kw); return ok([first]); }, [], { deadline: Date.now() - 1 });
    assert.deepEqual(calls, ['双子房客']);
    assert.equal(result.success, true);
    assert.equal(result.partial, true);
    assert.match(result.error, /时间预算/);
  });
  await check('missing or unsupported identities never trigger remote searches', async () => {
    const { findSeriesSequels } = searchModule(); let calls = 0;
    for (const series of [{ ...first, series_title: '' }, { ...first, series_title: '第三季' }, { ...first, series_title: '双子房客第999999999999999999999季' }, { series_id: 'unknown:1', series_title: '双子房客' }]) {
      const result = await findSeriesSequels(series, [], async () => { calls++; return ok([]); });
      assert.equal(result.success, false); assert.ok(result.error);
    }
    assert.equal(calls, 0);
  });
  await check('merged UI results rank exact and contained titles, dedupe within source and retain other sources', () => {
    const module = { exports: {} };
    const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/searchRanking.mjs'), 'utf8'), { loader: 'js', format: 'cjs' }).code;
    vm.runInNewContext(source, { module, exports: module.exports, require: () => ({}) });
    assert.equal(typeof module.exports.rankSearchResults, 'function');
    const result = module.exports.rankSearchResults([
      { series_id: 'unrelated', series_title: '无关剧名', source: 'hongguo' },
      { ...third, source: 'hongguo' }, { ...first, source: 'hongguo' }, { ...first, source: 'hongguo' },
      { ...first, source: 'hema' },
    ], ' 双子 房客 ');
    assert.equal(result.length, 4);
    assert.deepEqual(JSON.parse(JSON.stringify(result.map(item => [item.series_id, item.source, item.relevance]))), [[first.series_id, 'hongguo', 0], [first.series_id, 'hema', 0], [third.series_id, 'hongguo', 1], ['unrelated', 'hongguo', 3]]);
  });
  await check('player season lookup combines earlier and later exact seasons across source pages', async () => {
    const calls = [];
    const { findSeriesSeasons } = searchModule();
    const result = await findSeriesSeasons(second, [first], async (keyword, options) => {
      calls.push([keyword, options.page, options.channel, options.cursor]);
      if (options.page === 2) return ok([third, { series_id: '1999999', series_title: '双子房客番外第四季' }]);
      if (keyword === '双子房客') return { ...ok([{ ...third, series_id: 'hema:3' }]), hasMore: true, channel: 'app', cursor: { offset: 20 } };
      return ok([fourth]);
    });
    assert.deepEqual(result.results.map(item => [item.season, item.series_id, item.registered]), [
      [1, first.series_id, true], [2, second.series_id, true], [3, third.series_id, false], [4, fourth.series_id, false],
    ]);
    assert.deepEqual(calls[1], ['双子房客', 2, 'app', { offset: 20 }]);
    const offline = await findSeriesSeasons(second, [first], async () => { throw new Error('offline'); });
    assert.equal(offline.partial, true);
    assert.deepEqual(offline.results.map(item => item.season), [1, 2]);
  });
  await check('Hongguo player recognizes numbered seasons with a trailing particle from either direction', async () => {
    const base = '我合成了全世界';
    const seasons = [`${base}第1季`, `${base}第2季`, `${base}啊第3季`]
      .map((series_title, i) => ({ series_id: String(1000010 + i), series_title }));
    const unrelated = [
      { series_id: '1000019', series_title: `${base}呀` },
      { series_id: '1000020', series_title: `${base}番外第4季` },
      { series_id: 'hema:21', series_title: `${base}啊第4季` },
    ];
    const { findSeriesSeasons } = searchModule();
    for (const current of seasons) {
      const queries = [];
      const result = await findSeriesSeasons(current, [], async keyword => {
        queries.push(keyword);
        return ok(keyword === base ? [...unrelated, ...seasons] : []);
      });
      assert.equal(queries[0], base);
      assert.deepEqual(result.results.map(item => item.series_id), seasons.map(item => item.series_id));
      assert.equal(result.partial, false);
    }
    const offline = await findSeriesSeasons(seasons[2], seasons.slice(0, 2), async () => { throw new Error('offline'); });
    assert.deepEqual(offline.results.map(item => item.season), [1, 2, 3]);
    assert.equal(offline.partial, true);
    assert.deepEqual(findSequels(seasons[1], [seasons[2]]), [], 'watch-history matching stays exact');
  });
  await check('season lookup retries the original title if a shorter query misses earlier seasons', async () => {
    const base = '都重生了，谁还装富二代啊';
    const query = base.normalize('NFKC');
    const current = { series_id: '1000033', series_title: `${base}第三季` };
    const earlier = { series_id: '1000031', series_title: base };
    const calls = [];
    const { findSeriesSeasons } = searchModule();
    const result = await findSeriesSeasons(current, [], async (keyword, options) => {
      calls.push([keyword, options.deadline]);
      return ok(keyword === query ? [earlier] : []);
    }, { deadline: Date.now() + 22000 });
    assert.equal(calls[0][0], query.slice(0, -1));
    assert.ok(calls.some(([keyword, deadline]) => keyword === query && deadline > calls[0][1]));
    assert.deepEqual(result.results.map(item => item.season), [1, 3]);
  });
  await check('real IPC supplements the selected source and exposes local-first sequel candidates', async () => {
    const mainPath = path.join(__dirname, '../main.js'), req = require('node:module').createRequire(mainPath);
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hongguo-sequel-'));
    try {
      const app = new (require('node:events').EventEmitter)(), handlers = {}, calls = [];
      Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
      const hemaSeries = [first, second, third].map((item, index) => ({ ...item, series_id: `hema:${index + 1}` }));
      const hema = { search: async kw => { calls.push(kw); return ok(kw === '双子房客' ? hemaSeries.slice(0, 2) : hemaSeries.slice(2)); } };
      const electron = { app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
      const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './src/native/hema' ? hema : name === './src/store' ? { getSettings: () => ({ root }) } : req(name), __dirname: path.dirname(mainPath), process: { ...process, env: {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
      vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
      require('./fixtures/trusted-ipc.cjs')(context, handlers);
      context.runSearchSniff = async () => { throw new Error('must not search Hongguo'); };
      const searched = await handlers['search-series']({}, '双子房客', { source: 'hema' });
      assert.equal(searched.success, true); assert.equal(searched.results.length, 3);
      assert.deepEqual(calls, ['双子房客', '双子房客第三季', '双子房客第3季']);
      context.fixture = hemaSeries;
      vm.runInContext('seriesRegistry = fixture', context);
      calls.length = 0;
      const local = await handlers['find-series-sequels']({}, 'hema:1', { localOnly: true });
      assert.equal(local.success, true); assert.deepEqual(local.results.map(item => item.series_id), ['hema:2', 'hema:3']); assert.equal(calls.length, 0);
      hemaSeries[1].dismissed = true;
      hemaSeries[2].dismissed = true; hemaSeries[2].forgotten = true;
      const hidden = await handlers['find-series-sequels']({}, 'hema:1', { localOnly: true });
      assert.deepEqual(hidden.results.map(item => item.series_id), ['hema:2'], 'hidden archives remain discoverable, permanently forgotten ones do not');
      const missing = await handlers['find-series-sequels']({}, 'missing');
      assert.equal(missing.success, false); assert.equal(calls.length, 0);
      const unsupported = await handlers['search-series']({}, '双子房客', { source: 'unknown' });
      assert.equal(unsupported.success, false); assert.equal(calls.length, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  if (failures) process.exitCode = 1;
})();
