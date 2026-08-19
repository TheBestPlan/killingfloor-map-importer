# Killing Floor Map Importer

[English](../../README.md) · [Русский](./README.ru.md) · **Español** · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Importa mapas de otros juegos a **Killing Floor 1** como niveles `.rom` reales (Unreal Engine 2.5, versión de archivo 128 / licensee 29). El paquete se escribe desde cero — sin KFEd, sin formatos intermedios, sin pasos manuales: apúntalo a un archivo de mapa y obtén un `.rom` que puedes soltar en `KillingFloor\Maps` y jugar.

El motor de origen a día de hoy es **GoldSrc BSP v30**: Counter-Strike 1.6, Half-Life y sus mods. Leer el juego de origen es un único módulo (`src/goldsrc/`) delante de una tubería común de construcción y escritura, y añadir más juegos es la vía prevista de crecimiento — ver [Hoja de ruta](#hoja-de-ruta-más-juegos-de-origen).

> El lado de Unreal se descifró a mano. El orden de serialización de `UModel` v128 y la disposición de los lightmaps precalculados dentro de él no están documentados en ninguna parte, y no existe ningún conversor público de GoldSrc a Unreal. El análisis está en [`docs/RESEARCH.md`](../RESEARCH.md); cada trampa que costó tiempo, en [`docs/GOTCHAS.md`](../GOTCHAS.md).

## Estado

| Capacidad | Estado |
| --- | --- |
| Geometría, texturas, colisión, puntos de aparición | funciona — probado en el cliente real |
| Cielo — las seis imágenes reales de `gfx/env` del mapa | funciona |
| Agua — nadar, tinte de pantalla, texturas en capas | funciona |
| Sprites (`.spr`) y props (`.mdl`) | funciona |
| Puertas y cristales rompibles | funciona — `KFDoorMover` + `KFUseTrigger`, `KFGlassMover` |
| Iluminación precalculada | parcial — los luxels se leen y se empaquetan en atlas DXT3, pero el cliente dibuja un ambiente plano de zona (ver [Lo que falta](#lo-que-falta)) |
| Zonas / oclusión por PVS, rutas de bots, botones y triggers | no |

## Qué necesitas

- Una instalación de **Killing Floor 1** (o el SDK sin Steam) — ahí va el `.rom` terminado.
- Una instalación de **Counter-Strike 1.6 / Half-Life** — ahí viven los archivos de texturas `.wad` de serie y los cielos `gfx/env`. Un mapa descargado suele venir solo como `.bsp` y los necesita; sin ellos todas las texturas salen magenta y el mapa no tiene cielo.
- **Node.js ≥ 18** para la CLI. La aplicación de escritorio no necesita nada más.

Este repositorio no distribuye contenido del juego en ninguna dirección. Tú lo apuntas a tus propias instalaciones.

## Aplicación de escritorio (Windows / macOS / Linux)

Las compilaciones autónomas listas están en la página de [Releases](https://github.com/geekrainian/killingfloor-map-importer/releases):

- **Windows** — `…-setup.exe` (instalador) o `…-portable.exe` (sin instalar).
- **macOS** — `…-mac-x64.dmg` (Intel) o `…-mac-arm64.dmg` (Apple Silicon).
- **Linux** — `…-linux-x86_64.AppImage` (funciona en cualquier sitio) o `…-linux-amd64.deb`.

Arrastra archivos `.bsp` a la ventana, elige la carpeta de salida y la de Counter-Strike, pulsa Convert. Cada mapa se convierte en un proceso hijo, así que un fallo o un mapa enorme no se lleva la ventana por delante. Las compilaciones no están firmadas, así que el sistema puede avisar al primer arranque (Windows SmartScreen → *Más información → Ejecutar de todas formas*; macOS → clic derecho → *Abrir*).

### Compilarlo tú mismo

```bash
pnpm install
pnpm start          # ejecutar la app desde el código
pnpm run dist       # construir instaladores para el sistema actual en dist/
```

## CLI

```bash
node src/cli.js "…/cstrike/maps/cs_assault.bsp" --out "…/KillingFloor/Maps" \
     --name KF-CS-Assault --cs-dir "…/Counter-Strike 1.6" --verify
```

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `--out <archivo\|carpeta>` | junto al `.bsp` | dónde escribir el `.rom` |
| `--name KF-Xxx` | `KF-<nombre del bsp>` | nombre del mapa dentro del paquete |
| `--scale <n>` | `1.9165` | unidades GoldSrc → unidades Unreal |
| `--lightmap-scale <n>` | `32` | tamaño del luxel en unidades Unreal |
| `--cs-dir <carpeta>` | — | carpeta del cliente de Counter-Strike 1.6: `.wad` de serie, cielos `gfx/env`, `sprites/*.spr` |
| `--wad <carpeta>` | la del mapa y dos por encima | carpetas extra donde buscar archivos `.wad` |
| `--geometry mesh\|bsp\|both` | `mesh` | qué dibuja el mundo: static meshes, el BSP, o el BSP con las mallas solo como colisión |
| `--verify` | apagado | releer el `.rom` terminado con un lector independiente y comprobar sus invariantes |
| `--no-spawns` | apagado | no trasladar los puntos de aparición |
| `--ase` | apagado | emitir además `.ase` / `.t3d` (backend B, para rematar a mano en KFEd) |

Interruptores de diagnóstico, dejados a propósito: `--no-sky`, `--no-extras`, `--no-light`, `--tree-translate`, `--spawn-index N`. La variable de entorno `KF_SPAWN_AT="x,y,z[,yaw]"` sustituye todos los puntos de aparición por uno solo en ese punto — la forma de aterrizar donde está lo que quieres mirar.

## Qué se traslada

| | Cómo |
| --- | --- |
| geometría del mundo | static meshes, un material por malla, cortados en una rejilla de 2048 UU, con el bobinado invertido (el espejo en Y invierte la orientación del triángulo); la colisión es su árbol kDOP |
| entidades brush (`func_wall`, `func_illusionary`, `func_ladder`…) | igual, respetando la clave `origin` de la entidad |
| puertas (`func_door`, `func_door_rotating`) | `KFMod.KFDoorMover` + `KFMod.KFUseTrigger` — se abren con la tecla de uso y se pueden soldar como una puerta nativa de KF; `KeyPos`/`KeyRot` a partir de `angle`/`lip`/`distance` |
| cristales rompibles (`func_breakable`, material 0/7) | `KFMod.KFGlassMover`, `Health` de la entidad, `Style = STY_Translucent` |
| agua (`func_water`) | plano superior translúcido más un `PhysicsVolume` con caja brush real (`bWaterVolume`, niebla, ahogarse) |
| sprites (`env_sprite`, `env_glow`, `cycler_sprite`) | billboards `Engine.Effects`, additive o alpha según el formato de textura del `.spr` |
| props (`.mdl` en esas mismas entidades) | static mesh en pose de bind más un actor por instancia; texturas del modelo o de `<nombre>T.mdl` |
| texturas | miptex de 8 bits → `UTexture` P8 + `UPalette` **sin recodificar**; los 4 mips de GoldSrc se continúan por muestreo puntual hasta 1×1 |
| texturas con máscara (`{name`) | la paleta se permuta para mover el índice transparente del 255 al 0, flag `PF_Masked` |
| cielo | seis imágenes `gfx/env/<skyname>*` → RGBA8 (sin compresión por bloques: produce bandas en los degradados) sobre un cubo de skybox; las caras `sky` se recortan de las mallas; sin `skyname` se usa el `desert` por defecto del motor |
| iluminación | `ZoneInfo.AmbientBrightness` a partir del nivel de sombra de los propios luxels del mapa, más actores `Light`/`Sunlight` de las entidades de luz; en la ruta BSP, además atlas DXT3 de lightmaps dentro de `UModel` |
| puntos de aparición | `info_player_start` / `info_player_deathmatch` → `PlayerStart`, elevados hasta el suelo |
| escala | ×1.9165 por defecto (×2 es lo que miden los ports `KF-CS-*` publicados, y hace que la rejilla de luxels de 16 unidades de GoldSrc caiga exactamente sobre los 32 UU de UE2.5) |

Las caras que no llegan son las texturas de herramienta invisibles — `aaatrigger`, `clip`, `null`, `hint` —, que no pintan nada en el mundo: 48 de 3206 en cs_assault, 25 de 5383 en de_dust2, 36 de 8528 en cs_italy.

## Lo que falta

- **Sombras precalculadas.** Los luxels de GoldSrc se muestrean y se escriben, pero el cliente no los aplica en tiempo de ejecución, así que la iluminación es plana: ambiente de zona derivado de los propios luxels del mapa. Probablemente pide una pasada de `Build Lighting` en KFEd.
- **Zonas.** Siempre dos (0 = sólido, 1 = el mundo), así que no hay oclusión por PVS: se dibuja todo. Aceptable al tamaño de un mapa de Counter-Strike.
- **Rutas de bots.** No se generan `PathNode` / `ReachSpec` — hace falta una pasada de `Build Paths` en KFEd.
- **Botones y trenes.** `func_button`, `trigger_*` y `func_train` se quedan como geometría estática.
- **Las texturas animadas** se trasladan con el fotograma 0; `-0` (tiling aleatorio) pasa a ser una textura normal.
- **Las texturas que no son potencia de dos** se remuestrean a la potencia de dos más cercana (UE2.5 dimensiona el búfer con `UBits` y corrompe el heap si no). Los ejes de textura se escalan por `pot/orig`, así que las UV no se desplazan.

## Hoja de ruta: más juegos de origen

La tubería está partida de forma que el juego de origen sea lo único que cambia: `src/goldsrc/` lee el mapa, `src/build/` lo convierte en estructuras de Unreal, `src/unreal/` escribe el paquete. Añadir un juego significa un lector nuevo que produzca la misma forma intermedia — caras con UV, texturas, entidades, una rejilla de lightmap — sin tocar nada de `src/unreal/`. Las variantes de BSP de Quake, Quake II y Source son los siguientes candidatos obvios: misma familia de formatos y el mismo escritor de `UModel` al final.

Las contribuciones en esa dirección son bienvenidas; empieza por [`docs/RESEARCH.md`](../RESEARCH.md) para el formato de destino y [`docs/GOTCHAS.md`](../GOTCHAS.md) para los invariantes que no se pueden romper.

## Cómo se verifica

```bash
pnpm test          # node test/selfcheck.js
```

19 comprobaciones, todas en verde. Las que sostienen el resto:

- el serializador de `UModel` v128 reescribe **41 mapas publicados de Killing Floor byte a byte** (las únicas diferencias son cargas de NaN señalizadores que JS normaliza);
- round-trip de compact index y `FString`;
- en 25 mapas de Counter-Strike: el volumen calculado de lightmaps cabe en el lump `LIGHTING`, el bobinado de las caras cumple `Newell == −normal`, los vértices están sobre el plano de su cara;
- cada objeto `UPolys` publicado encaja exactamente en la disposición (6054 objetos, 37136 polígonos, 0 discrepancias);
- el codificador DXT3, los lectores de `.mdl` y `.spr`, el remuestreo Lanczos.

Los archivos del juego se buscan en las ubicaciones habituales de Steam; sin ellos esas comprobaciones fallan en voz alta en vez de pasar vacías, así que ejecuta `pnpm test` en una máquina que tenga los juegos (la CI solo hace un smoke test del empaquetado).

`--verify` relee el `.rom` terminado con un lector independiente y comprueba 22 invariantes: cabecera, tablas, rangos de serial, resolución de referencias, planos de nodo unitarios, vértices sobre su plano, bobinado, secciones que reflejan los polígonos de los nodos, rangos de lightmap y UV dentro del atlas, DXT3 bien formado, que el árbol sea realmente un árbol y una cadena de mips completa en cada textura. Medido, todo limpio:

```
cs_assault  3206 caras -> 7247 triángulos en 323 mallas   149 texturas  13.41 MB
de_dust2    5383 caras -> 9932 triángulos en 229 mallas    36 texturas  12.05 MB
cs_italy    8528 caras -> 21038 triángulos en 396 mallas   89 texturas  16.35 MB

cs_assault --geometry bsp   3158/3206 caras (98.5%)  3570 nodos  3569 lightmaps  5 atlas  14.90 MB
```

`test/repack.js <mapa.rom>` reconstruye un mapa existente con el mismo escritor y compara bytes: en `KF-CS-Iceworld` la diferencia es **un byte** (`packageFlags`). `test/render-test.ps1` lanza el cliente directamente al mapa, saltándose el lobby, y dictamina según las líneas `Critical:` de `KillingFloor.log`. `KF-CS-Assault` se ha ejecutado desde los 20 puntos de aparición sin un solo `Critical`.

**Lo que los tests no cubren:** cómo se ve el mapa en el viewport 3D de KFEd (tiene su propia ruta de render) y si la imagen es *correcta* — los tests cazan caídas, no artefactos.

## Comprobar un mapa en el juego

[`harness/play.ps1`](../../harness/README.md) lanza el cliente dentro de un mapa, maneja la consola con `PostMessage`, toma capturas con el motor y las convierte a PNG; `harness/flat.js` juzga los fotogramas por densidad de bordes (18–30 % es normal, ~1,4 % es un fotograma en el que el mundo no se dibujó). La regla que importa: **un resultado negativo no vale nada hasta que el propio arnés esté probado** con un caso que se sabe que funciona. Detalles y trampas en [`harness/README.md`](../../harness/README.md) y [`docs/GOTCHAS.md`](../GOTCHAS.md) §7.

## Estructura

```
killingfloor-map-importer/
├─ src/
│  ├─ cli.js                interfaz de línea de comandos
│  ├─ convert.js            la tubería completa
│  ├─ verify.js             comprobación de invariantes de un .rom terminado
│  ├─ resources.js          dónde encontrar los .wad y el cielo gfx/env
│  ├─ backendB.js           backend B: .ase (malla + luz en colores de vértice) + .t3d + BMP de 8 bits
│  ├─ goldsrc/              juego de origen: bsp.js, wad.js, mdl.js, spr.js, skybox.js
│  ├─ build/                GoldSrc → Unreal: model.js, mesh.js, brushents.js, propmesh.js, skybox*, upscale.js
│  └─ unreal/               escritor del paquete: package.js, writer.js, model.js, staticmesh.js, polys.js,
│                           texture.js, dxt.js, read.js (lector independiente usado por --verify)
├─ electron/                app de escritorio: main, preload, renderer, worker (conversión en proceso hijo)
├─ test/                    selfcheck.js (pnpm test), repack.js, render-test.ps1
├─ harness/                 play.ps1, flat.js, bmp2png.js — mirar un mapa en el cliente real
├─ scripts/                 herramientas de investigación con las que se descifraron los formatos (ver docs/RESEARCH.md)
└─ docs/                    RESEARCH.md, GOTCHAS.md, translations/
```

## Documentación

- **[docs/RESEARCH.md](../RESEARCH.md)** — la investigación del formato: qué se midió en ambos lados, el orden de serialización de `UModel` v128, las tres arquitecturas posibles y por qué esta, y cómo se hicieron realmente los ports `KF-CS-*` existentes.
- **[docs/GOTCHAS.md](../GOTCHAS.md)** — todas las trampas medidas, incluidos los cinco invariantes cuya violación tumba el motor. Lectura obligatoria antes de tocar el escritor.
- **[harness/README.md](../../harness/README.md)** — comprobar un mapa convertido en el cliente real.

## Marco legal

Convertir un mapa no da derecho a publicarlo. Valve permite mover assets entre juegos en mods no comerciales, pero pide que **los mapas vanilla no se porteen tal cual**; Tripwire exige que los mods no lleven propiedad protegida de terceros sin permiso escrito y que sean gratuitos. Los dos ports públicos de mapas de Counter-Strike a Killing Floor (`KF-Dust_1`, `KF-Assault`) fueron retirados del Steam Workshop. Los mapas personalizados pertenecen a sus autores, no a Valve — el permiso es suyo.

Este importador no distribuye contenido del juego y por sí mismo no produce nada: lo que escribe deriva del mapa que le des, y a dónde puede ir eso es asunto entre tú y quien sea dueño del mapa de origen.

## Aviso

Proyecto personal de ingeniería inversa e interoperabilidad de formatos, publicado con fines de investigación y educación. Hacer ingeniería inversa del formato de paquetes del motor puede chocar con el EULA del juego — el uso que hagas de este código es responsabilidad tuya y solo tuya. Se ofrece **tal cual**, sin garantía alguna (ver la licencia). Sin relación con Tripwire Interactive, Epic Games ni Valve.

## Licencia

Copyright (c) 2026 Geekrainian.

Publicado bajo la **GNU General Public License v3.0 o posterior** (GPL-3.0-or-later). Texto completo en [LICENSE](../../LICENSE). Este programa es software libre: puedes redistribuirlo y modificarlo bajo esos términos, y viene **sin garantía**.

## Aviso de marcas

Killing Floor y Unreal son marcas de Tripwire Interactive y Epic Games; Counter-Strike, Half-Life y GoldSrc son marcas de Valve. Esta es una herramienta no oficial hecha por fans, sin afiliación ni respaldo de ninguna de ellas.
