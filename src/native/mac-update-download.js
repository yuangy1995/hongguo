const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { lstat, mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const { availableRelease } = require('./app-update');

const MAC_UPDATE_MODE = 'mac-dmg';
const DOWNLOAD_ORIGINS = new Set([
  'https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com',
]);

function macReleaseAsset(data, expectedVersion, currentVersion, source, arch) {
  const release = availableRelease(data, currentVersion, source);
  if (!release || release.version !== expectedVersion || !['arm64', 'x64'].includes(arch)) return null;
  const name = `hongguo-downloader-${release.version}-mac-${arch}.dmg`;
  const url = `${source.releasesUrl}/download/${encodeURIComponent(data.tag_name)}/${name}`;
  const asset = data.assets?.find(item => item.name === name);
  if (asset?.state !== 'uploaded' || asset.browser_download_url !== url ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) return null;
  return { name, url, size: asset.size, sha256: asset.digest.slice(7) };
}

function trustedDownloadUrl(url) {
  const parsed = new URL(url);
  return !parsed.username && !parsed.password && DOWNLOAD_ORIGINS.has(parsed.origin);
}

function createMacDownloadTransport(session) {
  let acceptDownload = null;
  // This session is dedicated to downloads from the configured GitHub release.
  session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !trustedDownloadUrl(request.url) }));
  session.on('will-download', (event, item) => {
    if (!acceptDownload?.(item)) event.preventDefault();
  });

  return (asset, destination, signal, progress) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const url = new URL(asset.url);
    // A late event from a cancelled request must never attach to a retry.
    url.searchParams.set('download_id', randomUUID());
    let item;
    function finish(error) {
      clearTimeout(timer);
      acceptDownload = null;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      if (item) item.cancel();
      else finish(signal.reason);
    }
    const timer = setTimeout(() => finish(new Error('Download did not start')), 30000);
    signal.addEventListener('abort', abort, { once: true });
    acceptDownload = download => {
      const chain = download.getURLChain();
      if (chain[0] !== url.href) return false;
      if (!chain.every(trustedDownloadUrl)) {
        finish(new Error('Unexpected download origin'));
        return false;
      }
      clearTimeout(timer);
      acceptDownload = null;
      item = download;
      item.setSavePath(destination);
      item.on('updated', () => {
        const received = item.getReceivedBytes();
        if (received > asset.size) item.cancel();
        else progress(Math.min(99, Math.floor(received * 100 / asset.size)));
      });
      item.once('done', (_event, state) => {
        finish(signal.aborted ? signal.reason : state === 'completed' ? null : new Error('Download interrupted'));
      });
      return true;
    };
    try { session.downloadURL(url.href); }
    catch (error) { finish(error); }
  });
}

async function verifyImage(file, asset, signal) {
  const info = await lstat(file);
  if (!info.isFile() || info.size !== asset.size) throw new Error('Unexpected image size');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw new Error('Unexpected image checksum');
}

function createMacUpdateDownloader({ currentVersion, source, arch, tempDir, isEnabled, fetchRelease, downloadImage, openPath, emit }) {
  const idle = { supported: true, reason: '', mode: MAC_UPDATE_MODE, status: 'idle', version: null, percent: 0, error: '', downloaded: false };
  let state = idle, operation, controller, ready, generation = 0;
  const getState = () => ({ ...state });
  const update = patch => { state = { ...state, ...patch }; emit(getState()); };
  const result = error => ({ success: !error, error: error || '', state: getState() });
  const cleanup = dir => dir && rm(dir, { recursive: true, force: true }).catch(() => {});
  const cancelled = '更新已取消。';

  function cancel() {
    generation++;
    controller?.abort();
    if (ready) void cleanup(ready.dir);
    ready = null;
    update(idle);
    return result();
  }

  function download(version) {
    if (!isEnabled()) return Promise.resolve(result(cancelled));
    if (operation && !controller.signal.aborted) return operation;
    if (operation) {
      const request = generation;
      return operation.then(() => request === generation ? download(version) : result(cancelled));
    }
    if (ready && state.version === version) return Promise.resolve(result());
    cancel();
    controller = new AbortController();
    const { signal } = controller;
    update({ status: 'checking', version });
    operation = (async () => {
      let dir;
      try {
        const data = await fetchRelease(signal);
        signal.throwIfAborted();
        const asset = macReleaseAsset(data, version, currentVersion, source, arch);
        if (!asset) throw new Error('No matching release asset');
        dir = await mkdtemp(path.join(tempDir, 'hongguo-mac-update-'));
        const file = path.join(dir, asset.name);
        signal.throwIfAborted();
        update({ status: 'downloading' });
        await downloadImage(asset, file, signal, percent => {
          if (!signal.aborted && percent !== state.percent) update({ percent });
        });
        await verifyImage(file, asset, signal);
        signal.throwIfAborted();
        ready = { dir, file, asset };
        dir = null;
        update({ status: 'downloaded', percent: 100, downloaded: true });
        return result();
      } catch {
        if (signal.aborted || !isEnabled()) return result(cancelled);
        const error = '更新下载或校验失败，请检查网络后重试。';
        update({ status: 'error', error });
        return result(error);
      } finally {
        await cleanup(dir);
        operation = controller = null;
      }
    })();
    return operation;
  }

  async function install() {
    if (!isEnabled() || !ready) return result('请先完成更新下载。');
    const image = ready;
    try { await verifyImage(image.file, image.asset); }
    catch {
      if (ready !== image) return result(cancelled);
      cancel();
      return result('安装包已失效，请重新下载更新。');
    }
    if (ready !== image || !isEnabled()) return result(cancelled);
    try {
      if (!(await openPath(image.file))) return result();
    } catch {}
    return result('无法打开安装包，请稍后重试。');
  }

  return { getState, download, install, cancel };
}

module.exports = { MAC_UPDATE_MODE, createMacDownloadTransport, createMacUpdateDownloader };
