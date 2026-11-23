"""提取已发布对应源码中的固定归档，实际二进制由 Catalina 构建脚本重编。"""
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

BASE_URL = 'https://github.com/yuangy1995/hongguo/releases/download/v1.0.6/'
X264 = 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz'
INPUTS = {
    'ffmpeg-9.0.2-x264-b35605a-x64-corresponding-source.tar.gz': (
        '.source-build-x64', ('ffmpeg-9.0.2.tar.xz', X264),
    ),
    'librempeg-cb1f8f3-x264-b35605a-x64-corresponding-source.tar.gz': (
        '.librempeg-build-x64', ('librempeg-cb1f8f3eef84999e61b27e2d44664858179bc240.tar.gz', X264),
    ),
}

work = Path(sys.argv[1])
work.mkdir(parents=True, exist_ok=True)
for name, (build, inputs) in INPUTS.items():
    bundle = work / name
    subprocess.run(['curl', '-fsSL', '--retry', '3', '--max-time', '120',
                    '-o', str(bundle), BASE_URL + name], check=True)
    destination = Path('build/ffmpeg') / build / 'archives'
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(bundle, 'r:gz') as archive:
        for filename in inputs:
            member, = (entry for entry in archive.getmembers()
                       if entry.isfile() and Path(entry.name).name == filename)
            # Only write the known source archives. Their hashes are checked by the build scripts.
            with archive.extractfile(member) as source, (destination / filename).open('wb') as output:
                shutil.copyfileobj(source, output)
