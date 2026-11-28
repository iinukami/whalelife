# 官方插件安装包

在控制台打开「插件商店」，选择插件，点击版本号旁的「安装」。如果需要其他插件，确认框会列出将安装、启用或沿用的版本。WhaleLife 从登记的 GitHub Release 获取缺少的发行文件，核对大小和 SHA-256，全部通过后开始安装。经校验的本机缓存可以重复使用。当前清单的实测基线为 Windows x64、WhaleLife 0.1.0。宿主从 0.1.1 起将清单中的单个宿主版本作为最低要求，也会检查声明的上界、平台和架构。

浏览商店、识别手动安装和卸载使用宿主随附的文件清单，可以离线进行。下载中断或校验失败时，控制台会显示失败的步骤，可以直接重试。已安装的依赖版本不兼容时，商店会提示用户先升级。

官方子插件声明它需要的最低父插件版本。例如，QQ 空间 0.5.2 要求 QQ 至少为 0.22.0。装有兼容版本时商店会沿用它，已停用时会提示启用。从空缓存安装时，商店会选择清单中适配当前宿主和平台、且达到最低要求的最新父插件。已使用旧版商店的用户需要更新宿主才能使用此规则。

| 插件 | 版本 | 程序文件数 | 此版验证的必需插件 |
| --- | --- | ---: | --- |
| QQ | 0.26.0 | 2925 | — |
| QQ 空间 | 0.5.2 | 136 | QQ 0.22.0、0.23.0、0.24.0、0.25.0、0.26.0（最低 0.22.0） |
| 自主性 | 0.6.3 | 16 | — |
| 图库 | 0.1.4 | 382 | — |
| 网上冲浪 | 0.1.1 | 1239 | — |
| B 站 | 0.2.10 | 339 | 网上冲浪 0.1.1 |
| 视听理解 | 0.5.0 | 386 | — |
| 电脑与文件 | 0.4.0 | 28 | — |

## 从公开源码重建缓存

使用 Windows x64 版 Node.js 24.22.1、随附的 npm 11.19.1 和 Git。下方示例使用早期发行包的 `core.autocrlf=true` 检出设置。换行、打包器和压缩库都会影响最终字节，各版本的构建差异见相应插件小节。宿主无需在插件安装时运行 npm 或构建脚本。

以下 PowerShell 命令从**主仓根目录**运行。将 `$pluginId` 换成所需插件标识，源码目录选择一个空位置。清单中保存了每款插件的原仓库、精确提交、缓存字节数和 SHA-256。[发行清单](official-releases.json)

```powershell
$pluginId = 'gallery'
$hostRoot = (Get-Location).Path
$market = Get-Content -Raw ./market/official-releases.json | ConvertFrom-Json
$plugin = $market.plugins | Where-Object id -eq $pluginId
$release = $plugin.verifiedReleases | Where-Object { !$_.recognitionOnly -and $_.platform -eq 'win32' -and $_.arch -eq 'x64' } | Select-Object -First 1
$source = Join-Path (Split-Path $hostRoot) ("whalelife-plugin-" + $pluginId)
git -c core.autocrlf=true clone --no-checkout $plugin.repository $source
if ($LASTEXITCODE) { throw '获取源码失败' }
git -C $source -c core.autocrlf=true checkout --detach $release.sourceCommit
if ($LASTEXITCODE) { throw '检出指定提交失败' }
Push-Location $source
try {
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE) { throw '安装构建依赖失败' }
  if ($pluginId -eq 'qq') {
    $vendor = New-Item -ItemType Directory -Force .artifacts/vendor
    $upstream = 'https://github.com/iinukami/whalelife-plugin-qq/releases/download/v0.19.3'
    foreach ($name in 'NapCat.Shell.Windows.Node.zip', 'NapCat.Framework.zip') {
      Invoke-WebRequest "$upstream/$name" -OutFile (Join-Path $vendor.FullName $name) -ErrorAction Stop
    }
    foreach ($step in 'prepare:engine', 'prepare:desktop', 'prepare:attach') {
      npm run $step
      if ($LASTEXITCODE) { throw "准备桌面组件失败 $step" }
    }
    node scripts/build.mjs --desktop
  } else {
    npm run build
  }
  if ($LASTEXITCODE) { throw '插件构建失败' }
} finally {
  Pop-Location
}
node ./market/tools/cache-official.mjs $pluginId $source
```

缓存工具读取插件构建脚本生成的 `BUILD.json`，校验所有程序文件并按路径排序。gzip 解包后的首行是 `{"format":1,"files":[...]}` 加 LF，记录每个文件的相对路径、字节数和 SHA-256，随后依清单顺序连接原始内容。封装完成后再次比较整包摘要、文件数和字节数，通过后保存到 `.artifacts/official-packages/<sha256>.wlpkg.gz`。第三个参数可指定另一台实例的缓存准备目录。

### QQ 桌面组件

QQ 0.22.0、0.23.0、0.24.0、0.25.0 和 0.26.0 桌面版使用相同的 NapCat 4.18.41 Shell、Framework 和 Frida 17.24.0 原生绑定。维护者可以使用插件作者 v0.19.3 Release 已提供的同版本原包，两项资产的 GitHub 摘要与当前 `engine.lock.json`、`desktop-engine.lock.json` 一致。第三方使用和再分发条件见插件的 `THIRD_PARTY_NOTICES.md` 与 NapCat 原许可证。[Shell 原包](https://github.com/iinukami/whalelife-plugin-qq/releases/download/v0.19.3/NapCat.Shell.Windows.Node.zip) · [Framework 原包](https://github.com/iinukami/whalelife-plugin-qq/releases/download/v0.19.3/NapCat.Framework.zip)

0.23.0 保留了本次桌面构建中的文件换行。QQ 主程序和随包的图库入口均已从对应提交独立编译并逐字节比对。需要相同缓存字节时可直接使用本版商店附件。[QQ v0.23.0](https://github.com/iinukami/whalelife-plugin-qq/releases/tag/v0.23.0)

上方构建命令自动下载两个原包。已有原包的维护者也可以在插件源码根目录的 `.artifacts/vendor/` 放入同名文件并跳过下载。准备脚本核对组件版本和摘要，桌面构建核对最终文件清单。

### 视听理解

视听理解 0.5.0 的插件仓附件提供 382 个程序文件。安装时，控制台另外从 Gyan 的 GitHub Release 下载锁定的 FFmpeg 9.0.2 归档，校验后取出 `ffmpeg.exe`、`ffprobe.exe`、`LICENSE`、`README.txt`。组合后的 386 个文件与原 Windows x64 完整安装一致。语音模型、Ollama 和视觉模型由用户在插件设置中另行准备。[插件的 FFmpeg 固定版本及文件摘要](https://github.com/iinukami/whalelife-plugin-vision/blob/c95330d3a8323debd6684113222c729b6418e5fa/vendor/ffmpeg.json)

维护者可使用 Node.js 24.22.1 对原始完整本地包执行以下命令。第一条构建插件仓附件，第二条独立核对文件清单、每项内容和压缩封装。上传时只选择第二条通过的附件。含 FFmpeg 的完整本地包仍受插件仓的 `build:release` 和 `release:check` 检查，源码材料审查进度见插件仓。[FFmpeg 材料说明](https://github.com/iinukami/whalelife-plugin-vision/blob/c95330d3a8323debd6684113222c729b6418e5fa/vendor/FFMPEG-SOURCE-REVIEW.md)

```powershell
$full = './.artifacts/official-packages/d5a0e8331722fefdd930c33465a29a6362a8d2961d10a241cab38d73558cf9dc.wlpkg.gz'
$part = './.artifacts/vision-0.5.0-win32-x64-plugin-only.wlpkg.gz'
node ./market/tools/vision-without-decoders.mjs build $full $part
node ./market/tools/vision-without-decoders.mjs check $part
```

### 电脑与文件

电脑与文件 0.4.0 的 Windows x64 包从源码提交 `caca7fb3746d9bba1bd9368d84700287ff78db87` 独立构建。25 个文本及源码文件保留该提交的 Git 原始字节，`SandboxRunner.exe` 与 `DesktopPointer.exe` 使用 Windows 自带的 .NET Framework C# 编译器从同版源码重新编译；连同 `BUILD.json` 共 28 个文件。发行包不附带 MouseMux、Chrome 或 .NET 运行时，也不包含用户资料。重新编译的原生文件可能有不同的构建标识，需要与商店缓存逐字节一致时，请使用 [v0.4.0 公开附件](https://github.com/iinukami/whalelife-plugin-computer/releases/tag/v0.4.0)。

## 识别手动安装

`recognitionOnly` 条目的 SHA-256 对应 `market/inventories/<sha256>.json` 的原始字节。这些清单用于逐文件识别现有程序及卸载校验，安装按钮只选择可安装包。历史程序保留其发行时的实际换行和文档摘要，校验时严格比较原始字节。

QQ 0.23.0 登记了两种文件清单。商店包有 2,925 个文件。已验证的手动安装还留有旧版随附的 18 个程序文件，商店可依据第二份清单识别这个版本。

图库 0.1.3 同时登记了商店构建和已验证的手动安装构建，两份清单各含 382 个文件。

电脑与文件 0.1.2 使用该版留存的 Windows x64 构建，共 22 个文件（含 `BUILD.json`）。已按本版清单核对 `SandboxRunner.exe` 及其源码。从源码构建会重新编译该组件。需要与商店缓存逐字节一致的安装包时，请使用本版公开附件。[电脑与文件 v0.1.2](https://github.com/iinukami/whalelife-plugin-computer/releases/tag/v0.1.2)

电脑与文件 0.4.0 另保留此前已验证的手动部署清单，分别识别带 `BUILD.json` 的 28 文件构建和不带该文件的 27 文件部署。它们与公开包的部分文本换行及原生编译字节不同；识别条目只保存相对路径、大小和摘要，安装仍统一使用本次公开包。

电脑与文件 `computer` 0.1.0 的 Windows x64 安装包使用开发者保留的原始构建产物，对应源码提交 `c05d81d4828e4040d30a7915582ebcc43b2fbbcc`。原生组件 `SandboxRunner.exe` 按当时留存的字节校验。保留的历史文件清单可逐一核验 21 个发行文件及 `BUILD.json`，因此已有手动安装可直接识别。

B 站 0.2.10 同时登记了公开构建和此前手动安装的文件清单。两者部分文本的换行不同，宿主依各自的文件摘要识别。

七款公开开发仓的原构建均对照相应源码提交复核。部分历史 README 与当前版不同，已按旧提交核对。图库 0.1.1 另对照首个公开提交重新构建，核对所有程序与生产依赖。分仓前的文档按独立开发发行目录核对，历史包内的依赖描述只比公开版少许可证或仓库元数据。部分 QQ 和空间手装环境的 Windows npm 启动器已按发行依赖锁独立重建，旧 QQ 的迁移脚本、开发文档以及自主性的旧验证文档均按原开发发行物识别。清单只保存相对文件名、大小与摘要。

每款插件自己的 `data/`、宿主配置和独立子插件由宿主保留。QQ 组件历史上会在 `vendor/napcat/` 写入 `beacon_report.log`、`guild1.db`、`guild1.db-shm` 和 `guild1.db-wal`，插件注册表的 `preserve` 列出了完整路径。它们属于运行资料，装卸及发行文件校验都应跳过。

## 构建验证记录

2026-11-20，使用 Windows x64 和 WhaleLife 0.1.0，为当时的八款插件（B 站 0.2.8、电脑与文件 0.1.0）单独启动一个无扩展插件、无发行包缓存的实例。通过 Edge 点击商店安装，八款均从登记的 GitHub 地址下载、通过校验，并以当时登记的版本启用。QQ 空间和 B 站分别在确认后同时装入 QQ 和网上冲浪。视听理解另从 FFmpeg 上游下载组件，安装后运行 ffmpeg 和 ffprobe 均报告 9.0.2。图库另做卸载重装测试，重新打开的原图、人工标签和候选数配置均与卸载前一致。

2026-11-20，在 Windows x64 隔离目录中检出各自公开提交，重建七款程序，复核插件自有构建清单并导入七个正式入口，均可取得 `apply`。图库另用全新源码和 `npm ci` 独立重建，所得压缩包再次符合清单中的 SHA-256。组件发布审批仍由相应插件仓负责。

2026-11-21，在 Windows x64 上用 WhaleLife 0.1.0 的隔离实例从空缓存安装 B 站 0.2.10。商店从 GitHub 下载网上冲浪 0.1.1 和 B 站的安装包，校验大小与 SHA-256 后依次启用两个插件。卸载并重装 B 站后，测试数据保留，网上冲浪继续运行。

2026-11-21，在 Windows x64 上用 WhaleLife 0.1.0 的隔离实例从空缓存安装电脑与文件 0.1.2。商店从 GitHub 下载 82,895 字节的安装包，核验 SHA-256 后启用插件。卸载并重装后，插件再次启用，测试文件的内容与卸载前一致。

在装有电脑与文件 0.1.0 的实例内，商店识别了旧版，并显示通往 0.1.2 Release 的更新提示。通过商店卸载旧版、安装 0.1.2 后，新版正常启用，原有测试文件内容保留，更新提示消失。

2026-11-21，在 Windows x64 的隔离实例从空缓存安装 QQ 空间 0.5.2。商店从两个公开 GitHub Release 匿名下载并校验安装包，依次启用 QQ 0.23.0 和 QQ 空间。分别预装 QQ 0.22.0 和 0.23.0 时，商店均沿用已有 QQ。卸载并重装空间保留了样例数据，空间仍在使用 QQ 时，商店阻止了父插件卸载。

2026-11-22，在 Windows x64 的 WhaleLife 0.1.0 和 0.1.1 隔离实例验证图库 0.1.3，0.1.1 从空缓存下载了公开安装包。用商店卸载图库 0.1.2、安装 0.1.3 后，两张样例原图、标签和插件设置均保留。新版可以批量归档这两张图，也能一起恢复。

同日验证 QQ 0.24.0。在 WhaleLife 0.1.1 的空缓存实例安装 QQ 空间 0.5.2 时，商店从公开 Release 下载并启用 QQ 0.24.0 和 QQ 空间。已有新版 QQ 时，商店沿用它。当时的测试先卸载 QQ 0.23.0，再安装 0.24.0，验证了 QQ、QQ 图库接入组件和 QQ 空间的样例数据保留。该次发布未验证商店原地更新。WhaleLife 0.1.0 的隔离实例也通过了相同安装与数据检查。

后续复核了 QQ 0.23.0 → 0.24.0 的商店原地更新。原目录在加载新版时要求兼容组件 `qq/gallery` 就绪，更新失败并恢复到 0.23.0。修正目录和宿主的条件子插件检查后，分别在基于 WhaleLife 0.1.0、0.1.1 的 Windows x64 隔离实例确认应用，QQ 均升级到 0.24.0 并正常运行。0.1.0 用例另核对了 QQ 已直接接入独立图库，QQ 空间继续运行，旧宿主兼容桥的文件和归属记录、五份测试配置与数据均保留。

图库 0.1.4 的卡片在 320、390 和 1152 像素宽度下通过浏览器验收。点击缩略图可以预览，右下角的勾选区可用鼠标或键盘操作，长标题和多枚标签均未遮住勾选区。

在包含本次商店清单的 WhaleLife 0.1.1 隔离实例中，从空缓存下载并安装了图库 0.1.4 的公开 Windows x64 安装包。商店能识别 0.1.3 正式包和按提交 `dd04b47` 构建的 0.1.3 手装版，两者都能原地更新。两张样例原图的文件内容、标签和图库设置均保留，更新后仍可批量归档和恢复。WhaleLife 0.1.0 的隔离实例使用保留数据的卸载重装流程，也通过了相同的数据检查。

另在宿主提交 `aa433167` 自带的旧商店清单上验证了远端更新检查。图库 0.1.3 正式包可直接升到 0.1.4。`dd04b47` 手装版需要先同步本次宿主商店清单，才能被识别并获得更新。

2026-11-23，在 Windows x64 隔离实例中验证 QQ 0.25.0，最低宿主版本为 0.1.3。宿主 0.1.2 沿用 QQ 0.24.0。宿主 0.1.3 在商店检查、预览并确认更新后，QQ 从 0.24.0 原地升到 0.25.0，QQ 空间 0.5.2 和独立图库继续运行。通过本机模拟的 OneBot 消息和模型回复核对了同一私聊会话的人格切换。升级移除了 QQ 原先固定的人格设置，其他 QQ 配置和五项测试数据均保留。

2026-11-24，在 Windows x64 的宿主 0.1.3 和 0.1.5 隔离实例验证 QQ 0.25.0 → 0.26.0 的商店原地更新。QQ 空间 0.5.2、群聊 0.6.10 和独立图库继续运行，非默认配置、六项样例资料及独立子插件程序保留。宿主 0.1.5 另通过从空缓存连同群聊安装 QQ、先更新 QQ 再安装群聊的路径，并用本机模拟服务验证私聊收发、群列表和成员查询。随包的 `qq/gallery` 文件及归属保留，运行时依宿主能力按条件注册。

QQ 0.26.0 的最低宿主为 0.1.3。使用同一份主程序，在宿主 0.1.3 验证辅助识图，在 0.1.5 验证主模型接收原图和明确拒图时的辅助回退，限流与超时保留原始错误。上述业务检查使用本机模拟的 OneBot 和模型服务。完整包按 Git 原始换行构建，1,766 个桌面运行组件文件与 0.25.0 逐字节相同，NapCat 许可证仅有换行差异，正文一致。

2026-11-28，在 Windows x64 验证电脑与文件 0.4.0 的最终 28 文件发行包。163 项回归全部通过，包含 Windows AppContainer、独立鼠标授权和临时专用 Chrome 本地页面的触点测试；在最低宿主 0.1.0（提交 `13bf1746a814c71e0faafa27e0d222504291401c`）的 7 项契约检查全部通过。新能力分别授权且默认关闭，宿主最低要求保持 0.1.0。

同日，在 WhaleLife 0.1.7 隔离实例通过商店 HTTP 接口，从空缓存安装本版，并分别在旧版启用和停用时确认 0.1.2 → 0.4.0 更新。实际加载的版本、启停状态、原授权及限制、配置原始字节和样例数据均符合预期；两项新增授权保持关闭。安装后实际执行样例文件任务，卸载重装保留配置和样例资料。商店验收使用待发布的精确审核记录，从公开 GitHub Release 匿名下载旧、新安装包，核对缓存及安装后的文件；0.4.0 包为 116,566 字节，SHA-256 为 `d78a2c285315aa117487a250cf7c951e29310d98d7186c7d48a0439ef8143ee7`。测试限于隔离目录、合成资料和临时页面，浏览器触点的页面兼容范围见插件说明。
