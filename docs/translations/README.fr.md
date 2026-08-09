# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · **Français** · [中文](./README.zh.md) · [日本語](./README.ja.md)

Importe des cartes d'autres jeux dans **Killing Floor 1** sous forme de vrais niveaux `.rom` (Unreal Engine 2.5, version de fichier 128 / licensee 29). Le paquet est écrit de zéro — sans KFEd, sans format intermédiaire, sans étape manuelle : tu pointes un fichier de carte et tu obtiens un `.rom` à déposer dans `KillingFloor\Maps` pour y jouer.

Le moteur source aujourd'hui, c'est **GoldSrc BSP v30** : Counter-Strike 1.6, Half-Life et leurs mods. Lire le jeu source tient dans un seul module (`src/goldsrc/`) devant un pipeline commun de construction et d'écriture, et ajouter d'autres jeux est la voie de croissance prévue — voir [Feuille de route](#feuille-de-route--dautres-jeux-sources).

> Le côté Unreal a été décortiqué à la main. L'ordre de sérialisation de `UModel` v128 et la disposition des lightmaps précalculées à l'intérieur ne sont documentés nulle part, et aucun convertisseur GoldSrc → Unreal public n'existe. L'étude est dans [`docs/RESEARCH.md`](../RESEARCH.md) ; chaque piège qui a coûté du temps est dans [`docs/GOTCHAS.md`](../GOTCHAS.md).

## État

| Capacité | État |
| --- | --- |
| Géométrie, textures, collision, points d'apparition | fonctionne — vérifié dans le vrai client |
| Ciel — les six vraies images `gfx/env` de la carte | fonctionne |
| Eau — nage, teinte d'écran, textures en couches | fonctionne |
| Sprites (`.spr`) et props (`.mdl`) | fonctionne |
| Portes et vitres cassables | fonctionne — `KFDoorMover` + `KFUseTrigger`, `KFGlassMover` |
| Éclairage précalculé | partiel — les luxels sont lus et empaquetés en atlas DXT3, mais le client dessine un ambiant de zone uniforme (voir [Ce qui manque](#ce-qui-manque)) |
| Zones / occlusion PVS, chemins de bots, boutons et déclencheurs | non |

## Ce qu'il te faut

- Une installation de **Killing Floor 1** (ou le SDK hors Steam) — c'est là que va le `.rom` fini.
- Une installation de **Counter-Strike 1.6 / Half-Life** — c'est là que vivent les archives de textures `.wad` d'origine et les ciels `gfx/env`. Une carte téléchargée arrive en général seule sous forme de `.bsp` et en a besoin ; sans elles toutes les textures sortent en magenta et la carte n'a pas de ciel.
- **Node.js ≥ 18** pour la ligne de commande. L'application de bureau n'a besoin de rien d'autre.

Ce dépôt ne distribue aucun contenu de jeu, dans un sens comme dans l'autre. C'est toi qui le pointes vers tes propres installations.

## Application de bureau (Windows / macOS / Linux)

Les builds autonomes prêts à l'emploi sont sur la page [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases) :

- **Windows** — `…-setup.exe` (installeur) ou `…-portable.exe` (sans installation).
- **macOS** — `…-mac-x64.dmg` (Intel) ou `…-mac-arm64.dmg` (Apple Silicon).
- **Linux** — `…-linux-x64.AppImage` (s'exécute partout) ou `…-linux-x64.deb`.

Glisse des fichiers `.bsp` sur la fenêtre, choisis le dossier de sortie et le dossier Counter-Strike, appuie sur Convert. Chaque carte est convertie dans un processus enfant, donc un plantage ou une carte énorme n'emporte pas la fenêtre avec elle. Les builds ne sont pas signés, le système peut donc avertir au premier lancement (Windows SmartScreen → *Informations complémentaires → Exécuter quand même* ; macOS → clic droit → *Ouvrir*).

### Le construire soi-même

```bash
pnpm install
pnpm start          # lancer l'application depuis les sources
pnpm run dist       # construire les installeurs du système courant dans dist/
```

## Ligne de commande

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| Option | Par défaut | Ce qu'elle fait |
| --- | --- | --- |
| `--out <fichier\|dossier>` | à côté du `.bsp` | où écrire le `.rom` |
| `--name KF-Xxx` | `KF-<nom du bsp>` | nom de la carte dans le paquet |
| `--scale <n>` | `1.9` | unités GoldSrc → unités Unreal |
| `--lightmap-scale <n>` | `32` | taille du luxel en unités Unreal |
| `--cs-dir <dossier>` | — | dossier du client Counter-Strike 1.6 : `.wad` d'origine, ciels `gfx/env`, `sprites/*.spr` |
| `--wad <dossier>` | celui de la carte et deux au-dessus | dossiers supplémentaires où chercher les `.wad` |
| `--geometry mesh\|bsp\|both` | `mesh` | ce qui dessine le monde : static meshes, le BSP, ou le BSP avec les meshes en collision seule |
| `--verify` | désactivé | relire le `.rom` fini avec un lecteur indépendant et vérifier ses invariants |
| `--no-spawns` | désactivé | ne pas reporter les points d'apparition |
| `--ase` | désactivé | produire aussi `.ase` / `.t3d` (backend B, pour finir à la main dans KFEd) |

Interrupteurs de diagnostic laissés exprès : `--stock-sky "Pkg.Group.Name"`, `--no-sky`, `--no-extras`, `--no-light`, `--tree-translate`, `--spawn-index N`. La variable d'environnement `KF_SPAWN_AT="x,y,z[,yaw]"` remplace tous les points d'apparition par un seul à cet endroit — le moyen d'atterrir là où se trouve ce qu'on veut regarder.

## Ce qui est transféré

| | Comment |
| --- | --- |
| géométrie du monde | static meshes, un matériau par mesh, découpés sur une grille de 2048 UU, enroulement inversé (le miroir en Y retourne l'orientation du triangle) ; la collision, c'est leur arbre kDOP |
| entités brush (`func_wall`, `func_illusionary`, `func_ladder`…) | de la même façon, en respectant la clé `origin` de l'entité |
| portes (`func_door`, `func_door_rotating`) | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger` — s'ouvrent avec la touche d'utilisation et se soudent comme une porte native de KF ; `KeyPos`/`KeyRot` à partir de `angle`/`lip`/`distance` |
| vitres cassables (`func_breakable`, material 0/7) | `KFMod.KFGlassMover`, `Health` de l'entité, `Style = STY_Translucent` |
| eau (`func_water`) | plan supérieur translucide plus un `PhysicsVolume` avec une vraie boîte brush (`bWaterVolume`, brouillard, noyade) |
| sprites (`env_sprite`, `env_glow`, `cycler_sprite`) | billboards `Engine.Effects`, additive ou alpha selon le format de texture du `.spr` |
| props (`.mdl` sur les mêmes entités) | static mesh en pose de bind plus un acteur par instance ; textures du modèle ou de `<nom>T.mdl` |
| textures | miptex 8 bits → `UTexture` P8 + `UPalette` **sans réencodage** ; les 4 mips de GoldSrc sont prolongés par échantillonnage ponctuel jusqu'à 1×1 |
| textures masquées (`{name`) | la palette est permutée pour faire passer l'index transparent de 255 à 0, drapeau `PF_Masked` |
| ciel | six images `gfx/env/<skyname>*` → RGBA8 (sans compression par blocs : elle crée des bandes dans les dégradés) sur un cube de skybox ; les faces `sky` sont découpées des meshes ; sans `skyname`, le `desert` par défaut du moteur |
| éclairage | `ZoneInfo.AmbientBrightness` d'après le niveau d'ombre des propres luxels de la carte, plus des acteurs `Light`/`Sunlight` issus des entités de lumière ; sur la route BSP, en plus des atlas de lightmaps DXT3 dans `UModel` |
| points d'apparition | `info_player_start` / `info_player_deathmatch` → `PlayerStart`, remontés sur le sol |
| échelle | ×1.9 par défaut (×2 est ce que mesurent les ports `KF-CS-*` publiés, et cela fait tomber la grille de luxels de 16 unités de GoldSrc exactement sur les 32 UU d'UE2.5) |

Les faces qui ne passent pas sont les textures d'outil invisibles — `aaatrigger`, `clip`, `null`, `hint` — qui n'ont rien à faire dans le monde : 48 sur 3206 pour cs_assault, 25 sur 5383 pour de_dust2, 36 sur 8528 pour cs_italy.

## Ce qui manque

- **Les ombres précalculées.** Les luxels GoldSrc sont échantillonnés et écrits, mais le client ne les applique pas à l'exécution, donc l'éclairage est plat : un ambiant de zone dérivé des propres luxels de la carte. Cela demande probablement une passe `Build Lighting` dans KFEd.
- **Les zones.** Toujours deux (0 = solide, 1 = le monde), donc pas d'occlusion PVS : tout est dessiné. Acceptable à la taille d'une carte de Counter-Strike.
- **Les chemins de bots.** `PathNode` / `ReachSpec` ne sont pas générés — il faut une passe `Build Paths` dans KFEd.
- **Boutons et trains.** `func_button`, `trigger_*` et `func_train` restent de la géométrie statique.
- **Les textures animées** sont reportées à la frame 0 ; `-0` (pavage aléatoire) devient une texture ordinaire.
- **Les textures non puissances de deux** sont rééchantillonnées à la puissance de deux la plus proche (sinon UE2.5 dimensionne le tampon d'après `UBits` et corrompt le tas). Les axes de texture sont mis à l'échelle par `pot/orig`, donc les UV ne dérivent pas.

## Feuille de route : d'autres jeux sources

Le pipeline est découpé pour que le jeu source soit la seule partie qui change : `src/goldsrc/` lit la carte, `src/build/` la transforme en structures Unreal, `src/unreal/` écrit le paquet. Ajouter un jeu, c'est écrire un nouveau lecteur qui produit la même forme intermédiaire — faces avec UV, textures, entités, grille de lightmap — sans rien bouger dans `src/unreal/`. Les variantes BSP de Quake, Quake II et Source sont les candidats évidents : même famille de formats, même écrivain `UModel` au bout.

Les contributions dans cette direction sont bienvenues ; commence par [`docs/RESEARCH.md`](../RESEARCH.md) pour le format cible et [`docs/GOTCHAS.md`](../GOTCHAS.md) pour les invariants à ne pas casser.

## Comment c'est vérifié

```bash
pnpm test          # node test/selfcheck.js
```

19 vérifications, toutes au vert. Les porteuses :

- le sérialiseur `UModel` v128 réécrit **41 cartes publiées de Killing Floor octet pour octet** (les seules différences sont des charges de NaN signalants que JS normalise) ;
- aller-retour du compact index et de `FString` ;
- sur 25 cartes de Counter-Strike : le volume de lightmaps calculé tient dans le lump `LIGHTING`, l'enroulement des faces respecte `Newell == −normale`, les sommets sont sur le plan de leur face ;
- chaque objet `UPolys` publié colle exactement à la disposition (6054 objets, 37136 polygones, 0 écart) ;
- l'encodeur DXT3, les lecteurs `.mdl` et `.spr`, le rééchantillonneur Lanczos.

Les fichiers de jeu sont cherchés aux emplacements Steam habituels ; sans eux ces vérifications échouent bruyamment au lieu de passer à vide, donc lance `pnpm test` sur une machine où les jeux sont installés (la CI ne fait qu'un smoke test de l'empaquetage).

`--verify` relit le `.rom` fini avec un lecteur indépendant et contrôle 22 invariants : en-tête, tables, plages de serial, résolution des références, plans de nœud unitaires, sommets sur leur plan, enroulement, sections reflétant les polygones des nœuds, plages de lightmaps et UV dans l'atlas, DXT3 bien formé, l'arbre qui est vraiment un arbre, et une chaîne de mips complète sur chaque texture. Mesuré, tout est propre :

```
cs_assault  3206 faces -> 7247 triangles dans 323 meshes   149 textures  13.41 MB
de_dust2    5383 faces -> 9932 triangles dans 229 meshes    36 textures  12.05 MB
cs_italy    8528 faces -> 21038 triangles dans 396 meshes   89 textures  16.35 MB

cs_assault --geometry bsp   3158/3206 faces (98.5%)  3570 nœuds  3569 lightmaps  5 atlas  14.90 MB
```

`test/repack.js <carte.rom>` reconstruit une carte existante avec le même écrivain et compare les octets : sur `KF-CS-Iceworld` la différence est **d'un octet** (`packageFlags`). `test/render-test.ps1` lance le client directement dans la carte, sans passer par le lobby, et tranche sur les lignes `Critical:` de `KillingFloor.log`. `KF-CS-Assault` a été lancé depuis les 20 points d'apparition sans un seul `Critical`.

**Ce que les tests ne couvrent pas :** l'aspect de la carte dans la vue 3D de KFEd (elle a son propre chemin de rendu) et la justesse de l'image — les tests attrapent les plantages, pas les artefacts.

## Vérifier une carte dans le jeu

[`harness/play.ps1`](../../harness/README.md) lance le client dans une carte, pilote la console via `PostMessage`, prend les captures avec le moteur et les convertit en PNG ; `harness/flat.js` juge les images à la densité de contours (18–30 % est normal, ~1,4 % est une image où le monde ne s'est pas dessiné). La règle qui compte : **un résultat négatif ne vaut rien tant que le banc de test lui-même n'est pas prouvé** sur un cas connu pour marcher. Détails et pièges dans [`harness/README.md`](../../harness/README.md) et [`docs/GOTCHAS.md`](../GOTCHAS.md) §7.

## Organisation

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                interface en ligne de commande
│  ├─ convert.js            tout le pipeline
│  ├─ verify.js             contrôle des invariants d'un .rom fini
│  ├─ resources.js          où trouver les .wad et le ciel gfx/env
│  ├─ backendB.js           backend B : .ase (mesh + lumière en couleurs de sommets) + .t3d + BMP 8 bits
│  ├─ goldsrc/              jeu source : bsp.js, wad.js, mdl.js, spr.js, skybox.js
│  ├─ build/                GoldSrc → Unreal : model.js, mesh.js, brushents.js, propmesh.js, skybox*, upscale.js
│  └─ unreal/               écrivain de paquet : package.js, writer.js, model.js, staticmesh.js, polys.js,
│                           texture.js, dxt.js, read.js (lecteur indépendant utilisé par --verify)
├─ electron/                application de bureau : main, preload, renderer, worker (conversion en processus enfant)
├─ test/                    selfcheck.js (pnpm test), repack.js, render-test.ps1
├─ harness/                 play.ps1, flat.js, bmp2png.js — regarder une carte dans le vrai client
├─ scripts/                 outils de recherche ayant servi à décortiquer les formats (voir docs/RESEARCH.md)
└─ docs/                    RESEARCH.md, GOTCHAS.md, translations/
```

## Documentation

- **[docs/RESEARCH.md](../RESEARCH.md)** — l'étude du format : ce qui a été mesuré des deux côtés, l'ordre de sérialisation de `UModel` v128, les trois architectures possibles et pourquoi celle-ci, et comment les ports `KF-CS-*` existants ont réellement été faits.
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — tous les pièges mesurés, dont les cinq invariants dont la violation fait tomber le moteur. Lecture obligatoire avant de toucher à l'écrivain.
- **[harness/README.md](../../harness/README.md)** — vérifier une carte convertie dans le vrai client.

## Cadre juridique

Convertir une carte ne donne pas le droit de la publier. Valve autorise le déplacement d'assets entre jeux dans des mods non commerciaux, mais demande que **les cartes vanilla ne soient pas portées telles quelles** ; Tripwire exige que les mods ne contiennent pas de propriété protégée de tiers sans autorisation écrite et soient distribués gratuitement. Les deux ports publics de cartes Counter-Strike vers Killing Floor (`KF-Dust_1`, `KF-Assault`) ont été retirés du Steam Workshop. Les cartes personnalisées appartiennent à leurs auteurs, pas à Valve — c'est à eux de donner l'autorisation.

Cet importeur ne distribue aucun contenu de jeu et ne produit rien par lui-même : ce qu'il écrit dérive de la carte que tu lui donnes, et où cela peut aller est une affaire entre toi et le propriétaire de la carte source.

## Avertissement

Projet personnel de rétro-ingénierie et d'interopérabilité de formats, publié à des fins de recherche et d'éducation. Faire de la rétro-ingénierie sur le format de paquets du moteur peut heurter le CLUF du jeu — l'usage que tu fais de ce code n'engage que toi. Fourni **tel quel**, sans aucune garantie (voir la licence). Sans lien avec Tripwire Interactive, Epic Games ou Valve.

## Licence

Copyright (c) 2026 Geekrainian.

Publié sous la **GNU General Public License v3.0 ou ultérieure** (GPL-3.0-or-later). Texte complet dans [LICENSE](../../LICENSE). Ce programme est un logiciel libre : tu peux le redistribuer et le modifier selon ces termes, et il vient **sans garantie**.

## Marques

Killing Floor et Unreal sont des marques de Tripwire Interactive et Epic Games ; Counter-Strike, Half-Life et GoldSrc sont des marques de Valve. Ceci est un outil non officiel fait par un fan, sans affiliation ni approbation de leur part.
