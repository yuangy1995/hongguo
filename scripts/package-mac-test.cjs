const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { macRelease } = require('../package.json');

assert.equal(process.platform, 'darwin', '本地测试包需要 macOS');
assert.equal(process.arch, 'arm64', '本地测试包面向 Apple 芯片 Mac');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const product = '红果短剧本地测试';
const bundleName = `${product}.app`;
const bundleId = 'io.github.yuangy1995.hongguo.local';
const output = path.join(dist, 'local-mac-test', 'mac-arm64');
const destination = path.join(output, bundleName);
const legacyBuilds = [
  ['local-mac-1.0.0', '红果短剧.app', 'io.github.jackotom.hongguo-drama-mac'],
  ['local-mac-1.0.0-isolated', bundleName, bundleId],
  ['local-mac-1.0.0-mist-layout', bundleName, bundleId],
];

const plist = (bundle, key) => execFileSync('/usr/libexec/PlistBuddy',
  ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const running = bundle => execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n')
  .some(command => command.trimStart().startsWith(`${bundle}/Contents/`));
const plainDirectory = directory => fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory();

function verify(bundle) {
  assert.equal(plist(bundle, 'CFBundleShortVersionString'), macRelease.version);
  assert.equal(plist(bundle, 'CFBundleIdentifier'), bundleId);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
}

function cleanLegacyBuilds() {
  for (const [name, app, id] of legacyBuilds) {
    const directory = path.join(dist, name);
    const archDir = path.join(directory, 'mac-arm64');
    if (!plainDirectory(directory) || !plainDirectory(archDir)) continue;
    const bundle = path.join(archDir, app);
    if (!plainDirectory(bundle)) continue;
    if (running(bundle)) {
      console.warn(`旧测试版仍在运行，退出后可再次清理：${bundle}`);
      continue;
    }
    assert.equal(plist(bundle, 'CFBundleIdentifier'), id);
    fs.rmSync(bundle, { recursive: true });
    for (const generated of ['mac-arm64/.DS_Store', '.DS_Store', 'builder-debug.yml']) {
      try { fs.unlinkSync(path.join(directory, generated)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const icons = path.join(directory, '.icon-icns');
    if (plainDirectory(icons)) {
      const icon = path.join(icons, 'icon.icns');
      if (fs.lstatSync(icon, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(icon);
      if (!fs.readdirSync(icons).length) fs.rmdirSync(icons);
    }
    if (!fs.readdirSync(archDir).length) fs.rmdirSync(archDir);
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
    console.log(`已删除旧测试包：${bundle}`);
  }
}

if (process.argv[2] !== '--cleanup') {
  assert(!running(destination), '请先退出正在运行的本地测试版，再重新打包。');
  fs.mkdirSync(dist, { recursive: true });
  const stage = fs.mkdtempSync(path.join(dist, '.mac-test-'));
  const candidate = path.join(stage, 'mac-arm64', bundleName);
  const previous = path.join(stage, 'previous.app');
  try {
    execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'),
      '--config', 'build/electron-builder-mac.cjs', '--mac', '--arm64', '--dir', '--publish', 'never',
      `--config.directories.output=${stage}`, `--config.productName=${product}`,
      `--config.appId=${bundleId}`, '--config.extraMetadata.name=yuangy1995-hongguo-local',
    ], { cwd: root, stdio: 'inherit' });
    verify(candidate);
    fs.mkdirSync(output, { recursive: true });
    assert(!running(destination), '本地测试版正在运行，请退出后再重新打包。');
    if (fs.existsSync(destination)) {
      assert.equal(plist(destination, 'CFBundleIdentifier'), bundleId);
      fs.renameSync(destination, previous);
    }
    try { fs.renameSync(candidate, destination); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
  } finally {
    if (!fs.existsSync(previous) || fs.existsSync(destination)) fs.rmSync(stage, { recursive: true });
  }
}

verify(destination);
cleanLegacyBuilds();
console.log(`本地测试包：${destination}`);
