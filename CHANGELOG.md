# Changelog

All notable changes to Killing Floor Map Importer are documented here. The format follows [Conventional Commits](https://www.conventionalcommits.org/) and the version scheme is [Semantic Versioning](https://semver.org/).

## [0.1.6](https://github.com/geekrainian/killingfloor-map-importer/compare/v0.1.5...v0.1.6) (2026-08-20)


### Features

* add Source BSP and 3D-model import routes ([e915577](https://github.com/geekrainian/killingfloor-map-importer/commit/e9155779022705b634063c8f26bab17a59a417c9))


### Bug Fixes

* **render:** the bugs two play-tests turned up in all three routes ([f3e4b70](https://github.com/geekrainian/killingfloor-map-importer/commit/f3e4b703157e1c6b56452cd70151689262214de7))
* **tacticalops,quake3:** the render bugs a play-test turned up ([0ad65d4](https://github.com/geekrainian/killingfloor-map-importer/commit/0ad65d48acec295ac73f4a21315a6febc124f26b))

## [0.1.5](https://github.com/geekrainian/killingfloor-map-importer/compare/v0.1.4...v0.1.5) (2026-08-19)


### Features

* **quake3:** read a Quake III Arena client into a Killing Floor level ([8aa3605](https://github.com/geekrainian/killingfloor-map-importer/commit/8aa3605d683531684234a9cde28468615acccf55))
* **scale:** pin every route's default to its own engine bounds ([e9ca68b](https://github.com/geekrainian/killingfloor-map-importer/commit/e9ca68b0f37a551e5af64baf2501c3cd5b8a4aac))
* **tacticalops:** read a Tactical Ops client into a Killing Floor level ([951173f](https://github.com/geekrainian/killingfloor-map-importer/commit/951173fa0bd0f082a56d53e9adbebeaaf9203e3b))


### Bug Fixes

* **tacticalops:** cut out what the texture says to cut out, and carry water's still image ([3a8a2db](https://github.com/geekrainian/killingfloor-map-importer/commit/3a8a2db889f5c89d43953679f7df4062630c16dc))

## [0.1.4](https://github.com/geekrainian/killingfloor-map-importer/compare/v0.1.3...v0.1.4) (2026-08-17)


### Features

* **karma:** let corpses rest on a converted floor ([f8afc9c](https://github.com/geekrainian/killingfloor-map-importer/commit/f8afc9ca4d8b60dca9f771102545c13b9d5ae19e))
* **lighting:** floor the atlas, ship the ambient split ([e8e80f1](https://github.com/geekrainian/killingfloor-map-importer/commit/e8e80f1121cb731d94627f686707aba6fb42997e))
* **lighting:** keep the lightmapped world lit, so the torch reaches it ([0dd3044](https://github.com/geekrainian/killingfloor-map-importer/commit/0dd3044b535e7e2f546bd9f9e751cf8d0f6afbb6))
* **lighting:** split the world's ambient off the player's ([e2e29db](https://github.com/geekrainian/killingfloor-map-importer/commit/e2e29db2419d9960323e4c2c1bbbfd058da93074))
* **lineage2:** open the carved doorways, mend the sky, toggle the blend ([58c485b](https://github.com/geekrainian/killingfloor-map-importer/commit/58c485b493e1389ba2bada996f85b2ca86d1dd63))
* **lineage2:** read a client's world square into a Killing Floor level ([dbcade2](https://github.com/geekrainian/killingfloor-map-importer/commit/dbcade28408110ce42bad679ddd6c06a12489050))
* **lineage2:** scale the world to the pawn, blend the ground, plant the grass ([8399565](https://github.com/geekrainian/killingfloor-map-importer/commit/839956528efadfb7730a078f002dabb6759ee8dd))
* **sky:** stand a flat sky in when the map's own images are missing ([0ec0bb9](https://github.com/geekrainian/killingfloor-map-importer/commit/0ec0bb95db6b182b5861322bad0825fd7358941f))


### Bug Fixes

* **glass:** stop bullet decals repainting a see-through pane ([7a58051](https://github.com/geekrainian/killingfloor-map-importer/commit/7a58051e12714c6e1782ea2380e790ba863acc83))
* **lighting:** keep glass and water see-through under the lightmap atlas ([b37950d](https://github.com/geekrainian/killingfloor-map-importer/commit/b37950d6f747927fae6ca0f5bd4b946c85fa6976))
* **lineage2:** blend surfaces the way the client says, and spawn on ground ([5611d58](https://github.com/geekrainian/killingfloor-map-importer/commit/5611d5862a3ae96ad51c5933aba2c519493f7bc1))
* **lineage2:** give a carved room its floor, and skip the zone boundaries ([27307ae](https://github.com/geekrainian/killingfloor-map-importer/commit/27307ae9ef0d4cd756ec2a32f4803a6db43d98b8))

## [0.1.3](https://github.com/geekrainian/killingfloor-map-importer/compare/v0.1.2...v0.1.3) (2026-08-11)


### Features

* **breakables:** shoot away every func_breakable, not just the glass ([01237ec](https://github.com/geekrainian/killingfloor-map-importer/commit/01237ec3d73268241720400e58078bf0bdfca0a6))
* **lighting:** carry the map's own baked light across, and three ways to fake it ([d9843e1](https://github.com/geekrainian/killingfloor-map-importer/commit/d9843e1fa899a2845a59981ac5991a3a8fc9c750))


### Bug Fixes

* blue fringes, water volumes, sky sets and the KF colour grade ([509ceb8](https://github.com/geekrainian/killingfloor-map-importer/commit/509ceb8d23edd9c9190ecb71257619138c98fee9))
* **lighting:** pack the luxels at 0.55, not at full strength ([bb44bd3](https://github.com/geekrainian/killingfloor-map-importer/commit/bb44bd346d0926fd3a532e6f21dc11c7eb586aa1))

## [0.1.2](https://github.com/geekrainian/killingfloor-map-importer/compare/v0.1.1...v0.1.2) (2026-08-10)


### Features

* **lighting:** raise the zone ambient a fifth above the measured shadow ([ddc7440](https://github.com/geekrainian/killingfloor-map-importer/commit/ddc74404f05f9226d6f15777249a5903810b2742))
* **materials:** give see-through brush entities a translucent material ([0c73f2b](https://github.com/geekrainian/killingfloor-map-importer/commit/0c73f2b539a0568ecdb5206b9eb8f9a2ef90f328))


### Bug Fixes

* **props:** skip the preview model a spawn point carries ([212f9d3](https://github.com/geekrainian/killingfloor-map-importer/commit/212f9d39b58a6df17af693d2411e5893c9b00dd2))
* **ui:** keep both scrollbars inside the log panel ([fb165e5](https://github.com/geekrainian/killingfloor-map-importer/commit/fb165e579c78c81c26ea4c1493c37a562ef7ecd3))
* **ui:** take a dropped file path from webUtils ([c65cfaa](https://github.com/geekrainian/killingfloor-map-importer/commit/c65cfaa8f9f5769a913a3f8618d591060afaa71a))


### Refactoring

* **ui:** fold the scale advice into the field label ([6dadfb6](https://github.com/geekrainian/killingfloor-map-importer/commit/6dadfb628e881fd59a72c7ad4bf1e7ee3b70008b))

## [0.1.1](https://github.com/geekrainian/killingfloor-map-importer/compare/v0.1.0...v0.1.1) (2026-08-10)


### Features

* **summary:** sign converted maps with the tool, source game and time ([66455b4](https://github.com/geekrainian/killingfloor-map-importer/commit/66455b481ea223169aba88157b36d5b068277c12))
* **ui:** add language picker with nine UI languages ([4d536dd](https://github.com/geekrainian/killingfloor-map-importer/commit/4d536dd9bf877c46cda8366309fe4b4c8bdc0309))


### Bug Fixes

* **props:** turn .mdl props a quarter past the declared yaw ([6f2c8d8](https://github.com/geekrainian/killingfloor-map-importer/commit/6f2c8d8a647393238cbe4fec99ece9501a8ef0f9))
* **world:** ship RootOutside 0 so the editor can rebuild the map ([4c9c057](https://github.com/geekrainian/killingfloor-map-importer/commit/4c9c05722b6006cef5447228d4724d8f24e33da7))

## 0.1.0 (2026-08-09)


### Features

* import GoldSrc maps as Killing Floor levels ([fb4522f](https://github.com/geekrainian/killingfloor-map-importer/commit/fb4522f61a5b4c9557dfd3fd3c65811a7858863e))
