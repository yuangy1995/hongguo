const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { constants, createReadStream } = require('node:fs');
const { access, lstat, mkdir, mkdtemp, readdir, rm } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { availableRelease } = require('./app-update');

const execFileAsync = promisify(execFile);
const MAC_UPDATE_MODE = 'mac-dmg';
const DOWNLOAD_ORIGINS = new Set([
  'https://github.com', 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com',
]);
const SELF_REPLACE_SCRIPT = [
  'pid="$1"; target="$2"; staged="$3"; cleanup="$4"; i=0',
  'stage_dir="${staged%/*}"; backup="$stage_dir/previous.app"',
  'while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); if [ "$i" -ge 150 ]; then /bin/rm -rf "$stage_dir" "$cleanup"; exit 1; fi; /bin/sleep 0.2; done',
  'if ! /bin/mv "$target" "$backup"; then',
  '  /bin/rm -rf "$stage_dir" "$cleanup"; /usr/bin/open "$target"; exit 1',
  'fi',
  'if [ ! -e "$target" ] && [ ! -L "$target" ] && /bin/mv "$staged" "$target"; then',
  '  if /usr/bin/open -n "$target"; then /bin/rm -rf "$stage_dir" "$cleanup"; exit 0; fi',
  '  /bin/mv "$target" "$staged"',
  'fi',
  'if [ ! -e "$target" ] && [ ! -L "$target" ] && /bin/mv "$backup" "$target"; then',
  '  /bin/rm -rf "$stage_dir"; /usr/bin/open "$target"',
  'else',
  '  /usr/bin/open "$backup"',
  'fi',
  '/bin/rm -rf "$cleanup"; exit 1',
].join('\n');

function macReleaseAsset(data, expectedVersion, currentVersion, source, arch) {
  const release = availableRelease(data, currentVersion, source);
  if (!release || release.version !== expectedVersion || !['arm64', 'x64'].includes(arch)) return null;
  const name = `hongguo-downloader-${release.version}-mac-${arch}.dmg`;
  const url = `${source.releasesUrl}/download/${encodeURIComponent(data.tag_name)}/${name}`;
  const asset = data.assets?.find(item => item.name === name);
  if (asset?.state !== 'uploaded' || asset.browser_download_url !== url ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) return null;
  return { name, url, size: asset.size, sha256: asset.digest.slice(7), version: release.version };
}

function resolveMacAppPath(execPath) {
  if (!execPath || typeof execPath !== 'string') return null;
  const resolved = path.resolve(execPath);
  if (path.basename(path.dirname(resolved)) !== 'MacOS') return null;
  if (path.basename(path.dirname(path.dirname(resolved))) !== 'Contents') return null;
  const appPath = path.resolve(resolved, '../../..');
  return appPath.endsWith('.app') ? appPath : null;
}

async function defaultCanSelfReplace(targetAppPath) {
  if (!targetAppPath || targetAppPath.includes('/AppTranslocation/')) return false;
  let probe;
  try {
    const info = await lstat(targetAppPath);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const plist = await lstat(path.join(targetAppPath, 'Contents', 'Info.plist'));
    if (plist.isSymbolicLink() || !plist.isFile()) return false;
    await access(targetAppPath, constants.W_OK);
    probe = await mkdtemp(path.join(path.dirname(targetAppPath), '.hongguo-update-probe-'));
    return true;
  } catch {
    return false;
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultStageAppFromDmg(dmgFile, workDir, expectedVersion, expectedArch, targetAppPath) {
  const mountDir = path.join(workDir, 'mount');
  await mkdir(mountDir, { recursive: true });
  let stagedRoot;
  await execFileAsync('/usr/bin/hdiutil', ['attach', dmgFile, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountDir]);
  try {
    const entries = await readdir(mountDir, { withFileTypes: true });
    const appEntry = entries.find(entry => entry.name === '红果短剧.app' && entry.isDirectory() && !entry.isSymbolicLink())
      || entries.find(entry => entry.name.endsWith('.app') && entry.isDirectory() && !entry.isSymbolicLink());
    if (!appEntry) throw Object.assign(new Error('Missing application bundle'), { invalidBundle: true });
    const mountedApp = path.join(mountDir, appEntry.name);
    try {
      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', mountedApp]);
      const readInfo = async (bundle, key) => {
        const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')]);
        return stdout.trim();
      };
      if (await readInfo(mountedApp, 'CFBundleIdentifier') !== await readInfo(targetAppPath, 'CFBundleIdentifier')) {
        throw new Error('Application identifier mismatch');
      }
      if (expectedVersion) {
        if (await readInfo(mountedApp, 'CFBundleShortVersionString') !== expectedVersion) throw new Error('Version mismatch');
      }
      if (expectedArch === 'arm64' || expectedArch === 'x64') {
        const execName = await readInfo(mountedApp, 'CFBundleExecutable');
        if (!execName || path.basename(execName) !== execName || execName === '.' || execName === '..') throw new Error('Invalid executable name');
        const expectedLipoArch = expectedArch === 'x64' ? 'x86_64' : 'arm64';
        const { stdout: archs } = await execFileAsync('/usr/bin/lipo', [path.join(mountedApp, 'Contents', 'MacOS', execName), '-archs']);
        if (!archs.trim().split(/\s+/).includes(expectedLipoArch)) throw new Error('Architecture mismatch');
      }
    } catch (error) {
      throw Object.assign(error, { invalidBundle: true });
    }
    // Stage beside the installed app so replacement and rollback use same-volume renames.
    stagedRoot = await mkdtemp(path.join(path.dirname(targetAppPath), '.hongguo-update-stage-'));
    const stagedApp = path.join(stagedRoot, 'new.app');
    await execFileAsync('/usr/bin/ditto', [mountedApp, stagedApp]);
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
    return stagedApp;
  } catch (error) {
    if (stagedRoot) await rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await execFileAsync('/usr/bin/hdiutil', ['detach', mountDir]).catch(() =>
      execFileAsync('/usr/bin/hdiutil', ['detach', '-force', mountDir]).catch(() => {}));
  }
}

function defaultApplyAndRelaunch({ pid, targetAppPath, stagedApp, cleanupDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', SELF_REPLACE_SCRIPT, 'hongguo-updater', String(pid), targetAppPath, stagedApp, cleanupDir], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
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

function createMacUpdateDownloader({
  currentVersion,
  source,
  arch,
  tempDir,
  isEnabled,
  installBlocker = () => '',
  execPath = '',
  canSelfReplace = defaultCanSelfReplace,
  stageAppFromDmg = defaultStageAppFromDmg,
  applyAndRelaunch = defaultApplyAndRelaunch,
  quitApp = () => {},
  fetchRelease,
  downloadImage,
  openPath,
  emit,
}) {
  const idle = { supported: true, reason: '', mode: MAC_UPDATE_MODE, status: 'idle', version: null, percent: 0, error: '', downloaded: false, fallbackManual: false };
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
    if (state.status === 'installing') return Promise.resolve(result('正在安装更新。'));
    if (operation && !controller.signal.aborted) return operation;
    if (operation) {
      const request = generation;
      return operation.then(() => request === generation ? download(version) : result(cancelled));
    }
    if (ready && state.version === version) return Promise.resolve(result());
    cancel();
    controller = new AbortController();
    const { signal } = controller;
    update({ status: 'checking', version, fallbackManual: false });
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
        update({ status: 'downloaded', percent: 100, downloaded: true, error: '', fallbackManual: false });
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

  async function openFallbackDmg(image, errorMessage) {
    const blocked = installBlocker();
    if (blocked) {
      update({ status: 'downloaded', error: blocked });
      return { ...result(blocked), retryWhenIdle: true };
    }
    try {
      if (!(await openPath(image.file))) {
        update({ status: 'downloaded', error: '', fallbackManual: true });
        return result();
      }
    } catch {}
    const msg = errorMessage || '无法打开安装包，请稍后重试。';
    update({ status: 'error', error: msg });
    return result(msg);
  }

  async function install() {
    if (!isEnabled() || !ready) return result('请先完成更新下载。');
    if (state.status === 'installing') return result('正在安装更新。');
    const blocked = installBlocker();
    if (blocked) return { ...result(blocked), retryWhenIdle: true };
    const image = ready;
    const installGen = generation;
    update({ status: 'installing', error: '', fallbackManual: false });
    try { await verifyImage(image.file, image.asset); }
    catch {
      if (ready !== image) return result(cancelled);
      cancel();
      return result('安装包已失效，请重新下载更新。');
    }
    if (ready !== image || !isEnabled()) return result(cancelled);

    const targetAppPath = resolveMacAppPath(execPath);
    const selfReplaceable = targetAppPath ? await canSelfReplace(targetAppPath) : false;
    if (installGen !== generation || ready !== image || !isEnabled()) return result(cancelled);
    if (!selfReplaceable) return openFallbackDmg(image);

    let stagedApp;
    let handedOff = false;
    try {
      stagedApp = await stageAppFromDmg(image.file, image.dir, image.asset.version || state.version, arch, targetAppPath);
      if (installGen !== generation || ready !== image || !isEnabled()) return result(cancelled);
      const blockedAfter = installBlocker();
      if (blockedAfter) {
        update({ status: 'downloaded', error: blockedAfter });
        return { ...result(blockedAfter), retryWhenIdle: true };
      }
      await applyAndRelaunch({ pid: process.pid, targetAppPath, stagedApp, cleanupDir: image.dir });
      handedOff = true;
      ready = null;
      setImmediate(() => quitApp());
      return result();
    } catch (error) {
      if (installGen !== generation || ready !== image || !isEnabled()) return result(cancelled);
      if (error?.invalidBundle) {
        cancel();
        return result('更新包校验失败，请重新下载更新。');
      }
      return openFallbackDmg(image, '无法自动安装更新，请重试或前往发布页下载。');
    } finally {
      if (stagedApp && !handedOff && path.basename(path.dirname(stagedApp)).startsWith('.hongguo-update-stage-')) {
        await cleanup(path.dirname(stagedApp));
      }
    }
  }

  return { getState, download, install, cancel };
}

module.exports = { MAC_UPDATE_MODE, resolveMacAppPath, createMacDownloadTransport, createMacUpdateDownloader };
