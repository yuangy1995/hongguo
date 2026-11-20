const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { appUpdateSource } = require('./app-update');
const { createMacUpdateDownloader } = require('./mac-update-download');

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
