# 红果短剧 Catalina 专用版

分支 `compat/macos-catalina` 基于红果短剧 1.0.6，构建目标为 Intel x64、macOS 10.15。应用名为「红果短剧 Catalina」，Bundle ID 为 `io.github.yuangy1995.hongguo.catalina`，默认资料和下载存放在 `~/Library/Application Support/hongguo-catalina/`。安装包通过本分支本地构建，应用内更新已关闭。

## 构建

在能取得依赖的 Mac 上使用 Node.js 22.12 或更新版本、Xcode 命令行工具和 `pkg-config`。Apple 芯片构建机还需要 Rosetta 来运行构建后的 x64 媒体工具。执行：

```sh
npm ci
npm run build:mac
```

产物为 `dist/hongguo-catalina-1.0.6-mac-x64.dmg`，使用临时签名。`npm run build:mac:dir` 可生成用于本地验收的 App。打包会校验应用身份、Electron 版本、原生文件架构和最低系统版本、独立更新配置以及签名。FFmpeg、ffprobe 和 Librempeg 从固定来源构建，Intel 特供版使用 CPU 转码。

推送此分支会在 GitHub 的 macOS 15 Intel 运行器上构建并验证启动。安装包、源码归档与摘要作为 Actions 的 `hongguo-catalina-intel` 构建产物保留 14 天。

Electron 32.3.3 是支持 Catalina 的最后一个 Electron 32 版本，已停止安全维护。

## 验证

在 macOS 10.15 的 Intel Mac 上将应用复制到独立测试目录，使用独立资料验证启动、扫码登录、随机选取一部红果短剧并真实下载，再静音播放和拖动进度。记录普通 H.264 和 ByteVC2 兼容播放的实际结果。开始播放前确认静音。

本轮已下载 FFmpeg 源码并核对固定 SHA256。构建命令的联网权限受限，npm 依赖及其余媒体源码尚未齐备，本机也缺少 `pkg-config`。已验证 Mach-O 检查能接受 10.15 的 Intel 文件并拒绝 Ventura 和 arm64 文件。安装包和 Catalina 真机验收仍待完成。
