# 本项目 1.0.0 首发

- 基于上游 7.6 的当前改版，桌面四平台使用 1.0.0 和同一个 `v1.0.0` 标签，在 [yuangy1995/hongguo Releases](https://github.com/yuangy1995/hongguo/releases) 发行。
- 原项目公告已移除。所有桌面版通过本项目发布页检查新版。Windows 安装版仍支持应用内下载和安装，便携版和 Linux 从发布页手动更新。
- macOS 后续使用临时签名。发布前核验 arm64 和 x64 的包与临时签名，按平台记录实际验证结果。自 1.0.3 起，Mac 和 Windows 安装版支持空闲时自动安装更新并重启。Mac 安装位置无法自动替换时仍可打开安装包手动替换。
- 上游原版继续使用其原有更新渠道，迁移到本项目时先安装本项目的包。

## 云端发行

在项目 GitHub Actions 手动运行「发布桌面版」，填写完整版本号，例如 `1.0.0`。先在 `docs/release-notes/1.0.0.md` 准备发行说明。四个平台都由 GitHub 托管的构建机从同一个主分支提交构建并验收。发布任务只接收同一次工作流的四平台成品，校验更新清单、对应源码和附件摘要，在发布草稿中汇总后设为 Latest。

## 手动合并上游

需要发新版本时，由维护者手动合并上游改动并检查本项目的功能，再通过 GitHub Actions 的「发布桌面版」启动四平台发行。

## 1.0.10 正式发行

1.0.10 已于 2026-11-25 16:27:38（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.10` 指向冻结提交 `56c406a39f690878d817a015498d42912be68701`。同一次工作流汇总双 Mac、Windows x64 和 Linux x64 共 20 份公开附件，并核对远端大小、SHA256、Windows 更新清单及匿名下载入口。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.10)和[四平台构建与验收](https://github.com/yuangy1995/hongguo/actions/runs/45574907218)。

- 两种 Mac DMG 的版本、架构、临时签名及隔离启动均通过。Linux AppImage 的启动、媒体工具及软件解码资源检查通过。Windows 在 GitHub 虚拟机通过启动、新装、同版本重装、从 1.80 迁移的资料保留检查及 173 项播放源回归测试；Windows EXE 未签名。
- 此前完整轮次 [45557318986](https://github.com/yuangy1995/hongguo/actions/runs/45557318986) 中，Apple 芯片 Mac 完成真实下载与静音播放验收，Linux 与 Windows 在云端随机样本拉取阶段遇到红果上游超时/无可用样本。依用户明确授权，最终轮跳过依赖红果服务器的云端真实下载与播放验收，保留其余全部构建、签名与安装启动检查。

## 1.0.9 正式发行

1.0.9 已于 2026-11-25 09:21:10（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.9` 指向冻结提交 `1ff1d7ab19dc4d4da661a33c51efdd9ba266a9a2`。同一次工作流汇总双 Mac、Windows x64 和 Linux x64 共 20 份公开附件，并核对远端大小、SHA256、Windows 更新清单及匿名下载入口。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.9)和[四平台构建与验收](https://github.com/yuangy1995/hongguo/actions/runs/45522709364)。

- 两种 Mac DMG 的版本、架构、临时签名及隔离启动均通过；Apple 芯片版完成真实下载与静音播放验收，Intel Mac 覆盖启动。
- Linux AppImage 通过隔离启动、媒体工具、软件解码资源及真实下载与静音播放检查。
- Windows x64 在 GitHub 虚拟机通过便携版真实下载队列与静音播放、新装、同版本重装及从 1.80 迁移的资料保留检查；Windows EXE 未签名。

## 1.0.8 正式发行

1.0.8 已于 2026-11-24 18:54:16（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.8` 指向冻结提交 `7787c3c9a41b5dda3dacdc99ba913ad1a32a93f6`。同一次工作流汇总双 Mac、Windows x64 和 Linux x64 共 20 份公开附件，并核对远端大小、SHA256、Windows 更新清单及匿名下载入口。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.8)和[四平台构建与验收](https://github.com/yuangy1995/hongguo/actions/runs/45377747597)。

- 两种 Mac DMG 的版本、架构、临时签名及隔离启动均通过。Linux AppImage 的启动、媒体工具及软件解码资源检查通过。Windows 在 GitHub 虚拟机通过启动、新装、同版本重装和从 1.80 迁移的资料保留检查。Windows EXE 未签名。
- 依用户要求，本次最终包验收跳过依赖红果服务器的真实下载与播放。独立的[源码回归](https://github.com/yuangy1995/hongguo/actions/runs/45377643214)通过。
- [此前的发行任务](https://github.com/yuangy1995/hongguo/actions/runs/45222407967/attempts/2)在 Apple Silicon 构建机排队期间被取消，Windows 两次验收分别遇到随机样本取源失败和脚本仍按旧文件名查找转码缓存。最终轮改用有可用构建机的 macOS 26，并修正 Windows 脚本的缓存检查。

## 1.0.7 正式发行

1.0.7 已于 2026-11-23 23:30:12（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.7` 指向冻结提交 `662a1f9417a3c70ac0fa077963a0bcf237f4da98`。同一次工作流汇总了双 Mac、Windows x64、Linux x64 产物，并于北京时间 23:30 完成 20 份公开附件校验。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.7)和[构建与验收](https://github.com/yuangy1995/hongguo/actions/runs/45192999506/attempts/4)。

- 两个 macOS 架构检查了 DMG、版本、临时签名和隔离启动。Linux 检查了 AppImage 启动及随包媒体工具和软件解码资源。Windows 在 GitHub 虚拟机检查了启动、新装、重装和从 1.80 升级。EXE 未签名。
- 本轮发行使用该版本的跳过真实下载和播放选项。独立全量源码回归有一项红果真实片源获取失败。其余定向检查覆盖观看记录的官方系列剧、无系列提示和失败重试。

## 1.0.6 正式发行

1.0.6 已于 2026-11-23 00:53:29（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.6` 对应源码 `a82855495ca4936c1fe5b901447b43aa50b4915a`。四平台由同一次工作流构建，共 20 份附件。发布任务核对了远端大小、SHA256、Windows 更新清单和匿名下载入口。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.6)及[构建和验收](https://github.com/yuangy1995/hongguo/actions/runs/45045427846)。

- 双 Mac DMG 的临时签名、版本、架构和启动检查通过。Apple 芯片版使用隔离资料从红果随机样本中下载《母凭子贵后被皇家宠上天3》第 1、2 集，静音播放各约 10 秒。Intel Mac 覆盖启动。
- Linux AppImage 在隔离资料中从红果随机选择并真实下载两集，静音播放各约 10 秒，启动、媒体工具和软件解码资源检查通过。
- Windows x64 在 GitHub 虚拟机通过便携版真实下载队列、随机红果素材静音播放、新装、重装和从 1.80 升级检查。EXE 未签名。各平台验收记录随本轮工作流产物保留。
- 云端收藏、点赞、预约、具体日期和本机收藏显示规则的定向检查，以及 [桌面、服务端和 Android 源码回归](https://github.com/yuangy1995/hongguo/actions/runs/45045360765)均通过。

## 1.0.5 正式发行

1.0.5 已于 2026-11-21 21:43:36（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.5` 对应源码 `9729fca0b096442cc10e5fcaba2696ea5d533d91`。四平台由同一次 GitHub Actions 工作流构建，共 20 份附件。发布任务已核对远端摘要和匿名下载入口。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.5)及[构建和验收](https://github.com/yuangy1995/hongguo/actions/runs/44909143926)。

- 双 Mac DMG 的临时签名、版本、架构和启动检查通过。已回读两个公开安装包并确认默认文件隔离设置启用。Apple 芯片版在隔离资料中下载《她那么骄》第 1、2 集并静音播放各约 10 秒。Intel Mac 覆盖启动。
- Linux AppImage 在隔离资料中下载《步步登阶第二部》第 21、22 集并静音播放各约 10 秒。Windows x64 在 GitHub 虚拟机通过便携版真实下载《首辅娇娘》第 55、56 集、静音播放、新装、重装及 1.80 升级检查，EXE 未签名。
- 本机隔离界面检查覆盖浅色、深色、导航选中项的对比度、键盘聚焦和竖屏切换。桌面及 Android 源码回归通过。见 [源码检查](https://github.com/yuangy1995/hongguo/actions/runs/44909141797)。

## 1.0.4 正式发行

1.0.4 已于 2026-11-21 00:00:45（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.4` 对应源码 `0f09655d20d133a00b4598b6064aed3c53b3ffbb`，四平台共 20 份附件。Apple 芯片构建机排队后成功分配，四个平台最终成品均来自同一次 GitHub Actions 工作流。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.4)及[构建和验收](https://github.com/yuangy1995/hongguo/actions/runs/44752665364)。

- 两种 Mac DMG 的临时签名、版本、架构和启动通过。Apple 芯片版在隔离资料中实际下载《诚信第一，我在都市找老赖们收债》第 1、2 集并静音播放各约 10 秒。Intel Mac 覆盖启动。
- Linux AppImage 在隔离资料中下载《她那么骄》第 52、53 集并静音播放各约 10 秒。Windows x64 在 GitHub 虚拟机通过便携版真实下载《做兄弟，在心中》第 37、38 集和静音播放、新装、重装及 1.80 升级检查，EXE 未签名。
- 本机隔离界面检查覆盖浅色、深色、竖屏、按状态查看分集以及键盘取消删除。通用源码检查包含桌面和 Android 回归，均通过。见 [源码检查](https://github.com/yuangy1995/hongguo/actions/runs/44752662327)。

## 1.0.3 正式发行

1.0.3 已于 2026-11-20 20:57:52（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.3` 对应源码 `7ec0d7281d4d2e59743dea8e2b176974ac469e54`，20 份附件及匿名下载入口已核对。见 [发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.3)及[四平台构建和验收](https://github.com/yuangy1995/hongguo/actions/runs/44738520421)。

- 双 Mac DMG 的临时签名、架构、版本和启动通过。Apple 芯片包通过红果随机素材《侯爷临终扶庶子上位，圣旨赐下后他慌了》第 1、2 集真实下载和各约 10 秒静音播放。Intel Mac 覆盖启动。
- Linux AppImage 在隔离资料中真实下载并静音播放《母凭子贵后被皇家宠上天3》第 69、70 集各约 10 秒，启动和软件解码资源检查通过。Windows x64 便携版在 GitHub 虚拟机真实下载《少夫人来自东北3》第 34、35 集并静音播放各约 10 秒，安装、重装及 1.80 升级检查通过，EXE 未签名。
- 自动下载、播放暂停更新、任务结束后继续安装、安装失败后的重试和回退均做了定向验证。使用公开 Apple 芯片 DMG 通过真实下载、校验、隔离应用替换及隔离启动检查。Windows 在线更新覆盖源码回归和更新清单核对，安装升级由最终安装包验证。见 [通用源码检查](https://github.com/yuangy1995/hongguo/actions/runs/44738517271)。

## 1.0.2 正式发行

1.0.2 已于 2026-11-20 18:46:33（Asia/Shanghai）公开并设为 Latest。标签 `v1.0.2` 对应源码 `8edef57556f9ebc4e0cba3e67a940e7cf1cccf09`。四平台共 20 份附件，含对应源码、更新清单和 SHA256。Mac 1.0.0 和 1.0.1 需从发布页下载安装一次，之后可在应用内下载新版 DMG。见 [1.0.2 发布页](https://github.com/yuangy1995/hongguo/releases/tag/v1.0.2)和[更新内容](release-notes/1.0.2.md)。

受 GitHub Apple 芯片构建机排队影响，本次采用同一冻结提交，从本机补建 Apple 芯片 DMG，其余三个平台使用 [GitHub 构建与验收成品](https://github.com/yuangy1995/hongguo/actions/runs/44705070926/attempts/3)。四个平台按同一个标签汇总和核验后公开。

- 两种 Mac DMG 均通过临时签名、架构、版本和隔离启动检查。Apple 芯片包另核对了三份媒体工具的架构及启动。按本次授权，最终 Mac 包的验收范围为包核验与启动。
- Linux x64 在隔离目录真实下载并静音播放《诚信第一，我在都市找老赖们收债》第 56、57 集各约 10 秒，核验了 AppImage 启动、媒体工具和软件解码资源。
- Windows x64 在 GitHub 虚拟机的实际便携版下载队列中下载《嫌疑人的秘密2藏金生死线》第 54、55 集并静音播放各约 10 秒。下载画质自动保存、新装、重装和 1.80 升级检查通过，EXE 未签名。

# 上游四平台发行规则（2026-11-17起）

- 后续正式Release提供macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage四平台附件，以及这些平台必要的更新清单、精确源码、对应媒体源码和SHA256。Docker、TV APK、手机APK不再发布。
- 四个平台仍共用公开版本、GitHub标签和一次Release。附件与必要验收齐备、远端大小和SHA256核对后，一次公开并设Latest。
- 每次发行页必须在附件列表前的醒目位置保留以下推荐；这是独立第三方项目，不计入本项目附件和平台验收：
  > **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护。
