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
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

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

/**
 * Gives up on the scene and hands back a working page.
 *
 * Reporting why it stalled was not enough: the loader stayed over the page for
 * ever, so a device that could not start the scene could not read the site
 * either — no copy, no navigation, and nothing to scroll. Whatever the reason,
 * the page underneath is an ordinary document with a photograph behind it, and
 * that is worth far more than a diagnostic on a black screen.
 *
 * Reversible: if the scene does arrive later, it takes over.
 */
let fellBack = false;
function enterFallback(reason: string): void {
    if (sceneReady || fellBack) return;
    fellBack = true;
    reportStall(reason);
    const note = document.getElementById("fallback-note");
    if (note !== null && loaderNote !== null) note.textContent = loaderNote.textContent;
    document.body.classList.add("no-scene", "ready");
}

window.addEventListener("error", (event) => {
    enterFallback(`Error: ${String(event.message).slice(0, 120)}`);
});
window.addEventListener("unhandledrejection", (event) => {
    enterFallback(`Failed: ${String((event as PromiseRejectionEvent).reason).slice(0, 120)}`);
});

// No WebGL2, no flight — and no reason to make anyone wait thirty seconds to be
// told so.
try {
    if (document.createElement("canvas").getContext("webgl2") === null) {
        enterFallback("This browser has no WebGL2");
    }
} catch {
    enterFallback("WebGL is blocked in this browser");
}

// If nothing has thrown and it still has not started, it is almost certainly
// weight or memory rather than a bug in the page.
window.setTimeout(() => {
    enterFallback("Still loading — the scene has not started");
}, 22000);

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

/** Touch, in practice: no hover, coarse pointer, and a battery to answer to. */
const COARSE_POINTER =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

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
 *
 * Phones were pinned below that, at 1.5x, on the strength of one phone measuring
 * about 38fps at 2x. That is one device standing in for all of them, and it is
 * standing in from the slow end. Every device now starts at 2x and the number is
 * settled by measurement instead — see `watchRenderQuality`.
 */
const SCALE_OVERRIDE = Number(new URLSearchParams(window.location.search).get("scale"));
let renderScaleCap = Number.isFinite(SCALE_OVERRIDE) && SCALE_OVERRIDE > 0 ? SCALE_OVERRIDE : 2;

const applyRenderScale = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, renderScaleCap);
    // Babylon's own scaling rather than writing canvas.width directly. resize()
    // recomputes the backing store from the CSS box and the hardware scaling
    // level, so a manually sized canvas is silently reset the first time the
    // engine resizes — which on a phone is every time the address bar slides
    // away. Written this way the scale survives.
    engine.setHardwareScalingLevel(1 / ratio);
    engine.resize(true);
};
applyRenderScale();

/**
 * The render scale, settled on the device rather than guessed at.
 *
 * Sampling starts only once the loader has handed over, because the frames spent
 * building the scene are not the frames the reader will see. If the device holds
 * a smooth rate across the sample it keeps 2x; if it does not, it drops to 1.5x
 * once and stays there. A phone that can afford the resolution keeps it, and one
 * that cannot keeps its frame rate.
 */
const QUALITY_SAMPLE_SECONDS = 2.5;
/** Above this the device is holding 60 and needs nothing done to it. */
const FULL_RATE_FPS = 55;
/** Below this it cannot hold even a steady half rate, and has to give up pixels. */
const HALF_RATE_FPS = 27;
const QUALITY_LADDER = [1.5, 1.25];
let halfRate = false;
let qualitySettled = false;
let qualitySampleStart = 0;
let qualitySampleFrames = 0;
const watchRenderQuality = (): void => {
    if (qualitySettled || introStart === 0) return;
    const now = performance.now();
    if (qualitySampleStart === 0) {
        qualitySampleStart = now;
        return;
    }
    qualitySampleFrames += 1;
    const elapsed = (now - qualitySampleStart) / 1000;
    if (elapsed < QUALITY_SAMPLE_SECONDS) return;

    const rate = qualitySampleFrames / elapsed;
    qualitySampleStart = 0;
    qualitySampleFrames = 0;
    if (SCALE_OVERRIDE > 0) {
        qualitySettled = true;
        return;
    }

    // Cadence before resolution. A device that holds the full rate keeps
    // everything; one that cannot is given a steady half rate rather than a
    // resolution cut, because the irregularity is what is being seen, not the
    // sharpness. Only if it cannot hold even that does it start paying in
    // pixels.
    if (!halfRate) {
        if (rate >= FULL_RATE_FPS) {
            qualitySettled = true;
            return;
        }
        halfRate = true;
        return;
    }
    if (rate >= HALF_RATE_FPS) {
        qualitySettled = true;
        return;
    }
    const next = QUALITY_LADDER.find((step) => step < renderScaleCap);
    if (next === undefined) {
        qualitySettled = true;
        return;
    }
    renderScaleCap = next;
    applyRenderScale();
    resizeBackdrop();
};

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
speedCue.setRenderingGroup(1);

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
    context.filter = "none";
    context.fillStyle = "#000";
    context.fillRect(0, 0, size.width, size.height);
    // Pulled back at paint time rather than per frame. The layer's colour is a
    // multiply, which darkens without touching saturation — and it was the
    // saturation that was loud: a photograph of a nebula is the most saturated
    // thing anyone will put behind a page, and next to it every lit planet limb
    // reads as grey.
    context.filter = "saturate(0.6)";

    const byWidth = size.width / backdropImage.naturalWidth;
    const byHeight = size.height / backdropImage.naturalHeight;
    const portrait = size.height > size.width;
    // Portrait sits exactly at cover: no further in, and no black bars either.
    // Going under cover would pull the image away from the frame edges, and with
    // a starfield across the whole image those gaps read as bars rather than as
    // space.
    const fit = portrait ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight);

    const w = backdropImage.naturalWidth * fit;
    const h = backdropImage.naturalHeight * fit;
    context.drawImage(backdropImage, (size.width - w) / 2, (size.height - h) / 2, w, h);
    context.filter = "none";
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



/*  The backdrop is a plane on the camera, not a Layer.

    A Layer cannot pan or zoom its image. Babylon's layer shader computes both
    the vertex position and the UV from the same scaled-and-offset coordinate,
    so `scale` and `offset` move the quad and its texture together: all they
    change is which part of the screen the quad covers, never what is drawn
    where. Proved rather than assumed — shifting the offset by a quarter of the
    screen produced a frame indistinguishable from not shifting it at all.

    A plane parented to the camera fills the frame the same way, and its texture
    has a real UV transform, so the photograph can be moved for free in the
    shader instead of being repainted and re-uploaded every frame. */
const BACKDROP_DISTANCE = 12;
const backdropPlane = CreatePlane("backdrop", { width: 1, height: 1 }, scene);
// The rig, not the camera. A Babylon Camera does not propagate its transform to
// children, so a mesh parented to one is left at the world origin — which, under
// a floating origin, is nowhere near the flight. The ship hangs off the same
// TransformNode for the same reason.
backdropPlane.parent = controls.getTransform();
// Forward is -Z on this rig, the way the ship's carrier is placed.
backdropPlane.position.set(0, 0, -BACKDROP_DISTANCE);
backdropPlane.isPickable = false;
backdropPlane.alwaysSelectAsActiveMesh = true;
backdropPlane.infiniteDistance = false;
backdropPlane.renderingGroupId = 0;

const backdropMaterial = new StandardMaterial("backdrop", scene);
backdropMaterial.diffuseColor = Color3.Black();
backdropMaterial.specularColor = Color3.Black();
backdropMaterial.emissiveTexture = backdropTexture;
backdropMaterial.disableLighting = true;
backdropMaterial.disableDepthWrite = true;
backdropMaterial.backFaceCulling = false;
backdropMaterial.fogEnabled = false;
backdropPlane.material = backdropMaterial;

// Held back through the texture's own level rather than a colour: Babylon adds
// emissiveColor to emissiveTexture, so a grey there lays flat grey over the
// whole frame instead of dimming the photograph. At full strength it is the
// brightest thing on screen and every planet — backlit, since the flight runs
// sunward — becomes a black dot punched out of it rather than a lit limb.
backdropTexture.level = 0.5;
backdropTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
backdropTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

/** Sized to exactly fill the frustum at its distance, so the frame is covered. */
const fitBackdropPlane = (): void => {
    const height = 2 * BACKDROP_DISTANCE * Math.tan(camera.fov / 2);
    backdropPlane.scaling.set(height * engine.getAspectRatio(camera), height, 1);
};
fitBackdropPlane();
window.addEventListener("resize", fitBackdropPlane);

/**
 * How the backdrop moves.
 *
 * It was welded to the screen: a full-frame layer whose only motion was a slow
 * scale with scroll. So when the camera turned, the star field turned and the
 * photograph did not — which is exactly what makes a backdrop read as painted on
 * the inside of the screen rather than as somewhere the ship is flying.
 *
 * Three things move it now. The flight closes it in with progress, as before.
 * The view's own rotation slides it, which is what a thing at infinity does when
 * you turn your head — that is the cue that was missing. And a very slow drift
 * keeps it alive when the reader is not scrolling at all, because the ship never
 * stops flying even when the page is still.
 *
 * Sliding it means the edges have to be off-screen to begin with, which is what
 * the base zoom is for: enough to cover the largest shift, and no more.
 */
const BACKDROP_APPROACH = COARSE_POINTER ? 0.20 : 0.14;

/**
 * Enough zoom that the photograph can be moved without showing its edges.
 *
 * This is the cost of the whole thing: everything below shifts the image inside
 * the frame, and whatever it shifts by has to already be outside. The base is
 * set to just cover the largest combined shift and no more.
 */
const BACKDROP_BASE_ZOOM = COARSE_POINTER ? 1.32 : 1.30;

/**
 * Fraction of the true angular shift, for the part that follows the view.
 *
 * The physical answer is one — a thing at infinity slides exactly with your
 * head. But the camera only swings about seven degrees across the whole flight,
 * so the physical answer is also nearly no movement at all, and it is not what
 * anyone watching is asking for. Half, plus a drift that owes nothing to the
 * flight, is what reads as a nebula the ship is travelling past.
 */
const PARALLAX_GAIN = 0.4;

/**
 * The drift.
 *
 * Measured before this: the old drift moved the image about one pixel a second,
 * which is not movement, it is a rounding error. These amplitudes and periods
 * put it around ten pixels a second at its quickest — slow enough to never pull
 * the eye off the copy, fast enough that a few seconds of looking is enough to
 * see it. The two axes and the breath run at periods that do not divide into one
 * another, so the path never visibly repeats.
 */
const DRIFT_X = 0.078;
const DRIFT_Y = 0.058;
const DRIFT_X_RATE = 0.15;
const DRIFT_Y_RATE = 0.19;
const BREATHE = 0.035;
const BREATHE_RATE = 0.1;

let parallaxYaw = 0;
let parallaxPitch = 0;
let backdropClock = 0;
/** Keeps the sampled window inside the image, so an edge can never come into frame. */
const clampPan = (value: number, margin: number): number =>
    Math.max(-margin, Math.min(margin, value));
/** Debug only: a constant added to the offset so a nudge survives the next frame. */
let debugOffsetX = 0;
let debugOffsetY = 0;

const driveBackdrop = (
    progress: number,
    deltaSeconds: number,
    yawRate: number,
    pitchRate: number,
): void => {
    backdropClock += deltaSeconds;
    parallaxYaw += yawRate * deltaSeconds;
    parallaxPitch += pitchRate * deltaSeconds;

    const breathe = BREATHE * Math.sin(backdropClock * BREATHE_RATE);
    const zoom = BACKDROP_BASE_ZOOM + BACKDROP_APPROACH * progress + breathe;

    // Horizontal field, not vertical: the layer's offset is in screen widths.
    const fovH = 2 * Math.atan(Math.tan(camera.fov / 2) * engine.getAspectRatio(camera));
    const slideX = (-parallaxYaw / fovH) * PARALLAX_GAIN;
    const slideY = (parallaxPitch / camera.fov) * PARALLAX_GAIN;
    const driftX = DRIFT_X * Math.sin(backdropClock * DRIFT_X_RATE);
    const driftY = DRIFT_Y * Math.sin(backdropClock * DRIFT_Y_RATE);

    // Zooming in means sampling a smaller window of the image, so the scale is
    // the reciprocal; the offset then re-centres that window and the pans move
    // it. Clamped addressing means the window must stay inside the image, which
    // is what bounds the drift.
    const window_ = 1 / zoom;
    const margin = (1 - window_) / 2;
    backdropTexture.uScale = window_;
    backdropTexture.vScale = window_;
    backdropTexture.uOffset = margin + clampPan(slideX + driftX + debugOffsetX, margin);
    backdropTexture.vOffset = margin + clampPan(slideY + driftY + debugOffsetY, margin);
};
driveBackdrop(0, 0, 0, 0);

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
/**
 * Copy fades and rises into place, and back out again.
 *
 * Driven from flight progress rather than from an intersection observer: the
 * camera is already eased away from the raw scroll position, and text keyed to
 * the scrollbar arrives before the world it describes. Sharing one clock keeps
 * them together.
 *
 * The secondary block trails the headline slightly. A uniform fade reads as a
 * slide changing; a stagger reads as something being said.
 */
const panels = Array.from(document.querySelectorAll<HTMLElement>(".panel"));
if (COARSE_POINTER) document.body.classList.add("reveal-timed");
/**
 * Vertical travel, in pixels.
 *
 * Measured off the live reference: it moves eight pixels, not the twenty a first
 * guess reaches for. At this size the movement is barely perceptible as movement
 * — it reads as the text settling rather than sliding.
 */
const RISE_PX = 8;
const STAGGER = 0.07;

const smoothstep = (x: number): number => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
};

/**
 * When the loader hands the page over, on the performance clock.
 *
 * The first panel is the one that cannot be keyed to scroll. At rest the scroll
 * position is zero, and a scroll-keyed reveal at zero is an empty screen — which
 * is why the hero copy used to appear only once the reader started moving. On
 * the reference the hero is already there when the page settles, so it plays
 * once, on arrival, and only its exit is keyed to the flight.
 */
let introStart = 0;

/** In over the first quarter of a panel, out over its last fifth. */
const revealAt = (local: number, delay: number): number => {
    const shifted = local - delay;
    return smoothstep(shifted / 0.25) * (1 - smoothstep((shifted - 0.8) / 0.2));
};

/*  Touch reveals by state, not by scrub.

    Measured on the reference with the page held perfectly still: its copy keeps
    moving — 1.000, 0.881, 0.450, 0.036, 0 over about half a second, transform
    sliding 0 to -8 the whole way. That is a transition on its own clock, not a
    value read off the scroll position.

    On a desktop the difference does not show, because the wheel is eased into a
    glide and the scrubbed value inherits that easing. Under a finger there is no
    glide: a scrubbed reveal tracks the finger exactly, so dragging slowly scrubs
    the text in and out like a slider instead of playing an animation. Touch gets
    a state and lets CSS time it; the pointer keeps the scrub.  */
const REVEAL_IN_AT = 0.08;
const REVEAL_OUT_AT = 0.85;

const applyReveal = (progress: number): void => {
    const span = 1 / Math.max(1, panels.length);
    const introT = introStart === 0 ? 0 : (performance.now() - introStart) / 1000;

    panels.forEach((panel, index) => {
        const local = (progress - index * span) / span;
        const isHero = index === 0;

        // Every panel is written every frame, including the ones far off screen.
        // Skipping them to save work was the bug: a panel outside the window kept
        // whatever style it last had — or, before its first frame, none at all —
        // so it scrolled up into view at full opacity and only then snapped to
        // zero and played its entrance.
        for (const node of Array.from(panel.children[0]?.children ?? [])) {
            const element = node as HTMLElement;
            const isHeadline = element.classList.contains("headline");

            if (COARSE_POINTER) {
                // The hero is the one panel with no scroll behind it: it is in as
                // soon as the loader lets go, and only its exit follows the flight.
                const state = isHero
                    ? introStart === 0
                        ? "before"
                        : local > REVEAL_OUT_AT
                          ? "after"
                          : "in"
                    : local < REVEAL_IN_AT
                      ? "before"
                      : local > REVEAL_OUT_AT
                        ? "after"
                        : "in";
                // Only touched when it actually changes: rewriting classList on
                // every element every frame is work the compositor has to answer.
                if (element.dataset["reveal"] !== state) {
                    element.dataset["reveal"] = state;
                }
                continue;
            }

            const delay = isHeadline ? 0 : STAGGER;
            const shifted = Math.min(1, Math.max(0, local - delay));

            let value: number;
            let offset: number;

            if (isHero) {
                const arrived = smoothstep((introT - (isHeadline ? 0 : 0.18)) / 0.65);
                const leaving = 1 - smoothstep((local - delay - 0.8) / 0.2);
                value = arrived * leaving;
                // Settles from +8 to 0 on arrival, then carries on to -8 as the
                // flight leaves it behind: one continuous travel, not two.
                offset = RISE_PX * (1 - arrived) - RISE_PX * shifted;
            } else {
                value = revealAt(local, delay);
                // Drift, not a bounce. On the reference the offset runs from +8
                // through 0 to -8 across a block's life, so it keeps moving the
                // same way the whole time; tying the offset to opacity instead
                // makes it rise in and then sink back out the way it came, which
                // reads as an effect rather than as motion.
                offset = RISE_PX * (1 - 2 * shifted);
            }

            element.style.opacity = value.toFixed(3);
            element.style.transform = `translateY(${offset.toFixed(2)}px)`;
        }
    });
};applyReveal(0);

/*  Cost control, measured rather than assumed.
 *
 *  The camera carries fourteen full-screen post-process passes, and five of them
 *  are per-planet uber-shaders — Mars, Earth, Neptune, Saturn, Jupiter — each
 *  raymarching atmosphere, ocean, cloud and ring over the whole frame every
 *  frame, whether that planet fills the shot or is four pixels across on the far
 *  side of the corridor. Measured: 24fps with all of them, 37fps with four of
 *  them detached, and the chain stays as it is left.
 *
 *  The flight passes one body at a time, so a body's pass is attached only while
 *  it is the one in play — from the moment the previous body is behind us until
 *  a little after this one is. Detaching and reattaching the whole chain in its
 *  original order is what keeps the passes composing in the order their author
 *  intended.
 */
type CameraPass = { name: string };
type PassHost = {
    _postProcesses: Array<CameraPass | null>;
    attachPostProcess: (pass: CameraPass, at?: number) => number;
    detachPostProcess: (pass: CameraPass) => void;
};
const passHost = camera as unknown as PassHost;

/*  Captured on the first frame the passes actually exist.
 *
 *  Reading the chain when this module runs finds it empty: the per-body passes
 *  are built with the bodies, which happens later. Capturing once, as soon as at
 *  least one body pass is present, is also what stops a later recapture from
 *  seeing a chain this code has already thinned and forgetting the rest. */
let fullChain: Array<CameraPass> = [];
const bodyPasses = new Map<CameraPass, number>();
let captured = false;

const isBodyPass = (pass: CameraPass): number | undefined => {
    const name = pass.name.toLowerCase();
    const index = STOPS.findIndex((stop) => name.startsWith(stop.objectId.toLowerCase()));
    return index === -1 ? undefined : index;
};

const captureChain = (): void => {
    if (captured) return;
    const current = (passHost._postProcesses ?? []).filter(
        (pass): pass is CameraPass => pass !== null && pass !== undefined,
    );
    if (!current.some((pass) => isBodyPass(pass) !== undefined)) return;
    fullChain = current;
    for (const pass of fullChain) {
        const index = isBodyPass(pass);
        if (index !== undefined) bodyPasses.set(pass, index);
    }
    captured = true;
};

/** Kept on from just before the previous body is passed until just after this one. */
const PASS_LEAD = 0.03;
const PASS_TRAIL = 0.05;
const wantsPass = (index: number, progress: number): boolean => {
    const start = index === 0 ? -1 : layout.stopProgress(index - 1) - PASS_LEAD;
    return progress >= start && progress <= layout.stopProgress(index) + PASS_TRAIL;
};

let attachedSignature = "";
const CULL_DISABLED = new URLSearchParams(window.location.search).has("nocull");
const syncBodyPasses = (progress: number): void => {
    if (CULL_DISABLED) return;
    captureChain();
    if (bodyPasses.size === 0) return;

    // Compared against what is actually attached, not against what was attached
    // last time this ran. Cosmos Journeyer reattaches a body's pass itself when
    // that body comes into range, so remembering our own last decision quietly
    // stops being true and the chain creeps back to full.
    const attached = passHost._postProcesses ?? [];
    let want = "";
    let have = "";
    for (const [pass, index] of bodyPasses) {
        want += wantsPass(index, progress) ? "1" : "0";
        have += attached.includes(pass) ? "1" : "0";
    }
    attachedSignature = want;
    if (want === have) return;

    for (const pass of fullChain) passHost.detachPostProcess(pass);
    for (const pass of fullChain) {
        const index = bodyPasses.get(pass);
        if (index !== undefined && !wantsPass(index, progress)) continue;
        passHost.attachPostProcess(pass);
    }
};

/*  Neither of these is visible on this page and both were measured costing real
    frames: shadow maps are fixed-resolution targets rendered every frame for a
    scene lit by a star a hundred million kilometres away, and the animation
    system is stepping groups nothing here reads.  */
scene.shadowsEnabled = false;
scene.animationsEnabled = false;

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

        syncBodyPasses(p);
        watchRenderQuality();
        driveBackdrop(p, deltaSeconds, driver.getYawRate(), driver.getPitchRate());
        applyReveal(p);

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
/*  Frame pacing.
 *
 *  Measured on a steady scroll: median frame 17ms, 95th percentile 39ms. The
 *  scene sits right on the 60Hz budget, so frames alternate between one and two
 *  vsync intervals — and a rate swinging between 60 and 30 looks markedly worse
 *  than a rate that simply stays at 30, because the eye reads the irregularity
 *  rather than the average. A page with no scene in the same browser holds
 *  16.7ms with a standard deviation of 0.6, so this is the scene, not the
 *  measuring harness.
 *
 *  When the device cannot hold the full rate, render every second frame and give
 *  it a steady cadence instead of an erratic one. */
let frameParity = 0;
engine.runRenderLoop(() => {
    if (halfRate) {
        frameParity ^= 1;
        if (frameParity === 1) return;
    }
    starSystemView.render();
});

window.addEventListener("resize", () => {
    applyRenderScale();
});

sceneReady = true;
// If the page had already given up and shown the static version, the scene
// arriving late takes over.
document.body.classList.remove("no-scene");
loader.classList.add("done");
document.body.classList.add("ready");
introStart = performance.now();

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
            backdrop: () => string;
            nudgeBackdrop: (x: number, y: number) => string;
            bgTest: (mode: string) => string;
            perfTest: (mode: string) => string;
            recordShip: (ms: number) => Promise<string>;
    recordCamera: (ms: number) => Promise<string>;
            pacing: () => string;
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
    backdrop: () =>
        `${backdropTexture.uOffset.toFixed(4)} ${backdropTexture.vOffset.toFixed(4)} ${backdropTexture.uScale.toFixed(4)}`,
    perfTest: (mode: string) => {
        if (mode === "cullstate") return `captured=${captured} bodyPasses=${bodyPasses.size} chain=${fullChain.length} sig=${attachedSignature}`;
        if (mode === "noshadows") scene.shadowsEnabled = false;
        if (mode === "shadows") scene.shadowsEnabled = true;
        if (mode === "noanim") scene.animationsEnabled = false;
        if (mode === "anim") scene.animationsEnabled = true;
        if (mode === "nopost") scene.postProcessesEnabled = false;
        if (mode === "nolens") scene.lensFlaresEnabled = false;
        if (mode === "noparticles") scene.particlesEnabled = false;
        if (mode.startsWith("ship:")) {
            const what = mode.slice(5);
            const mats = scene.materials.filter((m) => m.getClassName() === "PBRMaterial" && m.name === "material");
            for (const m of mats) {
                const any = m as unknown as Record<string, unknown>;
                if (what === "red") (any["albedoColor"] as { set: (r: number, g: number, b: number) => void }).set(1, 0, 0);
                if (what === "nocoat") (any["clearCoat"] as { isEnabled: boolean }).isEnabled = false;
                if (what === "emis") (any["emissiveColor"] as { set: (r: number, g: number, b: number) => void }).set(0.45, 0.46, 0.5);
                if (what === "notex") { any["albedoTexture"] = null; any["metallicTexture"] = null; any["bumpTexture"] = null; }
            }
            const m0 = mats[0] as unknown as Record<string, unknown> | undefined;
            return `${mats.length} mats; albedoTex=${m0 && m0["albedoTexture"] ? "yes" : "no"} metalTex=${m0 && m0["metallicTexture"] ? "yes" : "no"} emis=${String(m0 && (m0["emissiveColor"] as {r:number}|undefined)?.r)}`;
        }
        if (mode === "ship") {
            return scene.materials
                .map((m) => {
                    const any = m as unknown as Record<string, unknown>;
                    const col = (any["albedoColor"] ?? any["baseColor"] ?? any["diffuseColor"]) as
                        | { r: number; g: number; b: number }
                        | undefined;
                    return `${m.name}[${m.getClassName()}] col=${col ? col.r.toFixed(2) + "," + col.g.toFixed(2) + "," + col.b.toFixed(2) : "-"} metal=${String(any["metallic"] ?? any["baseMetalness"] ?? "-")} rough=${String(any["roughness"] ?? any["baseRoughness"] ?? "-")} env=${String(any["environmentIntensity"] ?? "-")}`;
                })
                .join(" | ");
        }
        if (mode === "cull") {
            const cam = scene.activeCamera;
            const all = [...((cam?._postProcesses ?? []).filter(Boolean))];
            const drop = all.filter((q) => /UberShaderPass/.test(q.name)).slice(0, 4);
            for (const q of drop) cam?.detachPostProcess(q);
            return `detached ${drop.length}: ${drop.map((q) => q.name).join(", ")}`;
        }
        if (mode === "list") {
            const cam = scene.activeCamera;
            const own = (cam?._postProcesses ?? []).filter(Boolean);
            return `camera passes (${own.length}): ` + own.map((q) => `${q.name}@${q.width}x${q.height}`).join(", ");
        }
        const gens = scene.lights.reduce((n, l) => n + (l.getShadowGenerator() ? 1 : 0), 0);
        return `shadows=${scene.shadowsEnabled} gens=${gens} lights=${scene.lights.length} meshes=${scene.meshes.length} post=${scene.postProcessesEnabled}`;
    },
    bgTest: (mode: string) => {
        if (mode === "off") backdropPlane.setEnabled(false);
        if (mode === "on") backdropPlane.setEnabled(true);
        return `enabled=${backdropPlane.isEnabled()}`;
    },
    nudgeBackdrop: (x: number, y: number) => {
        debugOffsetX += x;
        debugOffsetY += y;
        return `${debugOffsetX.toFixed(4)} ${debugOffsetY.toFixed(4)}`;
    },
    // Samples the ship's position once per rendered frame. Sampling it from
    // outside over the debugging protocol gives uneven intervals, which makes
    // smooth motion look jerky and jerky motion look smooth — the numbers have
    // to come from the same clock the animation runs on.
            /*  Sampled from inside the render loop, one row per rendered frame. Sampling
        the camera from outside over the debugging protocol gives uneven
        intervals, which makes smooth motion look jerky and jerky motion look
        smooth — the numbers have to come from the clock the animation runs on. */
            pacing: () =>
        `halfRate=${halfRate} scale=${renderScaleCap} settled=${qualitySettled} dpr=${window.devicePixelRatio}`,
    recordCamera: (ms: number) =>
        new Promise<string>((resolve) => {
            const rows: Array<string> = [];
            const start = performance.now();
            const tick = (): void => {
                const now = performance.now() - start;
                const transform = controls.getTransform();
                const position = transform.getAbsolutePosition();
                const forward = transform.forward;
                rows.push(
                    [
                        now.toFixed(2),
                        driver.getProgress().toFixed(8),
                        position.x.toFixed(3),
                        position.y.toFixed(3),
                        position.z.toFixed(3),
                        forward.x.toFixed(6),
                        forward.y.toFixed(6),
                        forward.z.toFixed(6),
                    ].join(","),
                );
                if (performance.now() - start >= ms) {
                    scene.onAfterRenderObservable.removeCallback(tick);
                    resolve(rows.join(";"));
                }
            };
            scene.onAfterRenderObservable.add(tick);
        }),
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


/*  Phone navigation.

    On a phone the bar carries a mark and one action, so the section links move
    into a sheet behind a button rather than being dropped. The links are the
    same anchors as the desktop bar; nothing here knows about the flight, it
    only opens and closes.  */
const navToggle = document.getElementById("navtoggle");
const closeNav = (): void => {
    document.body.classList.remove("nav-open");
    navToggle?.setAttribute("aria-expanded", "false");
};
navToggle?.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
});
for (const link of Array.from(document.querySelectorAll<HTMLElement>("#navsheet a"))) {
    link.addEventListener("click", closeNav);
}
document.getElementById("navsheet-scrim")?.addEventListener("click", closeNav);

/*  The newsletter field has nothing behind it yet. Left as a plain form it would
    navigate away from the page on submit, which is a worse answer than saying
    nothing happened.  */
const newsletter = document.getElementById("endcard-form") as HTMLFormElement | null;
newsletter?.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = newsletter.querySelector("button");
    if (button !== null) button.textContent = "Thanks";
});
