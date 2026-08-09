# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · **Polski** · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Importuje mapy z innych gier do **Killing Floor 1** jako prawdziwe poziomy `.rom` (Unreal Engine 2.5, wersja pliku 128 / licensee 29). Pakiet jest pisany od zera — bez KFEd, bez formatów pośrednich, bez kroków ręcznych: wskazujesz plik mapy i dostajesz `.rom`, który wrzucasz do `KillingFloor\Maps` i grasz.

Silnikiem źródłowym jest dziś **GoldSrc BSP v30**: Counter-Strike 1.6, Half-Life i ich mody. Czytanie gry źródłowej to jeden moduł (`src/goldsrc/`) przed wspólnym potokiem budowania i zapisu, a dokładanie kolejnych gier to zaplanowana droga rozwoju — patrz [Plany](#plany-więcej-gier-źródłowych).

> Stronę Unreala rozpracowano ręcznie. Kolejność serializacji `UModel` v128 i układ wypalonych lightmap w środku nie są nigdzie udokumentowane, a publiczny konwerter GoldSrc → Unreal nie istnieje. Opracowanie jest w [`docs/RESEARCH.md`](../RESEARCH.md), a każda pułapka, która kosztowała czas — w [`docs/GOTCHAS.md`](../GOTCHAS.md).

## Stan

| Możliwość | Stan |
| --- | --- |
| Geometria, tekstury, kolizja, punkty startowe | działa — sprawdzone w prawdziwym kliencie |
| Niebo — sześć prawdziwych obrazków mapy z `gfx/env` | działa |
| Woda — pływanie, przyciemnienie ekranu, tekstury warstwowe | działa |
| Sprite'y (`.spr`) i modele (`.mdl`) | działa |
| Drzwi i tłukące się szyby | działa — `KFDoorMover` + `KFUseTrigger`, `KFGlassMover` |
| Wypalone oświetlenie | częściowo — luksele są czytane i pakowane w atlasy DXT3, ale klient rysuje płaski ambient strefy (patrz [Czego brakuje](#czego-brakuje)) |
| Strefy / okluzja PVS, ścieżki botów, przyciski i triggery | nie |

## Czego potrzebujesz

- Zainstalowanego **Killing Floor 1** (albo SDK spoza Steama) — tam trafia gotowy `.rom`.
- Zainstalowanego **Counter-Strike 1.6 / Half-Life** — tam leżą oryginalne archiwa tekstur `.wad` i niebo `gfx/env`. Pobrana mapa zwykle przychodzi jako sam `.bsp` i bez nich się nie obejdzie: inaczej wszystkie tekstury wychodzą magentowe, a nieba nie ma wcale.
- **Node.js ≥ 18** dla CLI. Aplikacja desktopowa nie potrzebuje niczego więcej.

To repozytorium nie zawiera żadnej zawartości gry — w żadną stronę. Sam wskazujesz własne instalacje.

## Aplikacja desktopowa (Windows / macOS / Linux)

Gotowe, samodzielne wydania są na stronie [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases):

- **Windows** — `…-setup.exe` (instalator) albo `…-portable.exe` (bez instalacji).
- **macOS** — `…-mac-x64.dmg` (Intel) albo `…-mac-arm64.dmg` (Apple Silicon).
- **Linux** — `…-linux-x86_64.AppImage` (uruchamiane wszędzie) albo `…-linux-amd64.deb`.

Przeciągnij pliki `.bsp` na okno, wybierz folder wyjściowy i folder Counter-Strike'a, naciśnij Convert. Każda mapa jest konwertowana w procesie potomnym, więc awaria albo ogromna mapa nie pociągnie okna za sobą. Wydania są niepodpisane, więc system może ostrzec przy pierwszym uruchomieniu (Windows SmartScreen → *Więcej informacji → Uruchom mimo to*; macOS → prawy przycisk → *Otwórz*).

### Zbudować samemu

```bash
pnpm install
pnpm start          # uruchomić aplikację ze źródeł
pnpm run dist       # zbudować instalatory dla bieżącego systemu do dist/
```

## CLI

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| Opcja | Domyślnie | Co robi |
| --- | --- | --- |
| `--out <plik\|katalog>` | obok `.bsp` | gdzie zapisać `.rom` |
| `--name KF-Xxx` | `KF-<nazwa bsp>` | nazwa mapy wewnątrz pakietu |
| `--scale <n>` | `1.9` | jednostki GoldSrc → jednostki Unreala |
| `--lightmap-scale <n>` | `32` | rozmiar lukselu w jednostkach Unreala |
| `--cs-dir <katalog>` | — | katalog klienta Counter-Strike 1.6: oryginalne `.wad`, niebo `gfx/env`, `sprites/*.spr` |
| `--wad <katalog>` | katalog mapy i dwa wyżej | dodatkowe katalogi do szukania plików `.wad` |
| `--geometry mesh\|bsp\|both` | `mesh` | co rysuje świat: static meshe, BSP, albo BSP z meshami tylko jako kolizja |
| `--verify` | wył. | odczytać gotowy `.rom` niezależnym czytnikiem i sprawdzić niezmienniki |
| `--no-spawns` | wył. | nie przenosić punktów startowych |
| `--ase` | wył. | dodatkowo wypisać `.ase` / `.t3d` (backend B, do ręcznego wykończenia w KFEd) |

Przełączniki diagnostyczne zostawione celowo: `--stock-sky "Pkg.Group.Name"`, `--no-sky`, `--no-extras`, `--no-light`, `--tree-translate`, `--spawn-index N`. Zmienna środowiskowa `KF_SPAWN_AT="x,y,z[,yaw]"` zastępuje wszystkie punkty startowe jednym w tym miejscu — tak trafia się tam, gdzie jest ciekawie.

## Co jest przenoszone

| | Jak |
| --- | --- |
| geometria świata | static meshe, jeden materiał na mesh, cięte siatką 2048 UU, z odwróconym nawinięciem (lustro w Y odwraca orientację trójkąta); kolizja to ich drzewo kDOP |
| encje brushowe (`func_wall`, `func_illusionary`, `func_ladder`…) | tak samo, z uwzględnieniem klucza `origin` encji |
| drzwi (`func_door`, `func_door_rotating`) | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger` — otwierane klawiszem użycia i spawalne jak natywne drzwi KF; `KeyPos`/`KeyRot` z `angle`/`lip`/`distance` |
| tłukące się szyby (`func_breakable`, material 0/7) | `KFMod.KFGlassMover`, `Health` z encji, `Style = STY_Translucent` |
| woda (`func_water`) | półprzezroczysta górna płaszczyzna plus `PhysicsVolume` z prawdziwym pudełkiem brushowym (`bWaterVolume`, mgła, topienie) |
| sprite'y (`env_sprite`, `env_glow`, `cycler_sprite`) | billboardy `Engine.Effects`, additive albo alpha wedle formatu tekstury `.spr` |
| modele (`.mdl` na tych samych encjach) | static mesh w pozie bind plus aktor na każdą instancję; tekstury z modelu albo z `<nazwa>T.mdl` |
| tekstury | 8-bitowy miptex → `UTexture` P8 + `UPalette` **bez przekodowania**; 4 mipy GoldSrc są przedłużane próbkowaniem punktowym do 1×1 |
| tekstury z maską (`{name`) | paleta jest przestawiana, przezroczysty indeks przenosi się z 255 na 0, flaga `PF_Masked` |
| niebo | sześć obrazków `gfx/env/<skyname>*` → RGBA8 (bez kompresji blokowej — inaczej pasy na gradientach) na sześcianie skyboxa; ściany `sky` są wycinane z meshy; brak `skyname` — silnikowy domyślny `desert` |
| oświetlenie | `ZoneInfo.AmbientBrightness` z poziomu cienia własnych lukseli mapy plus aktorzy `Light`/`Sunlight` z encji światła; na trasie BSP dodatkowo atlasy lightmap DXT3 wewnątrz `UModel` |
| punkty startowe | `info_player_start` / `info_player_deathmatch` → `PlayerStart`, podniesione na podłogę |
| skala | ×1.9 domyślnie (×2 to wartość zmierzona na wydanych portach `KF-CS-*`, i przy niej 16-jednostkowa siatka lukseli GoldSrc trafia dokładnie w 32 UU UE2.5) |

Do świata nie trafiają niewidoczne tekstury narzędziowe — `aaatrigger`, `clip`, `null`, `hint` — którym tam nie miejsce: 48 z 3206 na cs_assault, 25 z 5383 na de_dust2, 36 z 8528 na cs_italy.

## Czego brakuje

- **Wypalonych cieni.** Luksele GoldSrc są próbkowane i zapisywane, ale silnik ich nie stosuje w czasie gry, więc oświetlenie jest płaskie — ambient strefy wyprowadzony z własnych lukseli mapy. Prawdopodobnie leczy to przebieg `Build Lighting` w KFEd.
- **Stref.** Zawsze dwie (0 = solid, 1 = świat), więc nie ma okluzji PVS: rysowane jest wszystko. Przy rozmiarach map Counter-Strike'a to akceptowalne.
- **Ścieżek botów.** `PathNode` / `ReachSpec` nie są generowane — potrzebny przebieg `Build Paths` w KFEd.
- **Przycisków i pociągów.** `func_button`, `trigger_*` i `func_train` zostają statyczną geometrią.
- **Tekstury animowane** są przenoszone jako klatka 0; `-0` (losowe kafelkowanie) staje się zwykłą teksturą.
- **Tekstury niebędące potęgą dwójki** są przepróbkowane do najbliższej potęgi dwójki (inaczej UE2.5 liczy rozmiar bufora z `UBits` i psuje stertę). Osie tekstury są mnożone przez `pot/orig`, więc UV się nie rozjeżdżają.

## Plany: więcej gier źródłowych

Potok jest podzielony tak, że gra źródłowa to jedyna zmienna część: `src/goldsrc/` czyta mapę, `src/build/` zamienia ją w struktury Unreala, `src/unreal/` zapisuje pakiet. Dodanie gry oznacza nowy czytnik dający tę samą formę pośrednią — ściany z UV, tekstury, encje, siatkę lightmapy — i nic w `src/unreal/` nie musi się ruszyć. Oczywistymi kolejnymi kandydatami są warianty BSP z Quake'a, Quake'a II i Source'a: ta sama rodzina formatów i ten sam zapisywacz `UModel` na końcu.

Wkład w tym kierunku jest mile widziany; zacznij od [`docs/RESEARCH.md`](../RESEARCH.md) dla formatu docelowego i [`docs/GOTCHAS.md`](../GOTCHAS.md) dla niezmienników, których nie wolno złamać.

## Jak to jest zweryfikowane

```bash
pnpm test          # node test/selfcheck.js
```

19 sprawdzeń, wszystkie zielone. Te nośne:

- serializator `UModel` v128 przepisuje **41 wydanych map Killing Floor bajt w bajt** (jedyne różnice to ładunki sygnalizujących NaN-ów, które JS normalizuje);
- round-trip compact index i `FString`;
- na 25 mapach Counter-Strike'a: policzona objętość lightmap mieści się w lumpie `LIGHTING`, nawinięcie ścian spełnia `Newell == −normal`, wierzchołki leżą na płaszczyźnie swojej ściany;
- każdy wydany obiekt `UPolys` pasuje do układu dokładnie (6054 obiekty, 37136 poligonów, 0 rozbieżności);
- koder DXT3, czytniki `.mdl` i `.spr`, przepróbkowanie Lanczosa.

Pliki gry są szukane w typowych lokalizacjach Steama; bez nich te sprawdzenia głośno padają, zamiast przechodzić puste, więc `pnpm test` uruchamiaj na maszynie, na której gry są zainstalowane (CI tylko smoke-testuje pakowanie).

`--verify` odczytuje gotowy `.rom` niezależnym czytnikiem i sprawdza 22 niezmienniki: nagłówek, tablice, zakresy serial, rozwiązywalność referencji, jednostkowe płaszczyzny węzłów, wierzchołki na swojej płaszczyźnie, nawinięcie, zgodność sekcji z poligonami węzłów, zakresy lightmap i ich UV w atlasie, poprawność DXT3, to że drzewo naprawdę jest drzewem, oraz pełny łańcuch mipów w każdej teksturze. Zmierzone, wszystko czyste:

```
cs_assault  3206 ścian -> 7247 trójkątów w 323 meshach   149 tekstur  13.41 MB
de_dust2    5383 ściany -> 9932 trójkąty w 229 meshach    36 tekstur  12.05 MB
cs_italy    8528 ścian -> 21038 trójkątów w 396 meshach   89 tekstur  16.35 MB

cs_assault --geometry bsp   3158/3206 ścian (98.5%)  3570 węzłów  3569 lightmap  5 atlasów  14.90 MB
```

`test/repack.js <mapa.rom>` przebudowuje istniejącą mapę tym samym zapisywaczem i porównuje bajty: na `KF-CS-Iceworld` różnica to **jeden bajt** (`packageFlags`). `test/render-test.ps1` uruchamia klienta prosto w mapę, z pominięciem lobby, i orzeka na podstawie linii `Critical:` w `KillingFloor.log`. `KF-CS-Assault` przeszedł wszystkie 20 punktów startowych bez ani jednego `Critical`.

**Czego testy nie obejmują:** jak mapa wygląda w widoku 3D KFEd (tam jest własna ścieżka renderowania) i czy sam obraz jest *poprawny* — testy łapią wywrotki, nie artefakty.

## Sprawdzenie mapy w grze

[`harness/play.ps1`](../../harness/README.md) uruchamia klienta w mapie, steruje konsolą przez `PostMessage`, robi zrzuty silnikiem i konwertuje je do PNG; `harness/flat.js` ocenia klatki po gęstości krawędzi (18–30 % to norma, ~1,4 % to klatka, w której świat się nie narysował). Zasada, która się liczy: **wynik negatywny jest nic niewart, dopóki sam stanowisko testowe nie zostanie potwierdzone** na przypadku, o którym wiadomo, że działa. Szczegóły i pułapki w [`harness/README.md`](../../harness/README.md) i [`docs/GOTCHAS.md`](../GOTCHAS.md) §7.

## Układ

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                interfejs wiersza poleceń
│  ├─ convert.js            cały potok
│  ├─ verify.js             sprawdzanie niezmienników gotowego .rom
│  ├─ resources.js          gdzie szukać plików .wad i nieba gfx/env
│  ├─ backendB.js           backend B: .ase (mesh + światło w kolorach wierzchołków) + .t3d + 8-bitowe BMP
│  ├─ goldsrc/              gra źródłowa: bsp.js, wad.js, mdl.js, spr.js, skybox.js
│  ├─ build/                GoldSrc → Unreal: model.js, mesh.js, brushents.js, propmesh.js, skybox*, upscale.js
│  └─ unreal/               zapisywacz pakietu: package.js, writer.js, model.js, staticmesh.js, polys.js,
│                           texture.js, dxt.js, read.js (niezależny czytnik używany przez --verify)
├─ electron/                aplikacja desktopowa: main, preload, renderer, worker (konwersja w procesie potomnym)
├─ test/                    selfcheck.js (pnpm test), repack.js, render-test.ps1
├─ harness/                 play.ps1, flat.js, bmp2png.js — oglądanie mapy w prawdziwym kliencie
├─ scripts/                 narzędzia badawcze, którymi rozpracowano formaty (patrz docs/RESEARCH.md)
└─ docs/                    RESEARCH.md, GOTCHAS.md, translations/
```

## Dokumentacja

- **[docs/RESEARCH.md](../RESEARCH.md)** — badanie formatu: co zmierzono po obu stronach, kolejność serializacji `UModel` v128, trzy możliwe architektury i dlaczego ta, oraz jak naprawdę powstały istniejące porty `KF-CS-*`.
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — wszystkie zmierzone pułapki, w tym pięć niezmienników, których złamanie wywraca silnik. Lektura obowiązkowa przed ruszaniem zapisywacza.
- **[harness/README.md](../../harness/README.md)** — sprawdzanie skonwertowanej mapy w prawdziwym kliencie.

## Ramy prawne

Konwersja mapy nie daje prawa do jej publikacji. Valve pozwala przenosić assety między grami w niekomercyjnych modach, ale prosi, by **map vanilla nie portować dosłownie**; Tripwire wymaga, by mody nie zawierały cudzej chronionej własności bez pisemnej zgody i były rozprowadzane za darmo. Oba publiczne porty map Counter-Strike'a do Killing Floor (`KF-Dust_1`, `KF-Assault`) usunięto ze Steam Workshop. Mapy autorskie należą do swoich twórców, nie do Valve — zgody trzeba szukać u nich.

Ten importer nie rozprowadza zawartości gry i sam z siebie niczego nie produkuje: to, co zapisuje, pochodzi z mapy, którą mu podasz, a dokąd to może trafić, jest sprawą między tobą a właścicielem mapy źródłowej.

## Zastrzeżenie

Osobisty projekt inżynierii wstecznej i interoperacyjności formatów, opublikowany w celach badawczych i edukacyjnych. Odtwarzanie formatu pakietów silnika może kolidować z EULA gry — za sposób użycia tego kodu odpowiadasz tylko ty. Dostarczany **jak jest**, bez jakiejkolwiek gwarancji (patrz licencja). Bez związku z Tripwire Interactive, Epic Games ani Valve.

## Licencja

Copyright (c) 2026 Geekrainian.

Wydane na **GNU General Public License v3.0 lub nowszej** (GPL-3.0-or-later). Pełny tekst w [LICENSE](../../LICENSE). Ten program jest wolnym oprogramowaniem: możesz go rozpowszechniać i modyfikować na tych warunkach, i jest dostarczany **bez gwarancji**.

## Znaki towarowe

Killing Floor i Unreal to znaki towarowe Tripwire Interactive i Epic Games; Counter-Strike, Half-Life i GoldSrc to znaki towarowe Valve. To nieoficjalne, fanowskie narzędzie, niezwiązane z nimi ani przez nie niewspierane.
