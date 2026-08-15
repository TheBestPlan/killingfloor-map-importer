# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · **日本語**

他のゲームのマップを **Killing Floor 1** に本物の `.rom` レベル（Unreal Engine 2.5、ファイルバージョン 128 / licensee 29）として取り込むツールです。パッケージはゼロから書き出します——KFEd も中間フォーマットも手作業のステップも要りません。マップファイルを指定すれば、`KillingFloor\Maps` に置いてそのまま遊べる `.rom` が出てきます。

現時点のソースエンジンは **GoldSrc BSP v30**、つまり Counter-Strike 1.6、Half-Life とその MOD です。ソースゲームの読み取りは共通のビルド・書き出しパイプラインの手前にある単一モジュール（`src/goldsrc/`）なので、対応ゲームを増やすのが想定している成長の道筋です（[ロードマップ](#ロードマップソースゲームを増やす)参照）。

> Unreal 側はすべて手作業で解析しました。`UModel` v128 のシリアライズ順も、その中のベイク済みライトマップの配置も、どこにも文書化されておらず、公開されている GoldSrc → Unreal コンバータも存在しません。調査は [`docs/RESEARCH.md`](../RESEARCH.md)、時間を食った罠はすべて [`docs/GOTCHAS.md`](../GOTCHAS.md) にあります。

## 現状

| 機能 | 状態 |
| --- | --- |
| ジオメトリ、テクスチャ、コリジョン、スポーン地点 | 動作——実際のクライアントで確認済み |
| 空——マップ自身の `gfx/env` 6 枚の実画像 | 動作 |
| 水——遊泳、水中の画面色、レイヤードテクスチャ | 動作 |
| スプライト（`.spr`）とモデル（`.mdl`） | 動作 |
| ドアと割れるガラス | 動作——`KFDoorMover` + `KFUseTrigger`、`KFGlassMover` |
| ベイク済みライティング | 部分的——luxel は読み取って DXT3 アトラスに詰めているが、クライアントはゾーンの平坦なアンビエントしか描かない（[足りないもの](#足りないもの)参照） |
| ゾーン / PVS オクルージョン、ボットの経路、ボタンとトリガー | 未対応 |

## 必要なもの

- **Killing Floor 1** のインストール（または非 Steam 版 SDK）——完成した `.rom` の置き場所です。
- **Counter-Strike 1.6 / Half-Life** のインストール——標準の `.wad` テクスチャアーカイブと `gfx/env` のスカイボックスがそこにあります。ダウンロードしたマップはたいてい `.bsp` 単体で配布されるためこれらが必要で、無いとテクスチャはすべてマゼンタになり、空も出ません。
- CLI には **Node.js ≥ 18**。デスクトップアプリには追加のものは不要です。

このリポジトリはどちらの方向にもゲームコンテンツを同梱しません。自分のインストール先を指定して使います。

## デスクトップアプリ（Windows / macOS / Linux）

ビルド済みの自己完結パッケージは [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases) にあります:

- **Windows** — `…-setup.exe`（インストーラ）または `…-portable.exe`（インストール不要）。
- **macOS** — `…-mac-x64.dmg`（Intel）または `…-mac-arm64.dmg`（Apple Silicon）。
- **Linux** — `…-linux-x86_64.AppImage`（どこでも動く）または `…-linux-amd64.deb`。

`.bsp` をウィンドウにドロップし、出力フォルダと Counter-Strike のフォルダを選んで Convert を押します。マップごとに子プロセスで変換するので、クラッシュや巨大マップでウィンドウごと落ちることはありません。ビルドは未署名なので、初回起動時に OS が警告することがあります（Windows SmartScreen → *詳細情報 → 実行*、macOS → 右クリック → *開く*）。

### 自分でビルドする

```bash
pnpm install
pnpm start          # ソースからアプリを起動
pnpm run dist       # 現在の OS 向けインストーラを dist/ に生成
```

## CLI

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--out <ファイル\|フォルダ>` | `.bsp` の隣 | `.rom` の書き出し先 |
| `--name KF-Xxx` | `KF-<bsp 名>` | パッケージ内のマップ名 |
| `--scale <n>` | `1.9` | GoldSrc 単位 → Unreal 単位 |
| `--lightmap-scale <n>` | `32` | Unreal 単位での luxel サイズ |
| `--cs-dir <フォルダ>` | — | Counter-Strike 1.6 クライアントのフォルダ: 標準 `.wad`、`gfx/env` の空、`sprites/*.spr` |
| `--wad <フォルダ>` | マップのフォルダとその 2 階層上 | `.wad` を探す追加フォルダ |
| `--geometry mesh\|bsp\|both` | `mesh` | 世界を描くもの: スタティックメッシュ、BSP、または BSP 描画でメッシュはコリジョン専用 |
| `--verify` | オフ | 完成した `.rom` を独立リーダで読み戻し、不変条件を検証 |
| `--no-spawns` | オフ | スポーン地点を移植しない |
| `--ase` | オフ | `.ase` / `.t3d` も出力（バックエンド B、KFEd での手仕上げ用） |

意図的に残してある診断用スイッチ: `--no-sky`、`--no-extras`、`--no-light`、`--tree-translate`、`--spawn-index N`。環境変数 `KF_SPAWN_AT="x,y,z[,yaw]"` はすべてのスポーン地点をその 1 点に置き換えます——見たい場所に直接降り立つ方法です。

## 移植されるもの

| | 方法 |
| --- | --- |
| ワールドジオメトリ | スタティックメッシュ、1 メッシュ 1 マテリアル、2048 UU グリッドで分割、巻き順は反転（Y 軸ミラーが三角形の向きを反転させるため）。コリジョンはその kDOP ツリー |
| ブラシエンティティ（`func_wall`、`func_illusionary`、`func_ladder` など） | 同じ経路。エンティティの `origin` キーを考慮 |
| ドア（`func_door`、`func_door_rotating`） | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger`——使用キーで開き、KF 本来のドアと同様に溶接可能。`KeyPos`/`KeyRot` は `angle`/`lip`/`distance` から |
| 割れるガラス（`func_breakable`、material 0/7） | `KFMod.KFGlassMover`、`Health` はエンティティから、`Style = STY_Translucent` |
| 水（`func_water`） | 半透明の上面と、実ブラシボックスを持つ `PhysicsVolume`（`bWaterVolume`、フォグ、溺水） |
| スプライト（`env_sprite`、`env_glow`、`cycler_sprite`） | `Engine.Effects` のビルボード。`.spr` のテクスチャ形式に応じて additive か alpha |
| モデル（同じエンティティ上の `.mdl`） | バインドポーズのスタティックメッシュ＋インスタンスごとのアクター。テクスチャはモデル内か `<名前>T.mdl` から |
| テクスチャ | 8 ビット miptex → `UTexture` P8 + `UPalette` を**再エンコードなし**で。GoldSrc の 4 ミップをポイントサンプリングで 1×1 まで延長 |
| マスク付きテクスチャ（`{name`） | パレットを並べ替えて透明インデックスを 255 から 0 へ移し、`PF_Masked` を立てる |
| 空 | `gfx/env/<skyname>*` の 6 枚 → RGBA8（ブロック圧縮なし——グラデーションに縞が出るため）をスカイボックスキューブに。メッシュからは `sky` 面を切り取る。`skyname` が無ければエンジン既定の `desert` |
| ライティング | マップ自身の luxel の影レベルから `ZoneInfo.AmbientBrightness`、加えてライトエンティティ由来の `Light`/`Sunlight` アクター。BSP ルートではさらに `UModel` 内の DXT3 ライトマップアトラス |
| スポーン地点 | `info_player_start` / `info_player_deathmatch` → `PlayerStart`、床の上に持ち上げる |
| スケール | 既定 ×1.9（×2 は公開済み `KF-CS-*` 移植から実測した値で、GoldSrc の 16 単位 luxel グリッドが UE2.5 の 32 UU にちょうど乗る） |

world に入らないのは不可視のツールテクスチャ——`aaatrigger`、`clip`、`null`、`hint`——で、そもそも入るべきものではありません: cs_assault は 3206 面中 48、de_dust2 は 5383 面中 25、cs_italy は 8528 面中 36。

## 足りないもの

- **ベイクされた影。** GoldSrc の luxel はサンプリングして書き込んでいますが、クライアントが実行時に適用しないため、ライティングは平坦です（マップ自身の luxel から導いたゾーンのアンビエント）。おそらく KFEd での `Build Lighting` が必要です。
- **ゾーン。** 常に 2 つ（0 = ソリッド、1 = ワールド）なので PVS オクルージョンがなく、全部描画します。Counter-Strike 規模のマップなら許容範囲です。
- **ボットの経路。** `PathNode` / `ReachSpec` は生成しません——KFEd で `Build Paths` が必要です。
- **ボタンと列車。** `func_button`、`trigger_*`、`func_train` は静的ジオメトリのままです。
- **アニメーションテクスチャ**はフレーム 0 で移植。`-0`（ランダムタイリング）は通常のテクスチャ扱いです。
- **2 の累乗でないテクスチャ**は最も近い 2 の累乗にリサンプルします（そうしないと UE2.5 が `UBits` からバッファサイズを計算してヒープを壊します）。テクスチャ軸は `pot/orig` 倍されるので UV はずれません。

## ロードマップ：ソースゲームを増やす

パイプラインは、ソースゲームだけが変わる部分になるよう分けてあります: `src/goldsrc/` がマップを読み、`src/build/` が Unreal の構造に変換し、`src/unreal/` がパッケージを書きます。ゲームを追加するとは、同じ中間形（UV 付きの面、テクスチャ、エンティティ、ライトマップグリッド）を出す新しいリーダを書くことで、`src/unreal/` は一切触りません。次の明白な候補は Quake、Quake II、Source の BSP 系です——同じフォーマット一族で、出口は同じ `UModel` ライタです。

この方向への貢献は歓迎します。まずは対象フォーマットについて [`docs/RESEARCH.md`](../RESEARCH.md)、壊してはいけない不変条件について [`docs/GOTCHAS.md`](../GOTCHAS.md) を読んでください。

## 検証方法

```bash
pnpm test          # node test/selfcheck.js
```

19 項目、すべて green。要となるもの:

- `UModel` v128 シリアライザが **製品版 Killing Floor のマップ 41 本をバイト単位で完全に書き戻す**（差異は JS が正規化する signalling NaN のペイロードのみ）;
- compact index と `FString` のラウンドトリップ;
- Counter-Strike のマップ 25 本で: 計算したライトマップ量が `LIGHTING` lump に収まる、面の巻き順が `Newell == −normal`、頂点が自面の平面上にある;
- 製品版の `UPolys` オブジェクトがすべてレイアウトに厳密に一致（6054 オブジェクト、37136 ポリゴン、不一致 0）;
- DXT3 エンコーダ、`.mdl` と `.spr` のリーダ、Lanczos リサンプラ。

ゲームファイルは通常の Steam の場所から探します。無い場合これらの検査は空振りで通るのではなく明示的に失敗するので、`pnpm test` はゲームを入れたマシンで実行してください（CI はパッケージングのスモークテストのみ）。

`--verify` は完成した `.rom` を独立リーダで読み戻し、22 の不変条件を検査します: ヘッダ、各テーブル、serial 範囲、参照の解決、ノード平面が単位ベクトルであること、頂点が自平面上にあること、巻き順、セクションがノードのポリゴンと対応すること、ライトマップの範囲と UV がアトラス内に収まること、DXT3 の妥当性、ツリーが本当にツリーであること、そして全テクスチャのミップ連鎖が完全であること。実測、すべてクリーン:

```
cs_assault  3206 面 -> 7247 三角形 / 323 メッシュ   149 テクスチャ  13.41 MB
de_dust2    5383 面 -> 9932 三角形 / 229 メッシュ    36 テクスチャ  12.05 MB
cs_italy    8528 面 -> 21038 三角形 / 396 メッシュ   89 テクスチャ  16.35 MB

cs_assault --geometry bsp   3158/3206 面 (98.5%)  3570 ノード  3569 ライトマップ  5 アトラス  14.90 MB
```

`test/repack.js <マップ.rom>` は既存マップを同じライタで再構築してバイト比較します: `KF-CS-Iceworld` では差が **1 バイト**（`packageFlags`）。`test/render-test.ps1` はロビーを飛ばしてクライアントを直接マップへ起動し、`KillingFloor.log` の `Critical:` 行で判定します。`KF-CS-Assault` は 20 か所すべてのスポーン地点から実行して `Critical` ゼロでした。

**テストが見ていないもの:** KFEd の 3D ビューポートでの見え方（別のレンダリング経路）と、絵そのものが*正しい*かどうか——テストが捕まえるのはクラッシュであってアーティファクトではありません。

## ゲーム内でマップを確認する

[`harness/play.ps1`](../../harness/README.md) はクライアントをマップへ起動し、`PostMessage` でコンソールを操作し、エンジンでスクリーンショットを撮って PNG に変換します。`harness/flat.js` はエッジ密度でフレームを判定します（18–30 % が正常、約 1.4 % はワールドが描かれなかったフレーム）。肝心なルール: **テストハーネス自体が正しいと確かめるまで、否定的な結果には価値がない**——動くと分かっているケースで先に確認してください。詳細と落とし穴は [`harness/README.md`](../../harness/README.md) と [`docs/GOTCHAS.md`](../GOTCHAS.md) §7。

## 構成

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                コマンドラインの入口
│  ├─ convert.js            パイプライン全体
│  ├─ verify.js             完成した .rom の不変条件チェック
│  ├─ resources.js          .wad と gfx/env の空をどこから探すか
│  ├─ backendB.js           バックエンド B: .ase（メッシュ＋頂点カラーの光）+ .t3d + 8 ビット BMP
│  ├─ goldsrc/              ソースゲーム: bsp.js、wad.js、mdl.js、spr.js、skybox.js
│  ├─ build/                GoldSrc → Unreal: model.js、mesh.js、brushents.js、propmesh.js、skybox*、upscale.js
│  └─ unreal/               パッケージライタ: package.js、writer.js、model.js、staticmesh.js、polys.js、
│                           texture.js、dxt.js、read.js（--verify が使う独立リーダ）
├─ electron/                デスクトップアプリ: main、preload、renderer、worker（子プロセスで変換）
├─ test/                    selfcheck.js（pnpm test）、repack.js、render-test.ps1
├─ harness/                 play.ps1、flat.js、bmp2png.js——実クライアントでマップを見る
├─ scripts/                 フォーマット解析に使った調査ツール（docs/RESEARCH.md 参照）
└─ docs/                    RESEARCH.md、GOTCHAS.md、translations/
```

## ドキュメント

- **[docs/RESEARCH.md](../RESEARCH.md)** — フォーマット調査: 両側で何を実測したか、`UModel` v128 のシリアライズ順、3 つの実現方式となぜこれを選んだか、既存の `KF-CS-*` 移植が実際どう作られたか。
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — 実測した罠のすべて。違反するとエンジンが落ちる 5 つの不変条件を含みます。ライタに手を入れる前に必読。
- **[harness/README.md](../../harness/README.md)** — 変換したマップを実クライアントで確認する方法。

## 法的な位置づけ

マップを変換したからといって公開してよいわけではありません。Valve は非商用 MOD でのゲーム間アセット移動を認めていますが、**バニラのマップをそのまま移植しないこと**を求めています。Tripwire は、第三者の保護対象財産を書面の許可なく含めないこと、無償で配布することを要求しています。公開されていた Counter-Strike マップの KF 移植 2 件（`KF-Dust_1`、`KF-Assault`）はいずれも Steam Workshop から削除されました。カスタムマップの権利は Valve ではなく各作者にあり、許可はそちらから得る必要があります。

このインポータはゲームコンテンツを同梱せず、それ自体は何も生み出しません。出力はあなたが与えたマップから派生したものであり、それをどこへ持って行けるかはあなたと元マップの権利者の間の話です。

## 免責

個人によるリバースエンジニアリングとフォーマット相互運用のプロジェクトで、研究・教育目的で公開しています。エンジンのパッケージ形式をリバースエンジニアリングすることはゲームの EULA に抵触する可能性があります——このコードの使い方の責任はあなただけにあります。**現状のまま**提供され、いかなる保証もありません（ライセンス参照）。Tripwire Interactive、Epic Games、Valve とは無関係です。

## ライセンス

Copyright (c) 2026 Geekrainian.

**GNU General Public License v3.0 以降**（GPL-3.0-or-later）で公開しています。全文は [LICENSE](../../LICENSE) を参照してください。本プログラムはフリーソフトウェアであり、この条件のもとで再配布・改変でき、**無保証**で提供されます。

## 商標について

Killing Floor と Unreal は Tripwire Interactive および Epic Games の商標、Counter-Strike、Half-Life、GoldSrc は Valve の商標です。本ツールは非公式のファン制作物であり、これらといかなる提携も推奨関係もありません。
