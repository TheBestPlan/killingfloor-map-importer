# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · **中文** · [日本語](./README.ja.md)

把其他游戏的地图导入 **Killing Floor 1**，生成真正的 `.rom` 关卡（Unreal Engine 2.5，文件版本 128 / licensee 29）。整个包是从零写出来的——不用 KFEd，不经过中间格式，没有手工步骤：指向一个地图文件，就得到一个可以直接丢进 `KillingFloor\Maps` 开玩的 `.rom`。

目前的来源引擎是 **GoldSrc BSP v30**：Counter-Strike 1.6、Half-Life 及其 mod。读取来源游戏只是一个模块（`src/goldsrc/`），它前置于共用的构建与写入流水线，因此增加更多游戏就是既定的发展方向，见[路线图](#路线图更多来源游戏)。

> Unreal 这一侧全是手工逆向出来的。`UModel` v128 的序列化顺序，以及其中烘焙光照贴图的布局，任何地方都没有文档，也不存在公开的 GoldSrc → Unreal 转换器。研究记录在 [`docs/RESEARCH.md`](../RESEARCH.md)，每一个花掉时间的坑记在 [`docs/GOTCHAS.md`](../GOTCHAS.md)。

## 现状

| 能力 | 状态 |
| --- | --- |
| 几何、贴图、碰撞、出生点 | 可用——已在真实客户端里跑通 |
| 天空——地图自己的六张 `gfx/env` 图 | 可用 |
| 水——游泳、水下屏幕着色、分层贴图 | 可用 |
| 精灵图（`.spr`）与模型（`.mdl`） | 可用 |
| 门与可击碎玻璃 | 可用——`KFDoorMover` + `KFUseTrigger`、`KFGlassMover` |
| 烘焙光照 | 部分——luxel 已读取并打包成 DXT3 图集，但客户端只画区域环境光（见[还缺什么](#还缺什么)） |
| 区域 / PVS 遮挡、bot 路径、按钮与触发器 | 无 |

## 你需要什么

- 一份 **Killing Floor 1** 安装（或非 Steam 版 SDK）——成品 `.rom` 放进去。
- 一份 **Counter-Strike 1.6 / Half-Life** 安装——原版 `.wad` 贴图库和 `gfx/env` 天空盒都在那里。下载来的地图通常只有一个 `.bsp`，少了它们所有贴图会变成品红占位色，而且完全没有天空。
- 命令行需要 **Node.js ≥ 18**。桌面应用不需要额外东西。

本仓库不附带任何游戏内容，两个方向都没有。是你把工具指向自己的安装目录。

## 桌面应用（Windows / macOS / Linux）

预编译的独立版本在 [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases) 页面：

- **Windows** — `…-setup.exe`（安装版）或 `…-portable.exe`（免安装）。
- **macOS** — `…-mac-x64.dmg`（Intel）或 `…-mac-arm64.dmg`（Apple Silicon）。
- **Linux** — `…-linux-x86_64.AppImage`（哪都能跑）或 `…-linux-amd64.deb`。

把 `.bsp` 拖进窗口，选好输出目录和 Counter-Strike 目录，按 Convert。每张地图在子进程里转换，所以崩溃或者超大地图不会把窗口一起带走。安装包未签名，首次启动时系统可能会警告（Windows SmartScreen → *更多信息 → 仍要运行*；macOS → 右键 → *打开*）。

### 自己构建

```bash
pnpm install
pnpm start          # 从源码运行应用
pnpm run dist       # 为当前系统构建安装包到 dist/
```

## 命令行

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `--out <文件\|目录>` | 与 `.bsp` 同级 | `.rom` 写到哪里 |
| `--name KF-Xxx` | `KF-<bsp 名>` | 包内的地图名 |
| `--scale <n>` | `1.9` | GoldSrc 单位 → Unreal 单位 |
| `--lightmap-scale <n>` | `32` | 以 Unreal 单位计的 luxel 大小 |
| `--cs-dir <目录>` | — | Counter-Strike 1.6 客户端目录：原版 `.wad`、`gfx/env` 天空、`sprites/*.spr` |
| `--wad <目录>` | 地图所在目录及其上两级 | 额外搜索 `.wad` 的目录 |
| `--geometry mesh\|bsp\|both` | `mesh` | 由谁绘制世界：静态网格、BSP，或 BSP 绘制而网格只做碰撞 |
| `--verify` | 关 | 用独立读取器回读成品 `.rom` 并校验不变量 |
| `--no-spawns` | 关 | 不搬运出生点 |
| `--ase` | 关 | 额外输出 `.ase` / `.t3d`（后端 B，供在 KFEd 里手工收尾） |

刻意保留的诊断开关：`--stock-sky "Pkg.Group.Name"`、`--no-sky`、`--no-extras`、`--no-light`、`--tree-translate`、`--spawn-index N`。环境变量 `KF_SPAWN_AT="x,y,z[,yaw]"` 会把所有出生点换成该点的一个——这是直接落到想看的位置的办法。

## 会搬过来的东西

| | 怎么搬 |
| --- | --- |
| 世界几何 | 静态网格，一网格一材质，按 2048 UU 网格切分，反向绕序（Y 轴镜像会翻转三角形朝向）；碰撞用它们的 kDOP 树 |
| brush 实体（`func_wall`、`func_illusionary`、`func_ladder` 等） | 同样处理，并考虑实体的 `origin` 键 |
| 门（`func_door`、`func_door_rotating`） | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger`——用使用键开启，可以像 KF 原生门那样焊死；`KeyPos`/`KeyRot` 来自 `angle`/`lip`/`distance` |
| 可击碎玻璃（`func_breakable`，material 0/7） | `KFMod.KFGlassMover`，`Health` 取自实体，`Style = STY_Translucent` |
| 水（`func_water`） | 半透明顶面，加上带真实 brush 盒的 `PhysicsVolume`（`bWaterVolume`、雾、溺水） |
| 精灵图（`env_sprite`、`env_glow`、`cycler_sprite`） | `Engine.Effects` 广告牌，按 `.spr` 贴图格式取 additive 或 alpha |
| 模型（同一批实体上的 `.mdl`） | 绑定姿势的静态网格，每个实例一个 actor；贴图取自模型或 `<名字>T.mdl` |
| 贴图 | 8 位 miptex → `UTexture` P8 + `UPalette`，**不重新编码**；GoldSrc 的 4 级 mip 用点采样一直续到 1×1 |
| 带遮罩的贴图（`{name`） | 调色板重排，透明索引从 255 挪到 0，置 `PF_Masked` |
| 天空 | 六张 `gfx/env/<skyname>*` → RGBA8（不做块压缩，否则渐变出现色带），贴在天空盒立方体上；网格里的 `sky` 面被裁掉；没有 `skyname` 时用引擎默认的 `desert` |
| 光照 | `ZoneInfo.AmbientBrightness` 取自地图自身 luxel 的阴影水平，再加上由光照实体生成的 `Light`/`Sunlight` actor；BSP 路线下还会在 `UModel` 内部生成 DXT3 光照图集 |
| 出生点 | `info_player_start` / `info_player_deathmatch` → `PlayerStart`，抬到地面上 |
| 缩放 | 默认 ×1.9（×2 是已发布的 `KF-CS-*` 移植测出来的值，而且能让 GoldSrc 的 16 单位 luxel 网格正好落在 UE2.5 的 32 UU 上） |

进不了世界的是那些不可见的工具贴图——`aaatrigger`、`clip`、`null`、`hint`——它们本来也不该在里面：cs_assault 3206 面里 48 面，de_dust2 5383 面里 25 面，cs_italy 8528 面里 36 面。

## 还缺什么

- **烘焙阴影。** GoldSrc 的 luxel 已经采样并写入，但客户端运行时不用它们，所以光照是平的——由地图自身 luxel 推出的区域环境光。多半得在 KFEd 里跑一遍 `Build Lighting`。
- **区域。** 永远只有两个（0 = 实体，1 = 世界），因此没有 PVS 遮挡：全都画。对 Counter-Strike 大小的地图可以接受。
- **Bot 路径。** 不生成 `PathNode` / `ReachSpec`——需要在 KFEd 里跑 `Build Paths`。
- **按钮和列车。** `func_button`、`trigger_*`、`func_train` 保持为静态几何。
- **动画贴图**按第 0 帧搬运；`-0`（随机平铺）当作普通贴图。
- **非二次幂贴图**会重采样到最近的二次幂（否则 UE2.5 按 `UBits` 计算缓冲区大小并破坏堆）。贴图轴按 `pot/orig` 缩放，所以 UV 不会偏。

## 路线图：更多来源游戏

流水线的划分让来源游戏成为唯一会变的部分：`src/goldsrc/` 读地图，`src/build/` 把它变成 Unreal 结构，`src/unreal/` 写包。加一个游戏就是写一个新的读取器，产出同样的中间形态——带 UV 的面、贴图、实体、光照图网格——`src/unreal/` 里什么都不用动。下一批显而易见的候选是 Quake、Quake II 和 Source 的 BSP 变体：同一族格式，最后落到同一个 `UModel` 写入器。

欢迎往这个方向贡献；先看 [`docs/RESEARCH.md`](../RESEARCH.md) 了解目标格式，再看 [`docs/GOTCHAS.md`](../GOTCHAS.md) 了解绝不能破坏的不变量。

## 怎么验证的

```bash
pnpm test          # node test/selfcheck.js
```

19 项检查，全绿。承重的那几项：

- `UModel` v128 序列化器把 **41 张官方 Killing Floor 地图逐字节重写一致**（唯一差异是 JS 会归一化的 signalling NaN 载荷）；
- compact index 和 `FString` 往返；
- 在 25 张 Counter-Strike 地图上：计算出的光照贴图体积能装进 `LIGHTING` lump，面的绕序满足 `Newell == −normal`，顶点落在自己面的平面上；
- 每个官方 `UPolys` 对象都严格符合布局（6054 个对象、37136 个多边形、0 处不符）；
- DXT3 编码器、`.mdl` 与 `.spr` 读取器、Lanczos 重采样。

游戏文件从常见的 Steam 位置查找；没有它们时这些检查会明确失败，而不是空过，所以 `pnpm test` 请在装了游戏的机器上跑（CI 只对打包做冒烟测试）。

`--verify` 用独立读取器回读成品 `.rom`，校验 22 项不变量：文件头、各表、serial 区间、引用可解析、节点平面为单位向量、顶点在其平面上、绕序、section 与节点多边形对应、光照贴图区间及其 UV 落在图集内、DXT3 结构正确、树确实是树，以及每张贴图都有完整 mip 链。实测，全部干净：

```
cs_assault  3206 面 -> 7247 三角形，323 个网格   149 张贴图  13.41 MB
de_dust2    5383 面 -> 9932 三角形，229 个网格    36 张贴图  12.05 MB
cs_italy    8528 面 -> 21038 三角形，396 个网格   89 张贴图  16.35 MB

cs_assault --geometry bsp   3158/3206 面 (98.5%)  3570 节点  3569 光照贴图  5 个图集  14.90 MB
```

`test/repack.js <地图.rom>` 用同一个写入器重建已有地图并逐字节比较：在 `KF-CS-Iceworld` 上差异是 **1 个字节**（`packageFlags`）。`test/render-test.ps1` 绕过大厅直接把客户端拉进地图，按 `KillingFloor.log` 里的 `Critical:` 行下判断。`KF-CS-Assault` 从全部 20 个出生点各跑一遍，没有一条 `Critical`。

**测试没覆盖的：** 地图在 KFEd 三维视口里的样子（那是另一条渲染路径），以及画面本身是否*正确*——测试抓的是崩溃，不是瑕疵。

## 在游戏里检查一张地图

[`harness/play.ps1`](../../harness/README.md) 把客户端拉进地图，用 `PostMessage` 驱动控制台，用引擎截图并转成 PNG；`harness/flat.js` 按边缘密度给帧打分（18–30 % 正常，约 1.4 % 说明世界没画出来）。要紧的规则：**在验证过测试台本身之前，否定结果一文不值**——先用一个已知能工作的案例跑一遍。细节和坑见 [`harness/README.md`](../../harness/README.md) 和 [`docs/GOTCHAS.md`](../GOTCHAS.md) 第 7 节。

## 目录结构

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                命令行入口
│  ├─ convert.js            完整流水线
│  ├─ verify.js             成品 .rom 的不变量校验
│  ├─ resources.js          去哪里找 .wad 和 gfx/env 天空
│  ├─ backendB.js           后端 B：.ase（网格 + 顶点色里的光照）+ .t3d + 8 位 BMP
│  ├─ goldsrc/              来源游戏：bsp.js、wad.js、mdl.js、spr.js、skybox.js
│  ├─ build/                GoldSrc → Unreal：model.js、mesh.js、brushents.js、propmesh.js、skybox*、upscale.js
│  └─ unreal/               包写入器：package.js、writer.js、model.js、staticmesh.js、polys.js、
│                           texture.js、dxt.js、read.js（--verify 用的独立读取器）
├─ electron/                桌面应用：main、preload、renderer、worker（子进程里做转换）
├─ test/                    selfcheck.js（pnpm test）、repack.js、render-test.ps1
├─ harness/                 play.ps1、flat.js、bmp2png.js——在真实客户端里看地图
├─ scripts/                 当初用来啃格式的研究工具（见 docs/RESEARCH.md）
└─ docs/                    RESEARCH.md、GOTCHAS.md、translations/
```

## 文档

- **[docs/RESEARCH.md](../RESEARCH.md)** — 格式研究：两侧各测了什么、`UModel` v128 的序列化顺序、三种可行架构以及为什么选了这一种、现有 `KF-CS-*` 移植实际上是怎么做出来的。
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — 所有实测出的坑，包括那五条一旦违反就会让引擎崩溃的不变量。改写入器之前必读。
- **[harness/README.md](../../harness/README.md)** — 在真实客户端里检查转换后的地图。

## 法律边界

转换一张地图并不等于有权发布它。Valve 允许在非商业 mod 里跨游戏搬运素材，但明确要求**不要原样移植原版地图**；Tripwire 要求 mod 不得包含未经书面许可的第三方受保护财产，并且必须免费分发。两个公开的 Counter-Strike 地图 KF 移植（`KF-Dust_1`、`KF-Assault`）都已被 Steam 创意工坊下架。自制地图归其作者所有，而不是 Valve——许可要向他们要。

这个导入器不附带任何游戏内容，自己也不产出什么：它写出来的东西源自你喂给它的地图，而那些东西能去哪里，是你和来源地图版权方之间的事。

## 免责声明

个人的逆向工程与格式互操作项目，出于研究与教育目的公开。对引擎包格式做逆向工程可能与游戏 EULA 冲突——如何使用这些代码，责任完全在你。按**原样**提供，不附带任何担保（见许可证）。与 Tripwire Interactive、Epic Games、Valve 均无关联。

## 许可证

Copyright (c) 2026 Geekrainian.

以 **GNU General Public License v3.0 或更新版本**（GPL-3.0-or-later）发布。完整文本见 [LICENSE](../../LICENSE)。本程序是自由软件：你可以在这些条款下重新分发和修改它，并且它**不带任何担保**。

## 商标声明

Killing Floor 与 Unreal 是 Tripwire Interactive 和 Epic Games 的商标；Counter-Strike、Half-Life、GoldSrc 是 Valve 的商标。本项目是非官方的粉丝工具，与上述各方无关，也未获其背书。
