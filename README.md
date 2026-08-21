# Cosmos Journeyer — live universe background

A real-time 3D star system used as the background of a scrolling web page.

Not a video, not a rendered image sequence, not a canvas of pre-baked frames: the
scene is rendered every frame by [Cosmos Journeyer](https://cosmosjourneyer.com)'s
own engine, and the page scroll drives the camera through it. Scroll down and you
fly past Mars, Earth, Neptune, Saturn and Jupiter, out through four volumetric
nebulae, and into the sun until it whites out the screen. HTML sections sit on top
throughout.

The scroll position is never used to render. It feeds a target; a spring on its own
animation frame chases that target; the camera reads the spring. That indirection is
the whole reason the flight feels like flying rather than like scrubbing a timeline.

> **This repository is the Corresponding Source for the page served at
> `deploy-stage-swart.vercel.app`.** Cosmos Journeyer is AGPL-3.0-only, and its
> section 13 requires that anyone the page is served to over a network can obtain
> the source of the version running. That is why this repository is public and
> why the page footer links to it. If the deployed build changes, run `./sync.sh`
> and push, or the offer no longer matches what is being served.

## Licence

Cosmos Journeyer is **AGPL-3.0-only**, so this derived work is too, and the full
text is in [`LICENSE`](LICENSE). The AGPL's network clause is the part that matters
here: publishing the page over a network counts as conveying it, so the corresponding
source has to be offered to anyone the page is served to. That is what this
repository is for.

The ship model is **"Aircraft Decor" by jimbogies, CC-BY-4.0**
([Sketchfab](https://sketchfab.com/3d-models/aircraft-decor-7e3aa0fa94ea43cb90b8c7984e724cf2)).
CC-BY requires the credit to travel with the work, so it is rendered in the page
footer — not only recorded here. Keep it there.

## What lives here

The engine and its ~500 MB of assets belong to upstream, are already published, and
are not vendored. This repository holds the background and nothing else — the flight,
the ship, the nebulae, the page, and the measurement tools:

    ./bootstrap.sh [target]

clones upstream at the pinned commit in [`UPSTREAM`](UPSTREAM), restores its Git LFS
objects, copies `overlay/` over the top, and installs. Then:

    pnpm --filter game dev      # http://localhost:8080/background.html
    pnpm --filter game build    # dist/
    node packages/game/prune-dist.mjs           # drop unused audio
    python3 packages/game/shrink-dist.py packages/game/dist 512   # downscale textures
    python3 packages/game/stub-glb.py packages/game/dist          # strip GLB textures

The last step is not optional for a deployed build. Upstream ships 4K terrain
materials because you can land on its planets and walk around; this page never
gets nearer than a few planetary radii, where a 4096px albedo and a 512px one
are the same handful of pixels. Measured, the page transferred **148 MB** before
that step and **41 MB** after, which is the difference between loading on a phone
and not. `stub-glb.py` does the same for the models — a rock, a tree, an
astronaut, none of which a flyby ever shows — replacing their embedded textures
with a single pixel while leaving every node and mesh in place, because the
loader looks meshes up by name. Together: **153 MB of build becomes 31 MB.**

Edit inside the checkout, where it runs; `./sync.sh [checkout]` copies the overlay
back here. Both default to a `checkout/` sibling of this repository.

The commit is pinned deliberately. The overlay reaches into upstream internals —
`StarSystemView`, the post-process manager, the chunk forge — and a later upstream
commit may work but is not something this repository can promise.

### Git LFS

Upstream stores its textures, models and wasm in Git LFS. Clone without `git-lfs`
installed and you get small text pointers wearing the original filenames, and the
build fails somewhere deep in asset loading — a `.wasm` whose magic number is the
ASCII `vers`. Installing `git-lfs` is the tidy fix; `tools/fix-lfs.mjs` is there for
when you cannot, and fetches the objects from GitHub's media host instead, checking
each declared size so a truncated download cannot masquerade as an asset.

## Layout

    overlay/packages/game/
      background.html                 page: seven sticky panels, loader, whiteout, credits
      src/styles/background.css       panels are 190svh tall with sticky inner content
      src/ts/background.ts            entry: engine, scroll loop, sun ramp, nebula specs
      src/ts/background/
        corridor.ts                   the flight path — where bodies sit, where the camera looks
        corridorSystem.ts             rewrites Sol so the planets land on the trajectory
        corridorFlight.ts             advances the camera along the corridor each frame
        cameraDriver.ts               critically damped spring, fixed sub-steps
        smoothScroll.ts               wheel capture and its own glide
        shipModel.ts                  the chase ship: framing, banking, materials, lights
        nebula.ts                     raymarched volumetric cloud, depth-aware
        speedCue.ts                   near-field dust
        pointerInfluence.ts           subtle mouse/touch parallax
        quality.ts                    per-device rendering budget
        universeBackground.ts         builds upstream's scene without the game shell
    tools/                            CDP harnesses over Node's built-in WebSocket, no deps

`tools/scan.mjs` drives a headless Chrome through the whole flight and reports frame
rate and screenshots per stop (`MOBILE=1` for the phone profile); `record.mjs` and
`glide.mjs` capture per-frame motion so smoothness can be measured rather than
guessed at.

## Things worth knowing before changing them

**The camera's heading is authored, not derived.** The obvious implementation points
the camera along the path's tangent. But the tangent mixes pacing into direction, so
every change of speed became a change of aim: measured turn jerk was 5.86°/s² against
a turn rate of 6.04°/s — the flight was almost as much jolt as motion. Authoring the
heading as its own curve, independent of pacing, took jerk to 0.037°/s². That is the
single largest difference between this feeling like a spaceship and like a mouse wheel.

**Averaging directions cancels; average positions instead.** Blending unit vectors
toward two bodies on opposite sides yields a vector near zero that flips violently.
The glance target is a weighted centroid of positions.

**Babylon decides transparency from `material.alpha`, not `alphaMode`.** A nebula at
alpha 1 punches a black disc through everything behind it. They run at `0.999`.

**`sample` is a reserved word in GLSL.** A variable named `sample` makes the shader
fail to compile silently, and the nebula simply does not appear.

**Upstream appends its UI containers straight to `<body>`** and relies on its own
stylesheet to take them out of flow. This page does not load that stylesheet, so they
added ~5000 px of phantom document height and quietly desynchronised scroll from
camera. `universeBackground.ts` snapshots `body.children` before building the scene
and fixes whatever appears.

**A phone is not a narrow desktop.** The volumetric clouds are marched per pixel and
are by far the heaviest thing here, so mobile gets two at reduced steps rather than
four. The ship's glide swing drops from 0.7 to 0.26 — portrait is barely half as wide
in angle, and a drift that reads as graceful on a desktop throws the ship out of
frame. The profile is chosen from `(pointer: coarse)`, not a user-agent string.

**The canvas is `100svh`.** On mobile `vh` means the *large* viewport, so `100vh`
gets cropped by the address bar.

## Where it stands

Measured with `tools/scan.mjs` in headless Chrome:

| | frame rate while scrolling |
|---|---|
| Desktop, 4 nebulae | ~22–30 fps |
| Mobile, 390×844, 2 nebulae | 44 fps |

Frame rate is the remaining limit on how smooth this feels, and the nebulae are the
measured cost — `?nonebula=1` is worth about 8 fps of the desktop figure. First load
is roughly 150 MB, nearly all of it upstream's planet textures, which have never been
trimmed. Both are open trades rather than solved problems.

The production build ships the background entry only. Upstream's game and playground
entry points pull in the whole title — menus, star map, tutorials, audio — none of
which this page uses, and all of which would otherwise be published alongside it.
That, dropping sourcemaps, and `prune-dist.mjs` took the deployment from 346 MB to
152 MB.
