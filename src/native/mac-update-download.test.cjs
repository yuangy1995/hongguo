const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { appUpdateSource } = require('./app-update');
const { createMacUpdateDownloader, resolveMacAppPath } = require('./mac-update-download');

const source = appUpdateSource();
const version = '1.0.1';
const image = Buffer.from('disk image fixture');
const release = {
  tag_name: 'v1.0.1',
  assets: ['arm64', 'x64'].map(arch => {
    const name = `hongguo-downloader-${version}-mac-${arch}.dmg`;
    return {
      name,
      state: 'uploaded',
      browser_download_url: `${source.releasesUrl}/download/v${version}/${name}`,
      size: image.length,
      digest: `sha256:${createHash('sha256').update(image).digest('hex')}`,
    };
  }),
};

async function fixture(t, options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'test-hongguo-update-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const states = [], opened = [];
  const updater = createMacUpdateDownloader({
    currentVersion: '1.0.0', source, arch: 'arm64', tempDir,
    isEnabled: () => true, fetchRelease: async () => release,
    downloadImage: async (_asset, file, _signal, progress) => { progress(48); await writeFile(file, image); },
    openPath: async file => { opened.push(file); return ''; },
    emit: state => states.push(state),
    ...options,
  });
  return { updater, tempDir, opened, states };
}

for (const arch of ['arm64', 'x64']) {
  test(`downloads and opens the verified ${arch} disk image on request`, async t => {
    const { updater, opened, states } = await fixture(t, { arch });
    assert.equal((await updater.install()).success, false);
    assert.equal((await updater.download(version)).success, true);
    assert.equal(updater.getState().percent, 100);
    assert.ok(states.some(state => state.percent === 48 && state.status === 'downloading'));
    assert.deepEqual(opened, []);
    assert.equal((await updater.install()).success, true);
    assert.equal(path.basename(opened[0]), `hongguo-downloader-${version}-mac-${arch}.dmg`);
    await writeFile(opened[0], Buffer.alloc(image.length));
    assert.equal((await updater.install()).success, false);
    assert.equal(opened.length, 1);
  });
}

test('rejects withdrawn releases and untrusted asset locations before downloading', async t => {
  let data, downloads = 0;
  const { updater } = await fixture(t, {
    fetchRelease: async () => data,
    downloadImage: async () => { downloads++; },
  });
  for (const candidate of [
    { ...release, draft: true },
    { ...release, tag_name: 'v1.0.2' },
    { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.org/update.dmg' }] },
  ]) {
    data = candidate;
    assert.equal((await updater.download(version)).success, false);
  }
  assert.equal(downloads, 0);
});

test('discards a cancelled partial image and permits retry', async t => {
  let start, finish;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  let attempts = 0;
  const { updater, tempDir } = await fixture(t, {
    downloadImage: async (_asset, file) => {
      if (++attempts === 1) {
        await writeFile(file, image.subarray(0, 1));
        start();
        await waiting;
      } else await writeFile(file, image);
    },
  });
  const pending = updater.download(version);
  await started;
  updater.cancel();
  finish();
  assert.equal((await pending).success, false);
  assert.equal(updater.getState().status, 'idle');
  assert.deepEqual(await readdir(tempDir), []);
  assert.equal((await updater.download(version)).success, true);
});

test('resolves macOS app bundle paths safely', () => {
  assert.equal(resolveMacAppPath('/Applications/红果短剧.app/Contents/MacOS/红果短剧'), '/Applications/红果短剧.app');
  assert.equal(resolveMacAppPath('/Users/test/App/Custom.app/Contents/MacOS/Electron'), '/Users/test/App/Custom.app');
  assert.equal(resolveMacAppPath('/usr/local/bin/node'), null);
  assert.equal(resolveMacAppPath(''), null);
});

test('self-replaces writable macOS app bundle and quits without opening DMG', async t => {
  const execPath = '/Applications/红果短剧.app/Contents/MacOS/红果短剧';
  const stagedPath = '/tmp/staged/红果短剧.app';
  const applied = [];
  let quits = 0, blocker = '还有下载任务未完成';
  const { updater, opened, states } = await fixture(t, {
    execPath,
    installBlocker: () => blocker,
    canSelfReplace: async target => target === '/Applications/红果短剧.app',
    stageAppFromDmg: async (_file, _dir, expectedVersion, expectedArch) => {
      assert.equal(expectedVersion, version);
      assert.equal(expectedArch, 'arm64');
      return stagedPath;
    },
    applyAndRelaunch: payload => applied.push(payload),
    quitApp: () => { quits++; },
  });
  assert.equal((await updater.download(version)).success, true);
  const blockedResult = await updater.install();
  assert.equal(blockedResult.success, false);
  assert.equal(blockedResult.error, blocker);
  assert.equal(applied.length, 0);
  assert.equal(quits, 0);

  blocker = '';
  const installed = await updater.install();
  assert.equal(installed.success, true);
  assert.equal(installed.state.status, 'installing');
  assert.equal(opened.length, 0);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].targetAppPath, '/Applications/红果短剧.app');
  assert.equal(applied[0].stagedApp, stagedPath);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.ok(states.some(state => state.status === 'installing'));
});

test('falls back to opening DMG on staging errors and rejects invalid bundles', async t => {
  const execPath = '/Applications/红果短剧.app/Contents/MacOS/红果短剧';
  const fallback = await fixture(t, {
    execPath,
    canSelfReplace: async () => true,
    stageAppFromDmg: async () => { throw new Error('hdiutil busy'); },
  });
  assert.equal((await fallback.updater.download(version)).success, true);
  const fallbackResult = await fallback.updater.install();
  assert.equal(fallbackResult.success, true);
  assert.equal(fallbackResult.state.fallbackManual, true);
  assert.equal(fallback.opened.length, 1);

  const tampered = await fixture(t, {
    execPath,
    canSelfReplace: async () => true,
    stageAppFromDmg: async () => { throw Object.assign(new Error('bad signature'), { invalidBundle: true }); },
  });
  assert.equal((await tampered.updater.download(version)).success, true);
  const tamperedResult = await tampered.updater.install();
  assert.equal(tamperedResult.success, false);
  assert.equal(tampered.opened.length, 0);
  assert.equal(tampered.updater.getState().status, 'idle');
});
