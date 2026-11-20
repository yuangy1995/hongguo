"""从已核对的上游发行包恢复对应架构的媒体工具和源码。"""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

before = '6a3df3b0b03e8a63589a73e375e9058f181930e8'
repo = 'https://github.com/jackotom/hongguo-drama/releases/download/v7.6/'
assets = {
    'arm64': {
        'hongguo-downloader-7.6-mac-arm64.zip': '920213eba8b2776db5c667b994fd33426ec2a9109126ceb51b71c84620a8ae6b',
        'ffmpeg-9.0.2-x264-b35605a-corresponding-source.tar.gz': 'bfcac890fe098e27bd1cdc4209837377ecaae3bea4fc5b1ea197ec4ab1c2b2e9',
    },
    'x64': {
        'hongguo-downloader-7.6-mac-x64.zip': '6e75ca81ec724d0c5de0e183c2ee27e36c0c4fa95fa55ce62b79c692c493308a',
        'ffmpeg-9.0.2-x264-b35605a-x64-corresponding-source.tar.gz': 'ad68bf181e6bcc8609bcfad68a4a1c071b046af7743fd21b4e645132080eba60',
    },
}

arch, work = sys.argv[1:]
folder = Path(work)
folder.mkdir(parents=True, exist_ok=True)
tools = Path('build/ffmpeg') / f'darwin-{arch}'
tools.mkdir(parents=True, exist_ok=True)
assets[arch][f'librempeg-cb1f8f3-x264-b35605a-{arch}-corresponding-source.tar.gz'] = 'f137ddc4f13213e25f8a2fa17e5c27857e6dd7decc903049e07f62cc52fc0d3c'

for source in ('build-ffmpeg-source-mac.sh', 'build-ffmpeg-source-mac-x64.sh',
               'build-librempeg-source.sh', 'librempeg-videotoolbox-prototype.patch'):
    path = Path('scripts') / source
    if subprocess.check_output(['git', 'show', f'{before}:{path.as_posix()}']) != path.read_bytes():
        raise ValueError(f'媒体构建输入已变化：{path}')

for name, checksum in assets[arch].items():
    target = folder / name
    subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--retry', '3',
                    '--retry-all-errors', '--connect-timeout', '15', '--max-time', '120',
                    '--output', str(target), repo + name], check=True)
    with target.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != checksum:
            raise ValueError(f'媒体附件校验失败：{name}')
    if target.suffix != '.zip':
        continue
    with zipfile.ZipFile(target) as archive:
        for name in ('ffmpeg', 'ffprobe', 'librempeg'):
            member, = [f for f in archive.namelist() if f.endswith(f'/Contents/Resources/bin/{name}')
                       and not f.startswith('__MACOSX/')]
            dest = tools / name
            with archive.open(member) as source, dest.open('wb') as out:
                shutil.copyfileobj(source, out)
            dest.chmod(0o755)
            subprocess.run(['lipo', str(dest), '-verify_arch', 'x86_64' if arch == 'x64' else 'arm64'], check=True)
