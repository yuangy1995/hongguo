const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { build, macRelease } = require('../package.json');

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function verifyCatalinaBinary(file) {
  assert.equal(run('/usr/bin/lipo', ['-archs', file]), 'x86_64', `${file} 必须是 Intel x64`);
  const commands = run('/usr/bin/vtool', ['-show-build', file]);
  assert.match(commands, /\bLC_VERSION_MIN_MACOSX\b|^\s*platform MACOS\s*$/m, `${file} 缺少 macOS 构建标记`);
  const version = commands.match(/^\s*(?:minos|version)\s+(\d+)\.(\d+)(?:\.(\d+))?\s*$/m);
  assert(version, `${file} 缺少最低系统版本`);
  const [, major, minor, patch = '0'] = version;
  const versionNumber = Number(major) * 10_000 + Number(minor) * 100 + Number(patch);
  assert(versionNumber <= 101_500, `${file} 最低需要 macOS ${[major, minor, patch].join('.')}`);
}

function nativeFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...nativeFiles(file));
    } else if (entry.isFile()) {
      const fd = fs.openSync(file, 'r');
      try {
        const magic = Buffer.alloc(4);
        if (fs.readSync(fd, magic) !== 4) continue;
        if (['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'cafebabf'].includes(magic.toString('hex'))) files.push(file);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return files;
}

function verifyCatalinaApp(bundle) {
  const contents = path.join(bundle, 'Contents');
  const framework = path.join(contents, 'Frameworks', 'Electron Framework.framework');
  const readPlist = (file, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file]);
  const info = path.join(contents, 'Info.plist');
  assert.equal(readPlist(info, 'LSMinimumSystemVersion'), build.mac.minimumSystemVersion);
  assert.equal(readPlist(info, 'CFBundleIdentifier'), build.appId);
  assert.equal(readPlist(info, 'CFBundleShortVersionString'), macRelease.version);
  assert.equal(readPlist(path.join(framework, 'Resources', 'Info.plist'), 'CFBundleShortVersionString'), build.electronVersion);

  const resources = path.join(contents, 'Resources');
  assert(!fs.existsSync(path.join(resources, 'app-update.yml')), 'Catalina 包含公共更新清单');
  for (const name of ['ffmpeg', 'ffprobe', 'librempeg']) {
    fs.accessSync(path.join(resources, 'bin', name), fs.constants.X_OK);
  }
  const binaries = nativeFiles(contents);
  assert(binaries.length >= 5, '应用缺少原生组件');
  binaries.forEach(verifyCatalinaBinary);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
  assert.equal(signature.status, 0);
  assert.match(signature.stderr, /^Signature=adhoc$/m);
  console.log(`Catalina 包检查通过，已核对 ${binaries.length} 个 Intel Mach-O 和临时签名。`);
}

if (require.main === module) {
  assert(process.argv[2], '用法：node scripts/verify-catalina-app.cjs /path/to/app');
  verifyCatalinaApp(process.argv[2]);
}

module.exports = { verifyCatalinaApp, verifyCatalinaBinary };
