# 3D model route (glTF / GLB / OBJ)

Turns a 3D scene into a `.rom`: a model from Sketchfab / CGTrader / Free3D, a Blender `.blend`
exported to glTF, an Open3DLab rip, or a decompiled Source map. Anything that can export glTF/GLB or
OBJ feeds it.

```bash
node src/cli.js --game model "pochinki.glb"  --out "…/KillingFloor/Maps" --name KF-Pochinki --verify
node src/cli.js --game model "school.obj"     --out "…/KillingFloor/Maps" --scale 1.0 --verify
```

## What it reads

- **glTF 2.0 / GLB** — node transforms (the scene is placed), `POSITION`/`NORMAL`/`TEXCOORD_0`,
  indices, `pbrMetallicRoughness` base colour + `baseColorTexture` (PNG/JPEG/TGA, embedded or beside
  the file), and `KHR_lights_punctual` → `Engine.Light` / `Gameplay.Sunlight`.
- **OBJ (+ MTL)** — vertices/normals/UVs, `usemtl` groups, `map_Kd` textures beside the file.
- A `.blend` is not read directly — export it to glTF/GLB from Blender first (File → Export → glTF).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `--scale <n>` | `1.0` | model units → Unreal units. Sketchfab metres vs UE centimetres differ wildly — tune this first if the map is tiny or huge |
| `--crop cx,cy,half` | off | keep only one `2·half` square of a large scene (model units, pre-scale) |
| `--tex-gain <n>` | `0.7` | pre-divide textures; the engine draws an unlit surface at ~2.5×, so a mid-bright texture blows to white without this |
| `--ambient <n>` / `--glow <n>` | `64` / `48` | the zone lights the player; the mesh actors' glow lights the world |
| `--light-gain <n>` | `0.6` | `KHR_lights_punctual` intensity (candela/lux) → a byte brightness |
| `--max-texture <n>` | `512` | cap; textures are resampled to the nearest power of two |
| `--no-sky` / `--no-light` / `--no-spawns` | off | drop the flat sky cube / the lights / the player start |

Environment knobs when an exporter's conventions differ:

- `KF_GLTF_AXES="0,2,1"` — which glTF axis (x=0,y=1,z=2) feeds Unreal x,y,z. Default maps +Y-up onto
  Unreal +Z-up. `KF_GLTF_FLIP="0,0,0"` negates an axis (a horizontal mirror if the map comes out
  reversed).
- `KF_CELL=2048` — spatial chunk size for culling; `0` turns chunking off.
- `KF_SPAWN_AT="x,y,z[,yaw]"` — place the player start exactly (a model carries none).

## What is missing

- Masked / translucent materials are carried opaque (a foliage cut-out would need a Shader).
- A `.blend`, `.fbx`, `.max` etc. must be converted to glTF/GLB or OBJ first.
- Orientation and scale are not verified in-game by the self-check — it proves the `.rom` is
  structurally sound (`test/gltf.test.js`); `KF_GLTF_AXES` / `KF_GLTF_FLIP` / `--scale` are tuned on
  the first run.
