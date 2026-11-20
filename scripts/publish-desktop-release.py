"""在 GitHub Actions 上核对四个平台的成品并发布同一版本。"""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import quote
import zipfile

repo = os.environ['GITHUB_REPOSITORY']
sha = os.environ['GITHUB_SHA']
assert os.environ['GITHUB_ACTIONS'] == 'true' and repo == 'yuangy1995/hongguo'
assert os.environ['GITHUB_REF'] == 'refs/heads/main'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == sha
version = json.loads(Path('package.json').read_text())['version']
tag = f'v{version}'
inputs = Path(sys.argv[1])
output = Path('release-assets')
output.mkdir(exist_ok=False)


def digest(path, algorithm='sha256'):
    with path.open('rb') as f:
        return hashlib.file_digest(f, algorithm).digest()


def collect(group, manifest, expected):
    folder = inputs / group
    assert (folder / 'SOURCE-SHA.txt').read_text(encoding='utf-8-sig').strip() == sha, group
    found = set()
    for line in (folder / manifest).read_text(encoding='utf-8-sig').splitlines():
        checksum, entry = line.split(maxsplit=1)
        name = Path(entry).name
        file = folder / name
        assert digest(file).hex() == checksum.lower(), name
        if name != 'SOURCE-SHA.txt':
            assert name in expected and not (output / name).exists(), name
            shutil.copy2(file, output / name)
            found.add(name)
    assert found == expected, (group, expected - found)


def name(suffix):
    return f'hongguo-downloader-{version}-{suffix}'


def check_playback(states):
    assert len(states) == 2
    for s in states:
        assert s['muted'] and s['volume'] == 0 and s['time'] >= 10

for arch, ffmpeg_suffix in (('arm64', ''), ('x64', '-x64')):
    group = f'mac-release-{arch}'
    proof = json.loads((inputs / group / 'mac-result.json').read_text())
    assert proof['version'] == version and proof['arch'] == arch and proof['sourceCommit'] == sha and proof['launch']
    if arch == 'arm64':
        check_playback(proof['playback']['states'])
    collect(group, 'MACOS-SHA256SUMS.txt', {
        name(f'mac-{arch}.dmg'), f'ffmpeg-9.0.2-x264-b35605a{ffmpeg_suffix}-corresponding-source.tar.gz',
        f'librempeg-cb1f8f3-x264-b35605a-{arch}-corresponding-source.tar.gz',
    })

linux = 'linux-appimage-candidate'
proof = json.loads((inputs / linux / 'linux-verification/appimage-result.json').read_text())
assert proof['version'] == version and proof['sourceCommit'] == sha and proof['passed']
check_playback(proof['realPlayback']['states'])
collect(linux, 'LINUX-SHA256SUMS.txt', {
    name('linux-x64.AppImage'), name('linux-source.zip'), 'ffmpeg-9.0.2-x264-b35605a-linux-x64-corresponding-source.tar.gz',
    'librempeg-cb1f8f3-x264-b35605a-linux-x64-corresponding-source.tar.gz',
})

setup = name('win-x64-setup.exe')
portable = name('win-x64.exe')
collect('windows-release-candidate', 'WINDOWS-SHA256SUMS.txt', {
    setup, f'{setup}.blockmap', portable, name('win-x64.zip'), name('windows-source.zip'), 'latest.yml',
    'ffmpeg-9.0.2-x264-b35605a-win-x64-corresponding-source.tar.gz',
    'librempeg-cb1f8f3-x264-b35605a-win-x64-corresponding-source.tar.gz',
})
manifest = (output / 'latest.yml').read_text(encoding='utf-8-sig')
assert f'version: {version}' in manifest.splitlines() and setup in manifest
assert base64.b64encode(digest(output / setup, 'sha512')).decode() in manifest
with zipfile.ZipFile(output / name('win-x64.zip')) as archive:
    assert archive.namelist() == [portable]
    with archive.open(portable) as stream:
        assert hashlib.file_digest(stream, 'sha256').digest() == digest(output / portable)

subprocess.run(['git', 'archive', '--format=zip', f'--prefix=hongguo-{version}/',
                '-o', str(output / f'hongguo-{version}-source.zip'), sha], check=True)
files = sorted(output.iterdir())
checksums = {f.name: digest(f).hex() for f in files}
sums = output / 'SHA256SUMS.txt'
sums.write_text(''.join(f'{checksums[f.name]}  {f.name}\n' for f in files))
checksums[sums.name] = digest(sums).hex()
files.append(sums)

def release():
    result = subprocess.check_output(['gh', 'api', f'repos/{repo}/releases?per_page=100',
        '--jq', f'.[]|select(.tag_name=="{tag}")'], text=True).strip()
    return json.loads(result) if result else None

data = release()
if data is None:
    subprocess.run(['gh', 'release', 'create', tag, '-R', repo, '--draft', '--target', sha,
                    '--title', f'红果短剧桌面版 {version}', '--notes-file', f'docs/release-notes/{version}.md'], check=True)
    data = release()
def verify(data, draft):
    assert data['draft'] is draft and data['target_commitish']==sha and not data['prerelease']
    remote = {a['name']: a for a in data['assets']}
    assert set(remote)==set(checksums)
    for n, a in remote.items():
        assert a['state']=='uploaded' and a['digest']=='sha256:'+checksums[n] and a['size']==(output/n).stat().st_size, n

assert data['target_commitish'] == sha and not data['prerelease']
if data['draft']:
    uploaded = set()
    for a in data['assets']:
        n = a['name']
        assert n in checksums, n
        if a['state']=='starter':
            assert a['size']==0, n
            subprocess.run(['gh', 'api', '-X', 'DELETE', f'repos/{repo}/releases/assets/{a["id"]}'],check=True)
        else:
            assert a['state']=='uploaded' and a['digest']=='sha256:'+checksums[n] and a['size']==(output/n).stat().st_size, n
            uploaded.add(n)

    missing = [str(f) for f in files if f.name not in uploaded]
    if missing:
        subprocess.run(['gh', 'release', 'upload', tag, '-R', repo, *missing], check=True)

    verify(release(), True)
    subprocess.run(['gh', 'release', 'edit', tag, '-R', repo, '--draft=false', '--latest'], check=True)
verify(release(), False)
latest = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/releases/latest'], text=True))
assert latest['tag_name'] == tag

def accessible(f):
    url = f'https://github.com/{repo}/releases/download/{tag}/{quote(f.name, safe="")}'
    subprocess.run(['curl', '-fLsSI', '--retry', '3', '--retry-all-errors', '--max-time', '30',
                    '-o', os.devnull, url], check=True)

with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(accessible, files))
print(f'已核对 {len(files)} 份公开附件：https://github.com/{repo}/releases/tag/{tag}')
