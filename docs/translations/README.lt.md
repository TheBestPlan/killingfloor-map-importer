# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · **Lietuvių** · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Importuoja kitų žaidimų žemėlapius į **Killing Floor 1** kaip tikrus `.rom` lygius (Unreal Engine 2.5, failo versija 128 / licensee 29). Paketas rašomas nuo nulio — be KFEd, be tarpinių formatų, be rankinių žingsnių: nurodai žemėlapio failą ir gauni `.rom`, kurį gali įmesti į `KillingFloor\Maps` ir žaisti.

Šiandieninis šaltinio variklis — **GoldSrc BSP v30**: Counter-Strike 1.6, Half-Life ir jų modai. Šaltinio žaidimo skaitymas yra vienas modulis (`src/goldsrc/`) prieš bendrą surinkimo ir rašymo konvejerį, o daugiau žaidimų — numatytas augimo kelias, žr. [Planai](#planai-daugiau-šaltinio-žaidimų).

> Unreal pusė iššifruota rankomis. `UModel` v128 serializavimo tvarka ir jame esančių iškeptų lightmap'ų išdėstymas niekur nedokumentuoti, o viešo GoldSrc → Unreal konverterio nėra. Tyrimas — [`docs/RESEARCH.md`](../RESEARCH.md), visos laiko kainavusios spąstos — [`docs/GOTCHAS.md`](../GOTCHAS.md).

## Būsena

| Galimybė | Būsena |
| --- | --- |
| Geometrija, tekstūros, kolizija, atsiradimo taškai | veikia — patikrinta tikrame kliente |
| Dangus — šešios tikros žemėlapio `gfx/env` nuotraukos | veikia |
| Vanduo — plaukimas, ekrano atspalvis, sluoksniuotos tekstūros | veikia |
| Spraitai (`.spr`) ir modeliai (`.mdl`) | veikia |
| Durys ir dūžtantis stiklas | veikia — `KFDoorMover` + `KFUseTrigger`, `KFGlassMover` |
| Iškeptas apšvietimas | iš dalies — lukseliai nuskaitomi ir supakuojami į DXT3 atlasus, bet klientas piešia plokščią zonos ambient (žr. [Ko trūksta](#ko-trūksta)) |
| Zonos / PVS okliuzija, botų keliai, mygtukai ir trigeriai | ne |

## Ko reikia

- Įdiegto **Killing Floor 1** (arba ne Steam SDK) — ten keliauja paruoštas `.rom`.
- Įdiegto **Counter-Strike 1.6 / Half-Life** — ten guli originalūs `.wad` tekstūrų archyvai ir `gfx/env` dangūs. Parsisiųstas žemėlapis paprastai ateina vien kaip `.bsp` ir be jų neapsieina: kitaip visos tekstūros išeina purpurinės, o dangaus nėra išvis.
- **Node.js ≥ 18** komandinei eilutei. Darbalaukio programai daugiau nieko nereikia.

Šioje saugykloje nėra jokio žaidimo turinio nė viena kryptimi. Tu pats nurodai savo įdiegimus.

## Darbalaukio programa (Windows / macOS / Linux)

Paruoštos savarankiškos versijos yra [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases) puslapyje:

- **Windows** — `…-setup.exe` (diegiklis) arba `…-portable.exe` (be diegimo).
- **macOS** — `…-mac-x64.dmg` (Intel) arba `…-mac-arm64.dmg` (Apple Silicon).
- **Linux** — `…-linux-x86_64.AppImage` (veikia bet kur) arba `…-linux-amd64.deb`.

Nutempk `.bsp` failus į langą, pasirink išvesties aplanką ir Counter-Strike aplanką, spausk Convert. Kiekvienas žemėlapis konvertuojamas vaikiniame procese, tad kritimas ar milžiniškas žemėlapis nenusineš lango kartu. Versijos nepasirašytos, tad pirmą kartą OS gali įspėti (Windows SmartScreen → *More info → Run anyway*; macOS → dešinys pelės klavišas → *Open*).

### Susikurti pačiam

```bash
pnpm install
pnpm start          # paleisti programą iš šaltinio
pnpm run dist       # sukurti diegiklius dabartinei OS į dist/
```

## Komandinė eilutė

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| Parametras | Numatyta | Ką daro |
| --- | --- | --- |
| `--out <failas\|aplankas>` | šalia `.bsp` | kur rašyti `.rom` |
| `--name KF-Xxx` | `KF-<bsp vardas>` | žemėlapio vardas pakete |
| `--scale <n>` | `1.9` | GoldSrc vienetai → Unreal vienetai |
| `--lightmap-scale <n>` | `32` | lukselio dydis Unreal vienetais |
| `--cs-dir <aplankas>` | — | Counter-Strike 1.6 kliento aplankas: originalūs `.wad`, `gfx/env` dangūs, `sprites/*.spr` |
| `--wad <aplankas>` | žemėlapio aplankas ir du aukščiau | papildomi aplankai `.wad` paieškai |
| `--geometry mesh\|bsp\|both` | `mesh` | kas piešia pasaulį: static mesh'ai, BSP, ar BSP su mesh'ais tik kolizijai |
| `--verify` | išjungta | perskaityti paruoštą `.rom` nepriklausomu skaitytuvu ir patikrinti invariantus |
| `--no-spawns` | išjungta | neperkelti atsiradimo taškų |
| `--ase` | išjungta | papildomai išvesti `.ase` / `.t3d` (B galas, rankiniam užbaigimui KFEd) |

Diagnostiniai jungikliai palikti tyčia: `--stock-sky "Pkg.Group.Name"`, `--no-sky`, `--no-extras`, `--no-light`, `--tree-translate`, `--spawn-index N`. Aplinkos kintamasis `KF_SPAWN_AT="x,y,z[,yaw]"` pakeičia visus atsiradimo taškus vienu tame taške — taip patenkama ten, kur įdomu.

## Kas perkeliama

| | Kaip |
| --- | --- |
| pasaulio geometrija | static mesh'ai, viena medžiaga vienam mesh'ui, pjaustymas 2048 UU tinkleliu, atvirkštinė apsukimo tvarka (Y veidrodis apverčia trikampio orientaciją); kolizija — jų kDOP medis |
| brush entitetai (`func_wall`, `func_illusionary`, `func_ladder`…) | tuo pačiu keliu, atsižvelgiant į entiteto `origin` raktą |
| durys (`func_door`, `func_door_rotating`) | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger` — atidaromos veiksmo klavišu ir suvirinamos kaip tikros KF durys; `KeyPos`/`KeyRot` iš `angle`/`lip`/`distance` |
| dūžtantis stiklas (`func_breakable`, material 0/7) | `KFMod.KFGlassMover`, `Health` iš entiteto, `Style = STY_Translucent` |
| vanduo (`func_water`) | permatoma viršutinė plokštuma plius `PhysicsVolume` su tikra brush dėže (`bWaterVolume`, rūkas, skendimas) |
| spraitai (`env_sprite`, `env_glow`, `cycler_sprite`) | `Engine.Effects` bilbordai, additive arba alpha pagal `.spr` tekstūros formatą |
| modeliai (`.mdl` ant tų pačių entitetų) | static mesh bind pozoje plius aktorius kiekvienam egzemplioriui; tekstūros iš modelio arba iš `<vardas>T.mdl` |
| tekstūros | 8 bitų miptex → `UTexture` P8 + `UPalette` **be perkodavimo**; GoldSrc 4 mip'ai tęsiami taškine atranka iki 1×1 |
| kaukės tekstūros (`{name`) | paletė perstatoma, permatomas indeksas keliauja iš 255 į 0, vėliava `PF_Masked` |
| dangus | šešios `gfx/env/<skyname>*` nuotraukos → RGBA8 (be blokinio suspaudimo — kitaip juostos gradientuose) ant skybox kubo; `sky` sienelės iškerpamos iš mesh'ų; nėra `skyname` — variklio numatytasis `desert` |
| apšvietimas | `ZoneInfo.AmbientBrightness` pagal paties žemėlapio lukselių šešėlių lygį plius `Light`/`Sunlight` aktoriai iš šviesos entitetų; BSP kelyje dar ir DXT3 lightmap atlasai `UModel` viduje |
| atsiradimo taškai | `info_player_start` / `info_player_deathmatch` → `PlayerStart`, pakelti ant grindų |
| mastelis | ×1.9 pagal nutylėjimą (×2 — tai, kas išmatuota gyvuose `KF-CS-*` portuose, ir tada GoldSrc 16 vienetų lukselių tinklelis tiksliai sutampa su UE2.5 32 UU) |

Į pasaulį nepatenka nematomos įrankių tekstūros — `aaatrigger`, `clip`, `null`, `hint` — kurioms ten ir ne vieta: 48 iš 3206 cs_assault, 25 iš 5383 de_dust2, 36 iš 8528 cs_italy.

## Ko trūksta

- **Iškeptų šešėlių.** GoldSrc lukseliai nuskaitomi ir įrašomi, bet variklis jų vykdymo metu nenaudoja, todėl apšvietimas plokščias — zonos ambient, išvestas iš paties žemėlapio lukselių. Tikėtina, gydoma `Build Lighting` praėjimu KFEd.
- **Zonų.** Visada dvi (0 = kietas, 1 = pasaulis), tad PVS okliuzijos nėra: piešiama viskas. Counter-Strike dydžio žemėlapiams tinka.
- **Botų kelių.** `PathNode` / `ReachSpec` negeneruojami — reikia `Build Paths` praėjimo KFEd.
- **Mygtukų ir traukinių.** `func_button`, `trigger_*` ir `func_train` lieka statine geometrija.
- **Animuotos tekstūros** perkeliamos pirmu kadru; `-0` (atsitiktinis tiling) tampa įprasta tekstūra.
- **Ne dvejeto laipsnio tekstūros** perskaičiuojamos į artimiausią dvejeto laipsnį (kitaip UE2.5 skaičiuoja buferio dydį pagal `UBits` ir gadina krūvą). Tekstūros ašys padauginamos iš `pot/orig`, tad UV nenuslysta.

## Planai: daugiau šaltinio žaidimų

Konvejeris padalytas taip, kad nuo šaltinio žaidimo priklausytų tik viena dalis: `src/goldsrc/` skaito žemėlapį, `src/build/` verčia jį Unreal struktūromis, `src/unreal/` rašo paketą. Pridėti žaidimą reiškia parašyti naują skaitytuvą, duodantį tą pačią tarpinę formą — sieneles su UV, tekstūras, entitetus, lightmap tinklelį — ir `src/unreal/` viduje niekas nesikeičia. Akivaizdūs kiti kandidatai — Quake, Quake II ir Source BSP variantai: ta pati formatų šeima ir tas pats `UModel` rašytuvas gale.

Indėlis šia kryptimi laukiamas; pradėti verta nuo [`docs/RESEARCH.md`](../RESEARCH.md) apie tikslinį formatą ir [`docs/GOTCHAS.md`](../GOTCHAS.md) apie invariantus, kurių laužyti negalima.

## Kaip tai patikrinta

```bash
pnpm test          # node test/selfcheck.js
```

19 patikrų, visos žalios. Svarbiausios:

- `UModel` v128 serializatorius perrašo **41 originalų Killing Floor žemėlapį baitas į baitą** (skiriasi tik signalizuojančio NaN naudingoji apkrova, kurią JS normalizuoja);
- compact index ir `FString` round-trip;
- 25 Counter-Strike žemėlapiuose: apskaičiuotas lightmap'ų kiekis telpa į `LIGHTING` lump'ą, sienelių apsukimas atitinka `Newell == −normal`, viršūnės guli sienelės plokštumoje;
- kiekvienas originalus `UPolys` objektas tiksliai atitinka išdėstymą (6054 objektai, 37136 poligonai, 0 nesutapimų);
- DXT3 koderis, `.mdl` ir `.spr` skaitytuvai, Lanczos perskaičiavimas.

Žaidimo failai ieškomi įprastose Steam vietose; be jų šios patikros garsiai krinta, o ne praeina tuščios, tad `pnpm test` verta leisti mašinoje, kurioje žaidimai įdiegti (CI tik dūmų testas pakavimui).

`--verify` perskaito paruoštą `.rom` nepriklausomu skaitytuvu ir tikrina 22 invariantus: antraštę, lenteles, serial intervalus, nuorodų išsprendžiamumą, mazgų plokštumų vienetinius normalius, viršūnes plokštumoje, apsukimą, sekcijų atitikimą mazgų poligonams, lightmap intervalus ir jų UV atlase, taisyklingą DXT3, kad medis tikrai yra medis, ir pilną mip grandinę kiekvienai tekstūrai. Išmatuota, viskas švaru:

```
cs_assault  3206 sienelės -> 7247 trikampiai 323 mesh'uose   149 tekstūros  13.41 MB
de_dust2    5383 sienelės -> 9932 trikampiai 229 mesh'uose    36 tekstūros  12.05 MB
cs_italy    8528 sienelės -> 21038 trikampiai 396 mesh'uose   89 tekstūros  16.35 MB

cs_assault --geometry bsp   3158/3206 sienelių (98.5%)  3570 mazgų  3569 lightmap'ai  5 atlasai  14.90 MB
```

`test/repack.js <žemėlapis.rom>` perrenka esamą žemėlapį tuo pačiu rašytuvu ir lygina baitus: `KF-CS-Iceworld` skirtumas — **vienas baitas** (`packageFlags`). `test/render-test.ps1` paleidžia klientą tiesiai į žemėlapį, aplenkdamas lobį, ir sprendžia pagal `Critical:` eilutes `KillingFloor.log`. `KF-CS-Assault` paleistas iš visų 20 atsiradimo taškų be nė vieno `Critical`.

**Testai nedengia:** kaip žemėlapis atrodo KFEd 3D vaizde (ten savas piešimo kelias) ir ar pats vaizdas teisingas — testai gaudo kritimus, ne artefaktus.

## Žemėlapio patikra žaidime

[`harness/play.ps1`](../../harness/README.md) paleidžia klientą į žemėlapį, valdo konsolę per `PostMessage`, daro kadrus varikliu ir konvertuoja juos į PNG; `harness/flat.js` vertina kadrus pagal kraštų tankį (18–30 % — norma, ~1,4 % — kadras, kuriame pasaulis nenupieštas). Svarbiausia taisyklė: **neigiamas rezultatas nieko nevertas, kol nepatikrintas pats stendas** su žinomai veikiančiu atveju. Detalės ir spąstos — [`harness/README.md`](../../harness/README.md) ir [`docs/GOTCHAS.md`](../GOTCHAS.md) §7.

## Sandara

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                komandinės eilutės sąsaja
│  ├─ convert.js            visas konvejeris
│  ├─ verify.js             paruošto .rom invariantų patikra
│  ├─ resources.js          kur ieškoti .wad ir gfx/env dangaus
│  ├─ backendB.js           B galas: .ase (mesh + šviesa viršūnių spalvose) + .t3d + 8 bitų BMP
│  ├─ goldsrc/              šaltinio žaidimas: bsp.js, wad.js, mdl.js, spr.js, skybox.js
│  ├─ build/                GoldSrc → Unreal: model.js, mesh.js, brushents.js, propmesh.js, skybox*, upscale.js
│  └─ unreal/               paketo rašytuvas: package.js, writer.js, model.js, staticmesh.js, polys.js,
│                           texture.js, dxt.js, read.js (nepriklausomas skaitytuvas --verify režimui)
├─ electron/                darbalaukio programa: main, preload, renderer, worker (konversija vaikiniame procese)
├─ test/                    selfcheck.js (pnpm test), repack.js, render-test.ps1
├─ harness/                 play.ps1, flat.js, bmp2png.js — žiūrėti žemėlapį tikrame kliente
├─ scripts/                 tyrimo įrankiai, kuriais išnarstyti formatai (žr. docs/RESEARCH.md)
└─ docs/                    RESEARCH.md, GOTCHAS.md, translations/
```

## Dokumentacija

- **[docs/RESEARCH.md](../RESEARCH.md)** — formatų tyrimas: kas išmatuota abiejose pusėse, `UModel` v128 serializavimo tvarka, trys galimos architektūros ir kodėl pasirinkta ši, kaip iš tikrųjų padaryti esami `KF-CS-*` portai.
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — visos išmatuotos spąstos, įskaitant penkis invariantus, kurių pažeidimas parklupdo variklį. Būtina perskaityti prieš keičiant rašytuvą.
- **[harness/README.md](../../harness/README.md)** — konvertuoto žemėlapio patikra tikrame kliente.

## Teisinis rėmas

Žemėlapio konvertavimas nesuteikia teisės jį publikuoti. Valve leidžia perkelti turtą tarp žaidimų nekomerciniuose moduose, bet prašo **neportuoti vanilinių žemėlapių pažodžiui**; Tripwire reikalauja, kad modai neturėtų svetimos saugomos nuosavybės be rašytinio leidimo ir būtų platinami nemokamai. Abu vieši Counter-Strike žemėlapių portai į Killing Floor (`KF-Dust_1`, `KF-Assault`) pašalinti iš Steam Workshop. Pasirinktiniai žemėlapiai priklauso jų autoriams, ne Valve — leidimo reikia iš jų.

Šis importuotojas neplatina žaidimo turinio ir pats nieko negamina: tai, ką jis rašo, išvesta iš tavo paduoto žemėlapio, o kur tai gali keliauti — reikalas tarp tavęs ir šaltinio žemėlapio savininko.

## Išlyga

Asmeninis atvirkštinės inžinerijos ir formatų suderinamumo projektas, paskelbtas tyrimo ir mokymosi tikslais. Variklio paketų formato atvirkštinė inžinerija gali prieštarauti žaidimo EULA — už šio kodo naudojimą atsakai tik tu. Teikiama **kaip yra**, be jokių garantijų (žr. licenciją). Nesusijęs su Tripwire Interactive, Epic Games ar Valve.

## Licencija

Copyright (c) 2026 Geekrainian.

Išleista pagal **GNU General Public License v3.0 arba naujesnę** (GPL-3.0-or-later). Visas tekstas — [LICENSE](../../LICENSE). Ši programa yra laisva programinė įranga: gali ją platinti ir keisti pagal tas sąlygas, ir ji teikiama **be garantijų**.

## Prekių ženklai

Killing Floor ir Unreal — Tripwire Interactive ir Epic Games prekių ženklai; Counter-Strike, Half-Life ir GoldSrc — Valve prekių ženklai. Tai neoficialus gerbėjų įrankis, su jais nesusijęs ir jų nepatvirtintas.
