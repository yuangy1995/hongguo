// Isolated renderer checks: no network, installed app, user data or actual timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const idle = { supported: true, reason: '', status: 'idle', version: null, percent: 0, error: '' };
const release = { version: '9.0', url: 'https://github.com/jackotom/hongguo-drama/releases/tag/v9.0' };
function mount(api = {}, component = 'AppUpdateNotice', props = {}) {
  const slots = [], effects = [], cleanups = [], effectFns = [], events = new Map(), timers = new Map(), timeouts = new Map();
  let cursor = 0, tree, timerId = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((d, j) => !Object.is(d, slots[i][j]))) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); effectFns[i] = fn; cleanups[i] = fn(); }); } },
  };
  const defaults = { checkAppUpdate: async () => ({ enabled: true, release }), getAppUpdateState: async () => idle, getSettings: async () => ({ app_updates_enabled: true }) };
  const window = { electronAPI: new Proxy({ ...defaults, ...api }, { get: (o, k) => o[k] || (k.startsWith('on') ? cb => { events.set(k, cb); return () => events.delete(k); } : async () => ({ success: true })) }),
    addEventListener: (name, cb) => events.set(name, cb), removeEventListener: name => events.delete(name), dispatchEvent: event => events.get(event.type)?.(event) };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/${component}.jsx`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => name === '../i18n' ? { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {} } : name === 'react' ? react : name === './useDialogKeyboard' ? () => {}
      : name === './danmakuSource.mjs' ? { useDanmakuSource: () => 'official', writeDanmakuSource() {} } : {}, window, console,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id),
    setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id),
  });
  const render = () => { cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); };
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const textOf = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(textOf).join('') || '';
  const find = fn => nodes().find(fn);
  render();
  return { render, find, nodes, text: () => textOf(tree), button: label => find(n => n.type === 'button' && (textOf(n).includes(label) || n.props['aria-label'] === label)),
    flush: async () => { for (let i = 0; i < 25; i++) { await Promise.resolve(); render(); } }, emit: (name, data) => events.get(name)?.(data),
    restartEffects: () => { cleanups.forEach(fn => fn?.()); effectFns.forEach((fn, i) => { cleanups[i] = fn(); }); }, timer: () => timers.forEach(fn => fn()),
    timeout: () => { const pending = [...timeouts.values()]; timeouts.clear(); pending.forEach(fn => fn()); },
    unmount: () => cleanups.forEach(fn => fn?.()), events };
}
(async () => {
  let passed = 0, failed = 0;
  const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } };
  await test('new release auto-downloads, updates progress, and auto-installs when idle', async () => {
    let downloads = 0, installs = 0, finish;
    const ui = mount({
      downloadAppUpdate: () => { downloads++; return new Promise(r => { finish = r; }); },
      installAppUpdate: async () => { installs++; return { success: true, state: { ...idle, status: 'installing', version: '9.0' } }; },
    });
    await ui.flush();
    assert.equal(downloads, 1, 'supported new version must start downloading automatically');
    assert.equal(ui.button('前往发布页手动下载'), undefined, 'in-app flow must not show manual release button');
    ui.emit('onAppUpdateState', { ...idle, status: 'downloading', version: '9.0', percent: 37.2 }); await ui.flush();
    assert.ok(ui.text().includes('37%')); assert.ok(ui.find(n => n.type === 'progress' && n.props.value === 37));
    assert.ok(!ui.nodes().some(n => n.props['aria-live'] && /37%/.test(n.children.map(c => typeof c === 'string' ? c : '').join(''))));
    ui.button('关闭更新提醒').props.onClick(); await ui.flush(); assert.equal(ui.text(), '');
    ui.emit('onAppUpdateState', { ...idle, status: 'downloaded', version: '9.0', percent: 100 });
    finish({ success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } });
    await ui.flush();
    assert.equal(installs, 1, 'download completion must auto-install when no tasks block it');
    ui.unmount(); assert.equal(ui.events.size, 0);
  });
  await test('blocked auto-install reopens notice and lets user retry restart', async () => {
    let installs = 0, finish;
    const ui = mount({
      downloadAppUpdate: () => new Promise(r => { finish = r; }),
      installAppUpdate: async () => {
        installs++;
        if (installs === 1) return { success: false, error: '还有下载或等待重试的任务，请先在下载管理中暂停全部任务，再安装更新。', state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } };
        return { success: true, state: { ...idle, status: 'installing', version: '9.0' } };
      },
    });
    await ui.flush();
    ui.button('关闭更新提醒').props.onClick(); await ui.flush(); assert.equal(ui.text(), '');
    finish({ success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } });
    await ui.flush();
    assert.equal(installs, 1);
    assert.ok(ui.text().includes('暂停全部任务'), 'blocked auto-install must resurface notice with reason');
    assert.ok(ui.button('立即重启更新'));
    await ui.button('立即重启更新').props.onClick(); await ui.flush();
    assert.equal(installs, 2);
    ui.unmount();
  });
  await test('an update blocked by tasks installs automatically once they finish', async () => {
    let busy = true, installs = 0;
    const ready = { ...idle, status: 'downloaded', version: release.version };
    const ui = mount({
      downloadAppUpdate: async () => ({ success: true, state: ready }),
      installAppUpdate: async () => {
        installs++;
        if (busy) return { success: false, retryWhenIdle: true, error: '还有下载任务', state: ready };
        return { success: true, state: { ...ready, status: 'installing' } };
      },
    });
    await ui.flush();
    assert.equal(installs, 1);
    ui.button('关闭更新提醒').props.onClick(); await ui.flush();
    ui.timeout(); await ui.flush();
    assert.equal(installs, 2);
    assert.equal(ui.text(), '', 'a busy retry must respect the dismissed notice');
    busy = false;
    ui.timeout(); await ui.flush();
    assert.equal(installs, 3);
    ui.timeout(); await ui.flush();
    assert.equal(installs, 3);
    ui.unmount();
  });
  await test('Mac auto-downloads and auto-installs in-app, falling back to DMG only when requested', async () => {
    const mac = { ...idle, mode: 'mac-dmg' };
    let downloads = 0, installs = 0;
    const ui = mount({
      getAppUpdateState: async () => mac,
      downloadAppUpdate: async () => {
        downloads++;
        return { success: true, state: { ...mac, status: 'downloaded', version: release.version, percent: 100 } };
      },
      installAppUpdate: async () => {
        installs++;
        return { success: true, state: { ...mac, status: 'downloaded', version: release.version, percent: 100, fallbackManual: true } };
      },
    });
    await ui.flush();
    assert.equal(downloads, 1);
    assert.equal(installs, 1);
    assert.equal(ui.button('前往发布页手动下载'), undefined);
    assert.ok(ui.text().includes('拖入「应用程序」替换'));
    await ui.button('打开安装包').props.onClick();
    assert.equal(installs, 2);
    ui.unmount();
  });
  await test('manual check reports no new release and network failure', async () => {
    let result = { enabled: true, release: null };
    const ui = mount({ checkAppUpdate: async () => result }); await ui.flush(); assert.equal(ui.text(), '');
    ui.emit('hongguo-check-app-update'); await ui.flush(); assert.ok(ui.text().includes('已是最新版本'));
    assert.equal(ui.button('前往发布页手动下载'), undefined);
    result = { enabled: true, release: null, error: '网络连接失败' }; ui.emit('hongguo-check-app-update'); await ui.flush(); assert.ok(ui.text().includes('网络连接失败')); assert.ok(ui.button('重新检查')); ui.unmount();
  });
  await test('disabled checks preserve the backend reason and recover after proxy repair', async () => {
    let result = { enabled: false, release: null, error: '请先修复或明确关闭代理。' };
    let downloads = 0;
    const ui = mount({
      checkAppUpdate: async () => result,
      downloadAppUpdate: () => { downloads++; return new Promise(() => {}); },
    }); await ui.flush(); assert.equal(ui.text(), '');
    ui.emit('hongguo-check-app-update'); await ui.flush();
    assert.ok(ui.text().includes(result.error), 'manual checks must show the proxy failure reason');
    assert.ok(!ui.text().includes('更新检测已关闭'), 'a blocked proxy is not an update preference');
    result = { enabled: false, release: null };
    await ui.button('重新检查').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('更新检测已关闭'));
    result = { enabled: true, release };
    await ui.button('重新检查').props.onClick(); await ui.flush();
    assert.equal(downloads, 1, 'recovering after check must auto-download the new release');
    ui.unmount();
  });
  await test('unsupported installation does not auto-download and provides manual fallback', async () => {
    let opened = 0, downloads = 0;
    const ui = mount({
      getAppUpdateState: async () => ({ ...idle, supported: false, reason: '便携版请手动安装新版' }),
      downloadAppUpdate: async () => { downloads++; return { success: true }; },
      openAppUpdate: async () => { opened++; return { success: true }; },
    });
    await ui.flush();
    assert.equal(downloads, 0);
    assert.ok(ui.text().includes('便携版请手动安装新版'));
    assert.equal(ui.button('下载并更新'), undefined);
    await ui.button('前往 GitHub 下载').props.onClick(); assert.equal(opened, 1); ui.unmount();
  });
  await test('disable blocks late check and retained download/install callbacks', async () => {
    let calls = 0, finish;
    const ui = mount({ downloadAppUpdate: () => { calls++; return new Promise(r => { finish = r; }); } }); await ui.flush();
    assert.equal(calls, 1);
    ui.emit('onAppUpdatePreference', false); await ui.flush();
    finish({ success: true, state: { ...idle, status: 'downloaded', version: '9.0' } });
    await ui.flush();
    assert.equal(ui.text(), '');
    ui.emit('onAppUpdateState', { ...idle, status: 'downloaded', version: '9.0' }); await ui.flush(); assert.equal(ui.text(), ''); ui.unmount();
    let resolve;
    const late = mount({ checkAppUpdate: () => new Promise(r => { resolve = r; }) }); await late.flush(); late.emit('onAppUpdatePreference', false); resolve({ enabled: true, release }); await late.flush(); assert.equal(late.text(), ''); late.unmount();
  });
  await test('download errors allow in-app retry and install refusal preserves install action', async () => {
    let attempts = 0, installs = 0;
    const ui = mount({
      downloadAppUpdate: async () => {
        attempts++;
        if (attempts === 1) return { success: false, error: '校验失败，请重试' };
        return { success: true, state: { ...idle, status: 'downloaded', version: '9.0' } };
      },
      installAppUpdate: async () => { installs++; return { success: false, error: '请等待下载任务完成' }; },
    });
    await ui.flush();
    assert.equal(attempts, 1);
    assert.ok(ui.text().includes('校验失败'));
    assert.ok(ui.button('下载并更新'));
    await ui.button('下载并更新').props.onClick(); await ui.flush();
    assert.equal(attempts, 2);
    assert.equal(installs, 1);
    assert.ok(ui.text().includes('请等待下载任务完成'));
    assert.equal(!!ui.button('立即重启更新').props.disabled, false);
    ui.unmount();
  });
  await test('closing a manual check suppresses its late result', async () => {
    let resolve, first = true;
    const ui = mount({
      checkAppUpdate: async () => { if (first) { first = false; return { enabled: true, release: null }; } return new Promise(r => { resolve = r; }); },
      downloadAppUpdate: () => new Promise(() => {}),
    }); await ui.flush();
    ui.emit('hongguo-check-app-update'); await ui.flush(); ui.button('关闭更新提醒').props.onClick(); resolve({ enabled: true, release }); await ui.flush(); assert.equal(ui.text(), ''); ui.unmount();
  });
  await test('StrictMode effect restart does not leave check or download pending forever', async () => {
    let downloads = 0;
    const ui = mount({ downloadAppUpdate: () => { downloads++; return new Promise(() => {}); } });
    ui.restartEffects(); await ui.flush();
    assert.ok(ui.button('取消下载'));
    assert.equal(!!ui.button('取消下载').props.disabled, false);
    ui.unmount();
  });
  await test('manual check joins initial request and still reports its failure', async () => {
    let resolve, checks = 0;
    const ui = mount({ checkAppUpdate: () => { checks++; return new Promise(r => { resolve = r; }); } });
    ui.emit('hongguo-check-app-update'); await ui.flush(); assert.equal(checks, 1);
    resolve({ enabled: true, release: null, error: '无法连接更新服务' }); await ui.flush(); assert.ok(ui.text().includes('无法连接更新服务')); assert.ok(!ui.text().includes('已是最新版本')); ui.unmount();
  });
  await test('failed recheck clears stale release and can recover inside the notice', async () => {
    let result = { enabled: true, release }, checks = 0, downloads = 0;
    const ui = mount({
      checkAppUpdate: async () => { checks++; return result; },
      downloadAppUpdate: async () => { downloads++; return { success: false, error: '已取消' }; },
    }); await ui.flush();
    assert.equal(downloads, 1);
    result = { enabled: true, release: null, error: '网络中断，版本信息已失效' };
    ui.emit('hongguo-check-app-update'); await ui.flush();
    assert.ok(ui.button('重新检查'), 'failed check with a previous release must expose retry');
    assert.equal(ui.button('下载并更新'), undefined, 'invalidated release must not keep its download action');
    assert.equal(ui.button('前往发布页手动下载'), undefined);
    result = { enabled: true, release }; await ui.button('重新检查').props.onClick(); await ui.flush();
    assert.equal(checks, 3); assert.equal(downloads, 2); assert.ok(!ui.text().includes('版本信息已失效')); ui.unmount();
  });
  await test('cancel stops auto-download, suppresses periodic retry for that version, and allows manual retry', async () => {
    let cancelled = 0, installs = 0; const completions = [];
    const ui = mount({
      downloadAppUpdate: () => new Promise(r => completions.push(r)),
      cancelAppUpdate: async () => { cancelled++; return { success: true, state: idle }; },
      installAppUpdate: async () => { installs++; return { success: true, state: { ...idle, status: 'installing', version: '9.0' } }; },
    });
    await ui.flush();
    assert.equal(completions.length, 1);
    ui.emit('onAppUpdateState', { ...idle, status: 'checking', version: '9.0' }); await ui.flush();
    assert.ok(ui.button('取消下载')); await ui.button('取消下载').props.onClick(); await ui.flush();
    assert.equal(cancelled, 1);
    ui.timer(); await ui.flush();
    assert.equal(completions.length, 1, 'periodic timer must not restart a cancelled version automatically');
    assert.equal(!!ui.button('下载并更新').props.disabled, false);
    const retry = ui.button('下载并更新').props.onClick();
    ui.emit('onAppUpdateState', { ...idle, status: 'downloading', version: '9.0', percent: 20 }); await ui.flush();
    completions[0]({ success: false, error: '更新已取消。', state: idle }); await ui.flush();
    assert.ok(ui.text().includes('20%')); assert.ok(!ui.text().includes('更新已取消。'));
    assert.equal(ui.button('正在下载…').props.disabled, true);
    completions[1]({ success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } });
    await retry; await ui.flush();
    assert.equal(installs, 1, 'manual retry completion must proceed to auto-install');
    ui.unmount();
  });
  await test('late native install failure remains recoverable in-app without a check release', async () => {
    let installs = 0;
    const ui = mount({
      checkAppUpdate: async () => ({ enabled: true, release: null }),
      getAppUpdateState: async () => ({ ...idle, status: 'downloaded', version: '9.0' }),
      installAppUpdate: async () => { installs++; return { success: true, state: { ...idle, status: 'installing', version: '9.0' } }; },
    });
    await ui.flush(); ui.emit('hongguo-check-app-update'); await ui.flush();
    await ui.button('立即重启更新').props.onClick(); await ui.flush();
    ui.emit('onAppUpdateState', { ...idle, status: 'error', version: '9.0', error: '系统安装器启动失败' }); await ui.flush();
    assert.ok(ui.text().includes('系统安装器启动失败'));
    assert.ok(ui.button('下载并更新'));
    assert.ok(ui.button('重新检查'));
    assert.ok(!ui.text().includes('已是最新版本'));
    assert.equal(installs, 1);
    ui.unmount();
  });
  await test('settings emits one check event and disables it for unsaved opt-out', async () => {
    let checks = 0, events = 0;
    const ui = mount({ checkAppUpdate: async () => { checks++; return { enabled: true, release }; } }, 'Settings'); await ui.flush();
    ui.events.set('hongguo-check-app-update', () => { events++; }); assert.ok(ui.button('检查更新')); ui.button('检查更新').props.onClick(); assert.equal(events, 1); assert.equal(checks, 0);
    ui.find(n => n.props['aria-label'] === '自动检测更新').props.onChange({ target: { checked: false } }); await ui.flush(); assert.equal(ui.button('检查更新').props.disabled, true); ui.unmount();
  });
  await test('active playback defers automatic checks until playback stops', async () => {
    let checks = 0, downloads = 0, installs = 0;
    const ui = mount({
      checkAppUpdate: async () => { checks++; return { enabled: true, release }; },
      downloadAppUpdate: async () => { downloads++; return { success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } }; },
      installAppUpdate: async () => { installs++; return { success: true, state: { ...idle, status: 'installing', version: '9.0' } }; },
    }, 'AppUpdateNotice', { playbackActive: true });
    await ui.flush();
    assert.equal(checks, 0, 'startup check must not run during active playback');
    assert.equal(downloads, 0);
    ui.timer(); await ui.flush();
    assert.equal(checks, 0, 'periodic check must not run during active playback');
    ui.emit('hongguo-playback-active', { detail: false });
    await ui.flush();
    assert.equal(checks, 1);
    assert.equal(downloads, 1);
    assert.equal(installs, 1);
    ui.unmount();
  });
  await test('starting playback pauses in-flight download and resumes after playback stops', async () => {
    let checks = 0, downloads = 0, cancelled = 0, installs = 0;
    const completions = [];
    const ui = mount({
      checkAppUpdate: async () => { checks++; return { enabled: true, release }; },
      downloadAppUpdate: () => { downloads++; return new Promise(r => completions.push(r)); },
      cancelAppUpdate: async () => { cancelled++; return { success: true, state: idle }; },
      installAppUpdate: async () => { installs++; return { success: true, state: { ...idle, status: 'installing', version: '9.0' } }; },
    });
    await ui.flush();
    assert.equal(downloads, 1);
    ui.emit('onAppUpdateState', { ...idle, status: 'downloading', version: '9.0', percent: 45 });
    await ui.flush();
    assert.ok(ui.text().includes('45%'));
    ui.emit('hongguo-playback-active', { detail: true });
    await ui.flush();
    assert.equal(cancelled, 1, 'starting playback must cancel in-flight update download');
    assert.equal(ui.text(), '', 'update modal must hide while playing');
    completions[0]({ success: false, error: '更新已取消。', state: idle });
    await ui.flush();
    assert.equal(installs, 0);
    assert.equal(downloads, 1);
    ui.emit('hongguo-playback-active', { detail: false });
    await ui.flush();
    assert.equal(checks, 2);
    assert.equal(downloads, 2, 'update download must resume after playback stops');
    completions[1]({ success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } });
    await ui.flush();
    assert.equal(installs, 1);
    ui.unmount();
  });
  await test('downloaded update defers install during playback until playback stops', async () => {
    let installs = 0, finish;
    const ui = mount({
      downloadAppUpdate: () => new Promise(r => { finish = r; }),
      installAppUpdate: async () => {
        installs++;
        if (installs === 1) return { success: false, error: '还有下载任务未完成', state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } };
        return { success: true, state: { ...idle, status: 'installing', version: '9.0' } };
      },
    });
    await ui.flush();
    finish({ success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } });
    await ui.flush();
    assert.equal(installs, 1);
    ui.emit('hongguo-playback-active', { detail: true });
    await ui.flush();
    assert.equal(ui.text(), '', 'update modal must hide while playing');
    ui.emit('hongguo-playback-active', { detail: false });
    await ui.flush();
    assert.equal(installs, 2, 'deferred install must proceed once playback stops');
    ui.unmount();
  });
  await test('manual check during playback pauses automatic download and resumes later', async () => {
    let downloads = 0;
    const ui = mount({
      downloadAppUpdate: async () => { downloads++; return { success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } }; },
    }, 'AppUpdateNotice', { playbackActive: true });
    await ui.flush();
    ui.emit('hongguo-check-app-update');
    await ui.flush();
    assert.equal(downloads, 0);
    assert.ok(ui.text().includes('已暂停自动下载与更新'));
    ui.emit('hongguo-playback-active', { detail: false });
    await ui.flush();
    assert.equal(downloads, 1);
    ui.unmount();
  });
  console.log(`App update UI: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
