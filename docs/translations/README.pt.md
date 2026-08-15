# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · **Português** · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Importa mapas de outros jogos para o **Killing Floor 1** como níveis `.rom` reais (Unreal Engine 2.5, versão de ficheiro 128 / licensee 29). O pacote é escrito do zero — sem KFEd, sem formatos intermédios, sem passos manuais: aponta para um ficheiro de mapa e obténs um `.rom` que podes largar em `KillingFloor\Maps` e jogar.

O motor de origem hoje é o **GoldSrc BSP v30**: Counter-Strike 1.6, Half-Life e os seus mods. Ler o jogo de origem é um único módulo (`src/goldsrc/`) à frente de uma pipeline comum de construção e escrita, e acrescentar mais jogos é o caminho previsto de crescimento — ver [Roteiro](#roteiro-mais-jogos-de-origem).

> O lado Unreal foi decifrado à mão. A ordem de serialização do `UModel` v128 e a disposição dos lightmaps pré-calculados lá dentro não estão documentadas em lado nenhum, e não existe conversor público de GoldSrc para Unreal. A análise está em [`docs/RESEARCH.md`](../RESEARCH.md); cada armadilha que custou tempo está em [`docs/GOTCHAS.md`](../GOTCHAS.md).

## Estado

| Capacidade | Estado |
| --- | --- |
| Geometria, texturas, colisão, pontos de spawn | funciona — testado no cliente real |
| Céu — as seis imagens reais do mapa em `gfx/env` | funciona |
| Água — nadar, tinta no ecrã, texturas em camadas | funciona |
| Sprites (`.spr`) e props (`.mdl`) | funciona |
| Portas e vidros quebráveis | funciona — `KFDoorMover` + `KFUseTrigger`, `KFGlassMover` |
| Iluminação pré-calculada | parcial — os luxels são lidos e empacotados em atlas DXT3, mas o cliente desenha um ambiente plano de zona (ver [O que falta](#o-que-falta)) |
| Zonas / oclusão por PVS, caminhos de bots, botões e triggers | não |

## O que precisas

- Uma instalação do **Killing Floor 1** (ou o SDK sem Steam) — é para lá que vai o `.rom` final.
- Uma instalação de **Counter-Strike 1.6 / Half-Life** — é onde vivem os ficheiros de texturas `.wad` originais e os céus `gfx/env`. Um mapa descarregado costuma vir só como `.bsp` e precisa deles; sem eles todas as texturas saem magenta e o mapa fica sem céu.
- **Node.js ≥ 18** para a CLI. A aplicação de ambiente de trabalho não precisa de mais nada.

Este repositório não distribui conteúdo do jogo em nenhuma direção. És tu que o apontas para as tuas próprias instalações.

## Aplicação de ambiente de trabalho (Windows / macOS / Linux)

As compilações autónomas prontas estão na página [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases):

- **Windows** — `…-setup.exe` (instalador) ou `…-portable.exe` (sem instalar).
- **macOS** — `…-mac-x64.dmg` (Intel) ou `…-mac-arm64.dmg` (Apple Silicon).
- **Linux** — `…-linux-x86_64.AppImage` (corre em qualquer lado) ou `…-linux-amd64.deb`.

Arrasta ficheiros `.bsp` para a janela, escolhe a pasta de saída e a pasta do Counter-Strike, carrega em Convert. Cada mapa é convertido num processo filho, por isso uma falha ou um mapa enorme não leva a janela com ele. As compilações não são assinadas, por isso o sistema pode avisar no primeiro arranque (Windows SmartScreen → *Mais informações → Executar mesmo assim*; macOS → clique direito → *Abrir*).

### Compilar tu mesmo

```bash
pnpm install
pnpm start          # correr a app a partir do código
pnpm run dist       # criar instaladores para o sistema atual em dist/
```

## CLI

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| Opção | Por omissão | O que faz |
| --- | --- | --- |
| `--out <ficheiro\|pasta>` | ao lado do `.bsp` | onde escrever o `.rom` |
| `--name KF-Xxx` | `KF-<nome do bsp>` | nome do mapa dentro do pacote |
| `--scale <n>` | `1.9` | unidades GoldSrc → unidades Unreal |
| `--lightmap-scale <n>` | `32` | tamanho do luxel em unidades Unreal |
| `--cs-dir <pasta>` | — | pasta do cliente de Counter-Strike 1.6: `.wad` originais, céus `gfx/env`, `sprites/*.spr` |
| `--wad <pasta>` | a do mapa e duas acima | pastas extra onde procurar ficheiros `.wad` |
| `--geometry mesh\|bsp\|both` | `mesh` | o que desenha o mundo: static meshes, o BSP, ou o BSP com as malhas só como colisão |
| `--verify` | desligado | reler o `.rom` final com um leitor independente e verificar os invariantes |
| `--no-spawns` | desligado | não transportar os pontos de spawn |
| `--ase` | desligado | emitir também `.ase` / `.t3d` (backend B, para acabamento manual no KFEd) |

Interruptores de diagnóstico, deixados de propósito: `--no-sky`, `--no-extras`, `--no-light`, `--tree-translate`, `--spawn-index N`. A variável de ambiente `KF_SPAWN_AT="x,y,z[,yaw]"` substitui todos os pontos de spawn por um único naquele ponto — a forma de aterrar onde está o que queres ver.

## O que é transportado

| | Como |
| --- | --- |
| geometria do mundo | static meshes, um material por malha, cortadas numa grelha de 2048 UU, com winding invertido (o espelho em Y inverte a orientação do triângulo); a colisão é a sua árvore kDOP |
| entidades brush (`func_wall`, `func_illusionary`, `func_ladder`…) | do mesmo modo, respeitando a chave `origin` da entidade |
| portas (`func_door`, `func_door_rotating`) | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger` — abrem com a tecla de uso e podem ser soldadas como uma porta nativa do KF; `KeyPos`/`KeyRot` a partir de `angle`/`lip`/`distance` |
| vidros quebráveis (`func_breakable`, material 0/7) | `KFMod.KFGlassMover`, `Health` da entidade, `Style = STY_Translucent` |
| água (`func_water`) | plano superior translúcido mais um `PhysicsVolume` com caixa brush real (`bWaterVolume`, nevoeiro, afogamento) |
| sprites (`env_sprite`, `env_glow`, `cycler_sprite`) | billboards `Engine.Effects`, additive ou alpha conforme o formato de textura do `.spr` |
| props (`.mdl` nas mesmas entidades) | static mesh em pose de bind mais um ator por instância; texturas do modelo ou de `<nome>T.mdl` |
| texturas | miptex de 8 bits → `UTexture` P8 + `UPalette` **sem recodificar**; os 4 mips do GoldSrc continuam por amostragem pontual até 1×1 |
| texturas com máscara (`{name`) | a paleta é permutada para mover o índice transparente de 255 para 0, flag `PF_Masked` |
| céu | seis imagens `gfx/env/<skyname>*` → RGBA8 (sem compressão por blocos: cria bandas nos gradientes) num cubo de skybox; as faces `sky` são recortadas das malhas; sem `skyname` usa-se o `desert` por omissão do motor |
| iluminação | `ZoneInfo.AmbientBrightness` a partir do nível de sombra dos próprios luxels do mapa, mais atores `Light`/`Sunlight` das entidades de luz; na rota BSP também atlas DXT3 de lightmaps dentro do `UModel` |
| pontos de spawn | `info_player_start` / `info_player_deathmatch` → `PlayerStart`, levantados até ao chão |
| escala | ×1.9 por omissão (×2 é o que medem os ports `KF-CS-*` publicados, e faz a grelha de luxels de 16 unidades do GoldSrc assentar exatamente nos 32 UU do UE2.5) |

As faces que ficam de fora são as texturas de ferramenta invisíveis — `aaatrigger`, `clip`, `null`, `hint` —, que não têm nada que fazer no mundo: 48 de 3206 em cs_assault, 25 de 5383 em de_dust2, 36 de 8528 em cs_italy.

## O que falta

- **Sombras pré-calculadas.** Os luxels do GoldSrc são amostrados e escritos, mas o cliente não os aplica em tempo de execução, por isso a iluminação é plana: ambiente de zona derivado dos próprios luxels do mapa. Provavelmente pede uma passagem de `Build Lighting` no KFEd.
- **Zonas.** Sempre duas (0 = sólido, 1 = o mundo), logo não há oclusão por PVS: desenha-se tudo. Aceitável para o tamanho de um mapa de Counter-Strike.
- **Caminhos de bots.** `PathNode` / `ReachSpec` não são gerados — é preciso uma passagem de `Build Paths` no KFEd.
- **Botões e comboios.** `func_button`, `trigger_*` e `func_train` ficam como geometria estática.
- **Texturas animadas** são transportadas com o frame 0; `-0` (tiling aleatório) passa a textura normal.
- **Texturas que não são potência de dois** são reamostradas para a potência de dois mais próxima (caso contrário o UE2.5 dimensiona o buffer por `UBits` e corrompe a heap). Os eixos de textura são escalados por `pot/orig`, por isso as UV não deslizam.

## Roteiro: mais jogos de origem

A pipeline está dividida de forma a que o jogo de origem seja a única parte que muda: `src/goldsrc/` lê o mapa, `src/build/` transforma-o em estruturas Unreal, `src/unreal/` escreve o pacote. Acrescentar um jogo significa um leitor novo que produza a mesma forma intermédia — faces com UV, texturas, entidades, uma grelha de lightmap — sem mexer em nada dentro de `src/unreal/`. As variantes de BSP do Quake, Quake II e Source são os candidatos óbvios seguintes: a mesma família de formatos e o mesmo escritor de `UModel` no fim.

Contribuições nessa direção são bem-vindas; começa por [`docs/RESEARCH.md`](../RESEARCH.md) para o formato de destino e por [`docs/GOTCHAS.md`](../GOTCHAS.md) para os invariantes que não podem ser quebrados.

## Como é verificado

```bash
pnpm test          # node test/selfcheck.js
```

19 verificações, todas verdes. As que sustentam o resto:

- o serializador do `UModel` v128 reescreve **41 mapas publicados do Killing Floor byte a byte** (as únicas diferenças são payloads de NaN sinalizador que o JS normaliza);
- round-trip de compact index e `FString`;
- em 25 mapas de Counter-Strike: o volume calculado de lightmaps cabe no lump `LIGHTING`, o winding das faces cumpre `Newell == −normal`, os vértices estão sobre o plano da sua face;
- cada objeto `UPolys` publicado encaixa exatamente na disposição (6054 objetos, 37136 polígonos, 0 divergências);
- o codificador DXT3, os leitores de `.mdl` e `.spr`, o reamostrador Lanczos.

Os ficheiros do jogo são procurados nos locais habituais do Steam; sem eles essas verificações falham em voz alta em vez de passarem vazias, por isso corre `pnpm test` numa máquina que tenha os jogos (o CI só faz um smoke test do empacotamento).

`--verify` relê o `.rom` final com um leitor independente e verifica 22 invariantes: cabeçalho, tabelas, intervalos de serial, resolução de referências, planos de nó unitários, vértices sobre o seu plano, winding, secções que espelham os polígonos dos nós, intervalos de lightmap e UV dentro do atlas, DXT3 bem formado, a árvore ser mesmo uma árvore, e uma cadeia de mips completa em cada textura. Medido, tudo limpo:

```
cs_assault  3206 faces -> 7247 triângulos em 323 malhas   149 texturas  13.41 MB
de_dust2    5383 faces -> 9932 triângulos em 229 malhas    36 texturas  12.05 MB
cs_italy    8528 faces -> 21038 triângulos em 396 malhas   89 texturas  16.35 MB

cs_assault --geometry bsp   3158/3206 faces (98.5%)  3570 nós  3569 lightmaps  5 atlas  14.90 MB
```

`test/repack.js <mapa.rom>` reconstrói um mapa existente com o mesmo escritor e compara bytes: em `KF-CS-Iceworld` a diferença é **um byte** (`packageFlags`). `test/render-test.ps1` lança o cliente diretamente no mapa, saltando o lobby, e decide pelas linhas `Critical:` no `KillingFloor.log`. O `KF-CS-Assault` foi corrido a partir dos 20 pontos de spawn sem um único `Critical`.

**O que os testes não cobrem:** o aspeto do mapa no viewport 3D do KFEd (tem o seu próprio caminho de render) e se a imagem está *correta* — os testes apanham crashes, não artefactos.

## Verificar um mapa no jogo

[`harness/play.ps1`](../../harness/README.md) lança o cliente dentro de um mapa, conduz a consola com `PostMessage`, tira capturas com o motor e converte-as para PNG; `harness/flat.js` julga os frames pela densidade de arestas (18–30 % é normal, ~1,4 % é um frame em que o mundo não foi desenhado). A regra que importa: **um resultado negativo não vale nada até o próprio harness estar provado** num caso que se sabe funcionar. Detalhes e armadilhas em [`harness/README.md`](../../harness/README.md) e [`docs/GOTCHAS.md`](../GOTCHAS.md) §7.

## Estrutura

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                interface de linha de comandos
│  ├─ convert.js            a pipeline completa
│  ├─ verify.js             verificação de invariantes de um .rom pronto
│  ├─ resources.js          onde encontrar os .wad e o céu gfx/env
│  ├─ backendB.js           backend B: .ase (malha + luz nas cores dos vértices) + .t3d + BMP de 8 bits
│  ├─ goldsrc/              jogo de origem: bsp.js, wad.js, mdl.js, spr.js, skybox.js
│  ├─ build/                GoldSrc → Unreal: model.js, mesh.js, brushents.js, propmesh.js, skybox*, upscale.js
│  └─ unreal/               escritor do pacote: package.js, writer.js, model.js, staticmesh.js, polys.js,
│                           texture.js, dxt.js, read.js (leitor independente usado por --verify)
├─ electron/                app de ambiente de trabalho: main, preload, renderer, worker (conversão em processo filho)
├─ test/                    selfcheck.js (pnpm test), repack.js, render-test.ps1
├─ harness/                 play.ps1, flat.js, bmp2png.js — ver um mapa no cliente real
├─ scripts/                 ferramentas de investigação com que os formatos foram decifrados (ver docs/RESEARCH.md)
└─ docs/                    RESEARCH.md, GOTCHAS.md, translations/
```

## Documentação

- **[docs/RESEARCH.md](../RESEARCH.md)** — a investigação do formato: o que foi medido dos dois lados, a ordem de serialização do `UModel` v128, as três arquiteturas possíveis e porquê esta, e como foram realmente feitos os ports `KF-CS-*` existentes.
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — todas as armadilhas medidas, incluindo os cinco invariantes cuja violação derruba o motor. Leitura obrigatória antes de mexer no escritor.
- **[harness/README.md](../../harness/README.md)** — verificar um mapa convertido no cliente real.

## Enquadramento legal

Converter um mapa não dá o direito de o publicar. A Valve permite mover assets entre jogos em mods não comerciais, mas pede que **os mapas vanilla não sejam portados tal e qual**; a Tripwire exige que os mods não contenham propriedade protegida de terceiros sem autorização escrita e sejam gratuitos. Ambos os ports públicos de mapas de Counter-Strike para Killing Floor (`KF-Dust_1`, `KF-Assault`) foram removidos da Steam Workshop. Os mapas personalizados pertencem aos seus autores, não à Valve — a autorização é deles.

Este importador não distribui conteúdo do jogo e por si só não produz nada: o que escreve deriva do mapa que lhe deres, e para onde isso pode ir é assunto entre ti e quem for dono do mapa de origem.

## Aviso

Projeto pessoal de engenharia inversa e interoperabilidade de formatos, publicado para fins de investigação e educação. Fazer engenharia inversa do formato de pacotes do motor pode colidir com o EULA do jogo — o uso que fizeres deste código é da tua responsabilidade. Fornecido **tal como está**, sem qualquer garantia (ver a licença). Sem ligação à Tripwire Interactive, Epic Games ou Valve.

## Licença

Copyright (c) 2026 Geekrainian.

Publicado sob a **GNU General Public License v3.0 ou posterior** (GPL-3.0-or-later). Texto completo em [LICENSE](../../LICENSE). Este programa é software livre: podes redistribuí-lo e modificá-lo nesses termos, e vem **sem garantia**.

## Aviso de marcas

Killing Floor e Unreal são marcas da Tripwire Interactive e da Epic Games; Counter-Strike, Half-Life e GoldSrc são marcas da Valve. Esta é uma ferramenta não oficial feita por fãs, sem afiliação nem apoio de nenhuma delas.
