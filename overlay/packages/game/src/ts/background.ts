//  Entry point: Cosmos Journeyer's universe as a live website background.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import "@styles/background.css";

import { Engine } from "@babylonjs/core/Engines/engine";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { LoadingProgressMonitor } from "@/frontend/assets/loadingProgressMonitor";

import { Settings } from "@/settings";

import { CameraDriver } from "./background/cameraDriver";
import { CorridorLayout, STOPS } from "./background/corridor";
import { CorridorFlight } from "./background/corridorFlight";
import { PointerInfluence } from "./background/pointerInfluence";
import { ShipModel } from "./background/shipModel";
import { detectProfile } from "./background/quality";
import { Nebula } from "./background/nebula";
import { SmoothScroll } from "./background/smoothScroll";
import { SpeedCue } from "./background/speedCue";
import { createUniverseBackground } from "./background/universeBackground";

/**
 * Flight heading, in degrees within the ecliptic plane.
 *
 * The Milky Way is a fixed cubemap on Cosmos Journeyer's star field box, so the
 * band sits in fixed world directions and "toward the nebula" is a heading
 * rather than a destination. Override with ?heading= to try others.
 */
const DEFAULT_HEADING = 0;

// The lens stays at the game's own 60 degrees. Narrowing it did pull the
// galactic band closer, but a cubemap gains no detail when magnified — it only
// goes soft, which is what made the sky stop looking like the game's.

/**
 * Pointer Lock shim, installed before anything else runs.
 *
 * Safari on iOS does not implement the Pointer Lock API at all — no
 * `document.exitPointerLock`, no `Element.requestPointerLock`. Cosmos Journeyer
 * calls exitPointerLock while it sets the player up, which on a phone throws a
 * TypeError in the middle of initialisation and leaves the page on its loading
 * screen forever with nothing in the console to explain it.
 *
 * Pointer lock is meaningless here in any case: this page never captures the
 * cursor, so the calls only need to not throw.
 */
(() => {
    // Written through an index signature: the DOM typings declare these as
    // required members with specific signatures, so assigning a no-op to them
    // through their real types does not compile.
    const doc = document as unknown as Record<string, unknown>;
    if (typeof doc["exitPointerLock"] !== "function") {
        doc["exitPointerLock"] = () => undefined;
    }
    if (!("pointerLockElement" in document)) {
        doc["pointerLockElement"] = null;
    }
    const proto = Element.prototype as unknown as Record<string, unknown>;
    if (typeof proto["requestPointerLock"] !== "function") {
        proto["requestPointerLock"] = () => undefined;
    }
})();

import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Layer } from "@babylonjs/core/Layers/layer";

import nebulaImage from "@assets/background/nebula-rosette.jpg";

const params = new URLSearchParams(window.location.search);

const canvas = document.getElementById("universe") as HTMLCanvasElement;
const loader = document.getElementById("loader") as HTMLDivElement;
const loaderBar = document.getElementById("loader-bar") as HTMLDivElement;
const whiteout = document.getElementById("whiteout") as HTMLDivElement;
const endcard = document.getElementById("endcard") as HTMLElement;

/**
 * Surfaces a failure instead of leaving the loader spinning forever.
 *
 * When this page fails on a device we cannot attach a debugger to, the only
 * symptom is "it stays on the loading screen" — which is indistinguishable
 * between a stalled download, an out-of-memory kill and a thrown exception.
 * Writing the reason onto the loader turns an unreportable hang into something
 * a screenshot can diagnose.
 */
const loaderNote = document.getElementById("loader-note") as HTMLElement | null;
let sceneReady = false;
let stage = "boot";

function reportStall(reason: string): void {
    if (sceneReady || loaderNote === null) return;
    const gl = (() => {
        try {
            return document.createElement("canvas").getContext("webgl2") !== null ? "webgl2" : "no webgl2";
        } catch {
            return "webgl blocked";
        }
    })();
    const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    loaderNote.textContent = `${reason}\nstopped at: ${stage} · ${gl} · ${window.innerWidth}×${window.innerHeight}${
        memory === undefined ? "" : ` · ${String(memory)}GB`
    }`;
    loaderNote.style.opacity = "1";
}

window.addEventListener("error", (event) => {
    reportStall(`Error: ${String(event.message).slice(0, 120)}`);
});
window.addEventListener("unhandledrejection", (event) => {
    reportStall(`Failed: ${String((event as PromiseRejectionEvent).reason).slice(0, 120)}`);
});
// If nothing has thrown and it still has not started, it is almost certainly
// weight or memory rather than a bug in the page.
window.setTimeout(() => {
    reportStall("Still loading — the scene has not started");
}, 30000);

const profile = detectProfile();

const headingParam = Number(params.get("heading"));
const heading = params.has("heading") && Number.isFinite(headingParam) ? headingParam : DEFAULT_HEADING;

// One description of the corridor, shared by the star system layout and the
// camera, so a body can never be placed somewhere the flight does not expect.
const layout = new CorridorLayout(heading, profile.approachFactor, profile.passScale);

// The game's own engine and canvas, option for option. Notably it never touches
// hardware scaling — it sizes the backing store to the CSS viewport and leaves
// it there — so matching it means dropping the device-ratio override this had.
const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    useHighPrecisionMatrix: true,
    doNotHandleContextLost: true,
});
engine.useReverseDepthBuffer = true;

/**
 * Ceiling on render scale.
 *
 * The canvas used to be sized in CSS pixels, which on a phone at device ratio 3
 * meant rendering 430x775 and stretching it across 1290x2325 — every rendered
 * pixel smeared over nine real ones. That is what makes the background look
 * soft, and it is what turns every hard diagonal, a planet's limb or the ship's
 * wing, into a staircase.
 *
 * Two is the sweet spot rather than three: the step from 1x to 2x removes
 * essentially all of the visible aliasing, while 3x costs more than twice again
 * for a difference nobody can see at arm's length.
 */
const RENDER_SCALE_CAP = (() => {
    const coarse =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches;
    // Measured on a phone: 1x is 60fps but visibly soft, 1.5x is still 60fps,
    // 2x drops to about 38. Almost all the visible aliasing goes between 1x and
    // 1.5x, so the last half-step is the one worth giving up — it costs a third
    // of the frame rate for a difference you have to look for.
    return coarse ? 1.5 : 2;
})();

const sizeCanvasLikeTheGame = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, RENDER_SCALE_CAP);
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
};
sizeCanvasLikeTheGame();

// An empty loop while assets load, so the engine's compute work can proceed
// before there is a scene to render. This is what their playground does too.
engine.runRenderLoop(() => {});

// Babylon sets `touch-action: none` on the body when it takes the canvas, which
// is right for a game that captures input and wrong for a page that is scrolled.
// On a phone it disables the browser's own vertical pan, so the flight stops
// responding to the finger. The canvas ignores pointer events here, so handing
// vertical panning back costs nothing.
document.body.style.touchAction = "pan-y";

const progressMonitor = new LoadingProgressMonitor();
progressMonitor.addProgressCallback((started, completed) => {
    const fraction = started === 0 ? 0 : completed / started;
    loaderBar.style.transform = `scaleX(${fraction})`;
    // No counter. The bar already shows how far along it is, and a pair of
    // numbers climbing to ninety-four reads as a machine reporting on itself
    // rather than as an invitation.
    void completed;
});

const { scene, starSystemView } = await createUniverseBackground(engine, progressMonitor, layout, (s) => {
    stage = s;
});

const controls = starSystemView.getDefaultControls();
const camera = controls.getActiveCamera();
camera.fov = Settings.FOV;
const flight = new CorridorFlight(scene, starSystemView.getStarSystem(), layout);
const pointer = new PointerInfluence();
const driver = new CameraDriver(flight, pointer, controls.getTransform());
const speedCue = new SpeedCue(scene, controls.getTransform(), profile.dustInstances);

const scroller = new SmoothScroll();

/**
 * Scrolling runs on its own animation frame, not inside the render loop.
 *
 * Driving it from the scene meant the page could only scroll as often as the
 * universe could be drawn — so on a heavy frame the wheel stopped responding,
 * and under load it stuttered. Scrolling a page must never wait on a renderer.
 */
let lastScrollTick = performance.now();
const scrollLoop = (now: number): void => {
    // Clamped: a long frame otherwise advances the easing in one huge step,
    // which is exactly what a lurch is.
    const dt = Math.min(0.05, Math.max(0.001, (now - lastScrollTick) / 1000));
    lastScrollTick = now;
    scroller.update(dt);
    requestAnimationFrame(scrollLoop);
};
requestAnimationFrame(scrollLoop);

/**
 * The Sun's glow, ramped with the flight.
 *
 * Distance alone could not tame it: a star's surface brightness does not fall
 * off, so it stays a blown-out disc however far away it is. Cosmos Journeyer's
 * volumetric scattering exposure is the knob that actually governs how much the
 * Sun floods the frame, and unlike lowering overall exposure it touches only the
 * star — the Milky Way keeps its brightness the whole way in.
 */
const SUN_GLOW_START = 0.004;
const SUN_GLOW_END = 0.26;

/** Below this much of the journey the Sun is a plain point of light: no glow, no flare. */
const SUN_RAMP_BEGINS = 0.55;

/** Ramp: nothing for the first stretch, then rising steeply as the Sun is closed on. */
const sunRamp = (p: number): number => {
    const t = Math.min(1, Math.max(0, (p - SUN_RAMP_BEGINS) / (1 - SUN_RAMP_BEGINS)));
    return t * t;
};

const volumetricLights = starSystemView.postProcessManager.volumetricLights;

/**
 * How far the sky turns across the whole flight, in radians.
 *
 * The Milky Way is a cubemap at infinity: flying toward it changes nothing,
 * because a background infinitely far away has no parallax to give. Turning it
 * does change what is on screen, and since the map already contains the bright
 * galactic core, the dust lanes and quiet dark regions, sweeping through it
 * shows genuinely different parts of the sky rather than inventing any. It is an
 * authored move, not parallax — parallax is not available at infinity.
 */
const SKY_YAW = (95 * Math.PI) / 180;
const SKY_PITCH = (22 * Math.PI) / 180;

const starSystemForSky = starSystemView.getStarSystem();

/**
 * The backdrop: a still image behind the whole scene.
 *
 * The game's own sky is a cube map wrapped around the camera, which is the right
 * shape for a starfield and the wrong one for a photograph of a single object —
 * a flat image on a sphere smears across the whole sky and pinches at the poles.
 * Drawn as a background layer instead, it fills the frame undistorted with every
 * moving thing in front of it.
 *
 * The cube map itself is only hidden, not removed: it is also the scene's
 * environment texture, and the ship's finish is made of what it reflects.
 */
starSystemForSky.starFieldBox.mesh.setEnabled(false);

/**
 * The backdrop: the image drawn into a texture the size of the viewport.
 *
 * A background layer stretches its texture to fill the frame, and reproducing
 * `contain` through its scale and offset went wrong three times — a stretched
 * column, an overflowing one, and a visible rectangle where the clamped edge
 * showed. Rather than keep guessing at those semantics, the image is composited
 * onto a canvas of exactly the viewport's shape and handed over whole. Then the
 * layer's default full-frame stretch is precisely right, because the texture is
 * already the right shape.
 */
/**
 * Texture size, at the viewport's aspect ratio.
 *
 * Clamping width and height independently is a trap: a 2880x1640 frame becomes a
 * 2048x1640 texture, which the layer then stretches back across the full width
 * and the whole backdrop is quietly squashed. Both axes are scaled by the same
 * factor so the shape is preserved and only the resolution is capped.
 */
const BACKDROP_MAX_EDGE = 2048;
const backdropSize = (): { width: number; height: number } => {
    const w = Math.max(1, engine.getRenderWidth());
    const h = Math.max(1, engine.getRenderHeight());
    const scale = Math.min(1, BACKDROP_MAX_EDGE / Math.max(w, h));
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
};

const backdropTexture = new DynamicTexture("backdrop", backdropSize(), scene, false);
backdropTexture.hasAlpha = false;

/**
 * How the image is fitted.
 *
 * Landscape frames contain it, so the whole nebula is visible. Portrait ones
 * cover instead: containing a 1.79 image inside a frame half as wide as it is
 * tall leaves the subject tiny and marooned in the middle. Filling the width and
 * cropping the sides puts the nebula close and large.
 *
 * This costs no sharpness. The source is 2752 across; a phone showing the middle
 * of it is asking roughly 850 source pixels to cover a 645-pixel-wide render, so
 * the texture is still being downsampled, not enlarged.
 */
const backdropImage = new Image();
const paintBackdrop = (): void => {
    if (!backdropImage.complete || backdropImage.naturalWidth === 0) return;
    const size = backdropTexture.getSize();
    const context = backdropTexture.getContext() as unknown as CanvasRenderingContext2D;
    context.fillStyle = "#000";
    context.fillRect(0, 0, size.width, size.height);

    const byWidth = size.width / backdropImage.naturalWidth;
    const byHeight = size.height / backdropImage.naturalHeight;
    const portrait = size.height > size.width;
    const fit = portrait ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight);

    const w = backdropImage.naturalWidth * fit;
    const h = backdropImage.naturalHeight * fit;
    context.drawImage(backdropImage, (size.width - w) / 2, (size.height - h) / 2, w, h);
    backdropTexture.update();
};
backdropImage.onload = paintBackdrop;
backdropImage.src = nebulaImage;

/** Rotating a phone changes the frame's shape, so the texture has to follow. */
const resizeBackdrop = (): void => {
    const next = backdropSize();
    const current = backdropTexture.getSize();
    if (next.width === current.width && next.height === current.height) return;
    backdropTexture.scaleTo(next.width, next.height);
    paintBackdrop();
};
window.addEventListener("resize", resizeBackdrop);
window.addEventListener("orientationchange", resizeBackdrop);

const backdrop = new Layer("backdrop", null, scene, true);
backdrop.texture = backdropTexture;
// Held back: at full strength it is the brightest thing on screen, and every
// planet — backlit, since the flight runs sunward — becomes a black dot punched
// out of it rather than a body with a lit limb.
backdrop.color = new Color4(0.5, 0.5, 0.54, 1);

/**
 * The companion, turned right down.
 *
 * Its lights are ordinary directional lights with no distance falloff, so
 * intensity is the only control — and full strength lit the planets flat from
 * the camera's side, which threw away the backlit look entirely. At a fraction
 * of that it stops being a key light and becomes what it should have been: just
 * enough to keep a dark limb from going to pure black.
 *
 * Registration order matches the model, so index 0 is the Sun.
 */
const COMPANION_INTENSITY = 0.11;
const stellarLights = starSystemForSky.stellarLightSystem.getLights();
for (let i = 1; i < stellarLights.length; i++) {
    const light = stellarLights[i];
    if (light !== undefined) light.intensity = COMPANION_INTENSITY;
}

/**
 * Two nebulae with real positions, unlike the sky.
 *
 * One far beyond the Sun that the whole flight closes on, and a nearer, smaller
 * one off the other side of the route that is met partway. Different colours and
 * different sizes so they read as two distinct objects rather than one effect
 * repeated — and because the near one is passed while the far one is still
 * growing, the two are rarely the same size on screen.
 *
 * Thin and bright rather than thick and dim: at close range a dense field
 * saturates every step alike and the colour washes to grey.
 */
const NEBULAE = [
    {
        // Far: an emission nebula, past the destination.
        //
        // Emission clouds are lit by hydrogen, which is why nearly every one
        // photographed in true colour comes out some shade of rose or brick
        // rather than the saturated greens and violets of the palette-mapped
        // versions. Deep rust in the thin parts, warming to pale cream where the
        // gas is dense enough to burn out toward white.
        ahead: 0.34,
        side: 0.15,
        rise: -0.08,
        radiusFactor: 0.13,
        colorA: new Color3(0.40, 0.20, 0.15),
        colorB: new Color3(0.93, 0.80, 0.63),
        density: 1.15,
        intensity: 1.55,
        seed: 5.1,
        steps: 11,
    },
    {
        // Near: a reflection nebula — dust scattering starlight rather than
        // emitting its own, which scatters blue for the same reason a sky does.
        // Steel blue deepening to pale ice, and no red in it at all, so the two
        // clouds separate by kind and not merely by hue.
        ahead: -0.3,
        side: -0.26,
        rise: 0.13,
        radiusFactor: 0.17,
        colorA: new Color3(0.31, 0.24, 0.24),
        colorB: new Color3(0.85, 0.79, 0.72),
        density: 1.25,
        intensity: 1.55,
        seed: 17.3,
        steps: 9,
    },
    {
        // Far out to port. A planetary nebula: doubly-ionised oxygen, which is
        // the one genuinely teal-green thing in the sky and so reads as clearly
        // another object rather than another shade of the same one.
        ahead: 0.24,
        side: -0.74,
        rise: 0.06,
        radiusFactor: 0.13,
        colorA: new Color3(0.42, 0.26, 0.12),
        colorB: new Color3(0.95, 0.82, 0.58),
        density: 1.6,
        intensity: 1.45,
        seed: 31.9,
        steps: 7,
    },
    {
        // Far out to starboard. Hydrogen over dust — the pink of the Trifid,
        // where emission and reflection overlap. Smaller and further again.
        ahead: 0.17,
        side: 0.70,
        rise: -0.11,
        radiusFactor: 0.10,
        colorA: new Color3(0.33, 0.22, 0.21),
        colorB: new Color3(0.89, 0.78, 0.68),
        density: 1.6,
        intensity: 1.45,
        seed: 44.2,
        steps: 7,
    },
] as const;

// An addition to the scene, not a precondition for it: if the model fails to
// load the flight still runs, it simply has nothing in the foreground.
const ship = await ShipModel.load(scene, controls.getTransform(), {
    apparentSize: profile.shipApparentSize,
    ahead: profile.shipAhead,
    below: profile.shipBelow,
    swing: profile.shipSwing,
});

// ?nonebula=1 builds the scene without the volumetric clouds, purely so their
// cost can be isolated from everything else.
const nebulae = (params.has("nonebula") ? [] : NEBULAE.slice(0, profile.nebulaLimit)).map((spec) => ({
    nebula: new Nebula(scene, {
        radius: spec.radiusFactor * layout.routeSpan(),
        colorA: spec.colorA,
        colorB: spec.colorB,
        density: spec.density,
        intensity: spec.intensity,
        seed: spec.seed,
        steps: Math.max(4, Math.round(spec.steps * profile.nebulaStepScale)),
    }),
    local: layout.offsetPoint(spec.ahead, spec.side, spec.rise),
    world: Vector3.Zero(),
}));

/**
 * The lens flare, ramped alongside the glow.
 *
 * Dimming the volumetric scattering alone still left a bright streak across the
 * frame from the first pixel, because the flare is a separate pass with its own
 * brightness. It has no public setting, but it is an ordinary post-process, so
 * overriding its `visibility` uniform after its own handler has run does the job.
 * The cost is that the flare no longer hides behind bodies that cross the Sun —
 * acceptable here, because the weave keeps the planets off the Sun's line.
 */
let flareVisibility = 0;
for (const flare of starSystemView.postProcessManager.lensFlares) {
    flare.onApplyObservable.add((effect) => {
        effect.setFloat("visibility", flareVisibility);
    });
}

// insertFirst puts the camera write ahead of Cosmos Journeyer's own frame
// callback, so its orbital update and post-processing — atmospheric scattering
// reads the camera position — see this frame's camera, not the last one's.
scene.onBeforeRenderObservable.add(
    () => {
        // Clamped for the same reason as the scroll loop: an unclamped delta
        // after a stalled frame moves the camera in one visible jump.
        const deltaSeconds = Math.min(0.05, Math.max(0.001, engine.getDeltaTime() / 1000));

        driver.setTargetProgress(scroller.getProgress());
        driver.update(deltaSeconds);

        const p = driver.getProgress();

        const ramp = sunRamp(p);
        const glow = SUN_GLOW_START + (SUN_GLOW_END - SUN_GLOW_START) * ramp;
        for (const volumetricLight of volumetricLights) {
            volumetricLight.exposure = glow;
        }
        flareVisibility = ramp;

        // Rebased on the star every frame, like everything else here — the
        // floating origin shifts the world out from under fixed coordinates.
        const sunNow = starSystemForSky.getStellarObjects()[0]?.getTransform().getAbsolutePosition();
        if (sunNow !== undefined) {
            const cameraNow = controls.getTransform().getAbsolutePosition();
            const plane = starSystemForSky.getReferencePlaneRotation();
            for (const entry of nebulae) {
                Vector3.TransformCoordinatesToRef(entry.local, plane, entry.world);
                entry.world.addInPlace(sunNow);
                entry.nebula.update(entry.world, cameraNow, deltaSeconds);
            }
        }

        const sweep = Matrix.RotationYawPitchRoll(SKY_YAW * p, SKY_PITCH * p * (1 - p) * 4, 0);
        starSystemForSky.starFieldBox.setRotationMatrix(
            sweep.multiply(starSystemForSky.getReferencePlaneRotation().transpose()),
        );
        ship?.update(layout, p, driver.getYawRate(), driver.getPitchRate(), deltaSeconds);
        speedCue.update(deltaSeconds, driver.getProgressRate(), driver.getYawRate(), driver.getPitchRate());
        // Driven from the camera's real distance to the Sun rather than from a
        // scroll number, so the screen is white exactly when the Sun has
        // actually swallowed the frame.
        const white = flight.whiteout(p);
        whiteout.style.opacity = String(white);
        // The card arrives only once the frame is genuinely white, and comes in
        // over the back half of that curve — otherwise it reads as text laid on
        // top of the Sun rather than as the page resolving into a footer.
        // Later than the white-out itself, so the frame reaches white, holds a
        // moment, and only then crossfades to the dark card.
        const card = Math.max(0, (white - 0.72) / 0.28);
        endcard.style.opacity = String(card);
        endcard.style.pointerEvents = card > 0.85 ? "auto" : "none";
    },
    undefined,
    true,
);

engine.stopRenderLoop();
engine.runRenderLoop(() => {
    starSystemView.render();
});

window.addEventListener("resize", () => {
    sizeCanvasLikeTheGame();
    engine.resize(true);
});

sceneReady = true;
loader.classList.add("done");
document.body.classList.add("ready");

// Exposed so the verification harness can read camera state without scraping pixels.
declare global {
    interface Window {
        __bg?: {
            progress: () => number;
            beat: () => string;
            cameraPosition: () => [number, number, number];
            cameraRotation: () => [number, number, number, number];
            fps: () => number;
            objects: () => string;
            heading: () => number;
            whiteout: () => number;
            throttle: () => number;
            glow: () => number;
            corridor: () => string;
            profile: () => string;
            shipProfile: () => string;
            shipOffset: () => number;
            cameraHeading: () => number;
            recordShip: (ms: number) => Promise<string>;
        };
    }
}
window.__bg = {
    progress: () => driver.getProgress(),
    beat: () => flight.currentLabel(driver.getProgress()),
    cameraPosition: () => {
        const p = controls.getTransform().getAbsolutePosition();
        return [p.x, p.y, p.z];
    },
    cameraRotation: () => {
        const q = controls.getTransform().absoluteRotationQuaternion;
        return [q.x, q.y, q.z, q.w];
    },
    fps: () => engine.getFps(),
    heading: () => heading,
    whiteout: () => flight.whiteout(driver.getProgress()),
    throttle: () => speedCue.getThrottle(),
    glow: () => volumetricLights[0]?.exposure ?? 0,
    // Samples what the ship is asked to do across the whole scroll, so its
    // motion can be checked for pendulum swings and jerk like the path was.
    // Where the ship actually sits across the frame right now, for verifying the glide.
    shipOffset: () => ship?.frameOffset() ?? 0,
    cameraHeading: () => layout.headingOffset(driver.getProgress()),
    // Samples the ship's position once per rendered frame. Sampling it from
    // outside over the debugging protocol gives uneven intervals, which makes
    // smooth motion look jerky and jerky motion look smooth — the numbers have
    // to come from the same clock the animation runs on.
    recordShip: (ms: number) =>
        new Promise<string>((resolve) => {
            const values: Array<number> = [];
            const headings: Array<number> = [];
            const times: Array<number> = [];
            const start = performance.now();
            const tick = (): void => {
                values.push(ship?.frameOffset() ?? 0);
                headings.push(layout.headingOffset(driver.getProgress()));
                times.push(performance.now() - start);
                if (performance.now() - start < ms) requestAnimationFrame(tick);
                else resolve(JSON.stringify({ values, times, headings }));
            };
            requestAnimationFrame(tick);
        }),
    shipProfile: () => {
        const N = 240;
        const slide: Array<number> = [];
        const bank: Array<number> = [];
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            slide.push(layout.weaveOffset(t));
            bank.push(layout.bank(t));
        }
        const diff = (a: Array<number>) => a.slice(1).map((v, i) => v - (a[i] ?? 0));
        const peak = (a: Array<number>) => Math.max(...a.map(Math.abs));
        const crossings = (a: Array<number>) => a.slice(1).filter((v, i) => v * (a[i] ?? 0) < 0).length;
        return JSON.stringify({
            slideRange: +(Math.max(...slide) - Math.min(...slide)).toFixed(3),
            slideCrossings: crossings(slide),
            maxSlideRate: +peak(diff(slide)).toFixed(4),
            maxSlideJerk: +peak(diff(diff(slide))).toFixed(5),
            flatFraction: +(slide.filter((v) => Math.abs(v) < 0.05).length / slide.length).toFixed(3),
            bankCrossings: crossings(bank),
        });
    },
    // Samples the path itself across the whole scroll, so smoothness can be
    // measured rather than judged by eye: heading turn-rate and bank, and the
    // frame-to-frame change in each, which is where a lurch would show up.
    profile: () => {
        const N = 240;
        const headings: Array<number> = [];
        const banks: Array<number> = [];
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const dir = layout.tangent(t);
            headings.push(Math.atan2(dir.z, dir.x));
            banks.push(layout.bank(t));
        }
        const diff = (a: Array<number>) => a.slice(1).map((v, i) => v - (a[i] ?? 0));
        const d1h = diff(headings);
        const d2h = diff(d1h);
        const d2b = diff(diff(banks));
        const peak = (a: Array<number>) => Math.max(...a.map(Math.abs));
        return JSON.stringify({
            headingSwingDeg: ((Math.max(...headings) - Math.min(...headings)) * 180) / Math.PI,
            maxTurnRateDegPerStep: (peak(d1h) * 180) / Math.PI,
            maxTurnJerkDegPerStep2: (peak(d2h) * 180) / Math.PI,
            bankRangeDeg: ((Math.max(...banks) - Math.min(...banks)) * 180) / Math.PI,
            maxBankJerkDegPerStep2: (peak(d2b) * 180) / Math.PI,
            bankSignChanges: banks.slice(1).filter((v, i) => v * (banks[i] ?? 0) < 0).length,
        });
    },
    // What the layout believes, so authored geometry can be compared against
    // where the bodies actually ended up.
    corridor: () => {
        const p = driver.getProgress();
        const f = layout.distanceAt(p);
        return JSON.stringify({
            f,
            startF: layout.startF,
            endF: layout.endF,
            stopF: layout.stopF,
            cameraWant: layout.point(f).asArray(),
            stops: STOPS.map((s, i) => ({
                id: s.objectId,
                want: layout.stopPosition(i).asArray(),
                semiMajorAxis: layout.stopPosition(i).length(),
            })),
        });
    },
    // Distances to every body, so framing problems can be diagnosed numerically
    // instead of by squinting at screenshots.
    objects: () => {
        const camera = controls.getTransform().getAbsolutePosition();
        return JSON.stringify(
            starSystemView
                .getStarSystem()
                .getOrbitalObjects()
                .map((o) => {
                    const p = o.getTransform().getAbsolutePosition();
                    return {
                        id: o.model.id,
                        type: o.model.type,
                        radius: o.getBoundingRadius(),
                        distance: p.subtract(camera).length(),
                        pos: [p.x, p.y, p.z],
                    };
                }),
        );
    },
};

if (params.has("debug")) {
    const hud = document.createElement("div");
    hud.id = "hud";
    document.body.appendChild(hud);
    setInterval(() => {
        const p = driver.getProgress();
        hud.textContent =
            `progress ${p.toFixed(3)}  fps ${engine.getFps().toFixed(0)}  heading ${heading}\n` +
            `${flight.currentLabel(p)}  white ${flight.whiteout(p).toFixed(2)}  throttle ${speedCue.getThrottle().toFixed(2)}\n` +
            `stops ${STOPS.length}  tier ${profile.tier}`;
    }, 200);
}
