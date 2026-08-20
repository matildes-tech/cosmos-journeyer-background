//  The ship the flight is flown from.
//
//  Model: "Aircraft Decor" by jimbogies, CC-BY-4.0.
//  https://sketchfab.com/3d-models/aircraft-decor-7e3aa0fa94ea43cb90b8c7984e724cf2
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import "@babylonjs/loaders/glTF";

import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { type AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { type Scene } from "@babylonjs/core/scene";

import { lerpSmooth } from "@/utils/math";

import { type CorridorLayout } from "./corridor";

const MODEL_URL = new URL("../../asset/background/ship.glb", import.meta.url).href;

/**
 * How far ahead of the camera the ship sits, in scene units.
 *
 * This governs perspective, not size: the scale below is derived from it, so the
 * ship subtends the same angle whatever this is. Closer means a wider, more
 * foreshortened read on the hull — the sense of sitting right behind it.
 */
let AHEAD = 8.5;

/** Offsets as fractions of the forward distance: a little below and to one side. */
/**
 * Sits low in the frame.
 *
 * At this size the hull spans a good part of the view, so a modest sideways
 * slide can no longer clear a body that passes near the centre — it has to be
 * out of their lane altogether. Low and wide keeps the planets in the upper two
 * thirds and the ship in the lower one, and they stop sharing space.
 */
let BELOW = 0.4;

/**
 * How far the ship slides across the frame, as a fraction of its distance.
 *
 * Driven by which side the oncoming body is on, and set against it: the ship
 * moves to port as a planet comes up to starboard, so the two never occupy the
 * same part of the frame and it reads as flying past rather than through. The
 * swing doubles as the lateral movement — one offset serves both.
 */
let ASIDE_SWING = 0.7;

/** Seconds for that slide to close half its distance. Slow, so it is a drift and not a dodge. */
const ASIDE_HALF_LIFE = 0.55;

/**
 * How strongly the ship answers the flight's heading.
 *
 * The glide is driven by how fast the camera is turning, not by where the route
 * or the planets are. That is what makes it look attached to the camera: pan
 * left and the ship falls back to the right of frame, exactly as a vehicle you
 * are following does, then settles back to centre when the turn stops.
 *
 * It also keeps the ship clear of the planets without being told to. The camera
 * turns *toward* whatever it is passing, so the ship always slides the other way.
 */
const TURN_RESPONSE = 1.45;

/** Seconds of low-pass on the camera's measured turn rate before the ship reacts to it. */
const TURN_SMOOTHING = 0.05;

/**
 * A slow wander laid over the camera response.
 *
 * Off. It was added when the glide was saturating — pinned fully left or fully
 * right — and needed something to give it variety. With the response now
 * proportional the camera supplies all the variation there is, and an
 * independent oscillation on top only made the ship wander on its own schedule
 * instead of moving with the shot.
 */
const WANDER_A = 0.0;
const WANDER_B = 0.0;
const WANDER_RATE_A = 0.163;
const WANDER_RATE_B = 0.1013;

/**
 * Glide, as a critically damped spring rather than an exponential ease.
 *
 * Exponential smoothing is fastest at the instant it starts and only ever slows
 * down — it has no ease-in at all, which is why the movement read as a drift
 * being tugged rather than a ship flying. A spring accelerates into the move and
 * decelerates out of it, and critically damped it does so without overshooting.
 */
const GLIDE_FREQUENCY = 0.95;

/**
 * Fixed integration step for the spring, in seconds.
 *
 * Frame times here swing between about 16ms and 50ms, and an explicit
 * integrator fed a varying step produces a varying response — the spring
 * effectively changes stiffness frame to frame, which shows up as judder even
 * though the target is perfectly smooth. Advancing it in constant slices, as
 * many as the frame needs, makes the motion identical regardless of how long
 * the frame took.
 */
const GLIDE_STEP = 1 / 120;

/** Longest dimension as a fraction of its distance — this is what sets on-screen size. */
let APPARENT_SIZE = 0.86;

/** The ship rolls harder than the camera does, so it reads as the thing doing the flying. */
const BANK_GAIN = 2.5;

/** Seconds for the ship's roll to close half the gap to the path's — it leads, the camera follows. */
const BANK_HALF_LIFE = 0.22;

/**
 * A lacquer over the metal.
 *
 * Shine and reflection are the same thing on a bare metal, so asking for one
 * without the other has only one answer: put a second, very smooth layer on top
 * that has its own highlights. A clear coat gives a tight bright hotspot from
 * the ship's own lights — read as polish — while the metal underneath keeps
 * showing almost nothing of the sky.
 */
const CLEAR_COAT_ROUGHNESS = 0.018;

/**
 * Multiplies the specular response without touching diffuse or reflections.
 *
 * This is the knob that makes a non-metal look polished: it brightens the
 * highlights the ship's own lamps make, and does nothing at all to what the sky
 * contributes. Environment intensity goes the other way, down, so the hull
 * shines while showing even less of the universe than before.
 */
const SPECULAR_INTENSITY = 3.2;

/** A second light from behind and to the side, purely to catch the edges. */
const RIM_INTENSITY = 7.0;

/** Extra roll from the sideways slide, so a move across the frame is flown into rather than slid. */
const SLIDE_BANK = 0.5;

/**
 * How far ahead of the camera the ship reads the route, as a share of the scroll.
 *
 * This is what makes it lead rather than be dragged. It takes its heading, bank
 * and sideways drift from where the flight is *about* to be, so it turns into a
 * manoeuvre first and the camera follows it through — which is the right way
 * round: the ship is flying, the camera is only watching.
 */
const LEAD = 0.045;

/** Radians of ship yaw per radian of anticipated course change. Above 1 it oversteers, visibly. */
const LEAD_GAIN = 1.25;

/** Seconds for the lead angles to settle. */
const LEAD_HALF_LIFE = 0.3;

/**
 * No correction needed: Babylon's glTF loader already reconciles the model's
 * axes with a right-handed scene, so the imported orientation is the flight
 * orientation. Verified by rendering the alternatives — reasoning about it from
 * the file's Z-up bounding box gave the wrong answer.
 */
const DEFAULT_YAW = 0;
const DEFAULT_PITCH = 0;
const DEFAULT_ROLL = 0;

/**
 * Axis conventions between an OBJ-derived glTF and a right-handed Babylon scene
 * are quicker to settle by looking than by reasoning, so the correction is
 * overridable per load: ?shipYaw=&shipPitch=&shipRoll=, in degrees.
 */
function modelOrientation(): Quaternion {
    const params = new URLSearchParams(window.location.search);
    const read = (key: string, fallback: number): number => {
        const raw = Number(params.get(key));
        return params.has(key) && Number.isFinite(raw) ? (raw * Math.PI) / 180 : fallback;
    };
    return Quaternion.RotationYawPitchRoll(
        read("shipYaw", DEFAULT_YAW),
        read("shipPitch", DEFAULT_PITCH),
        read("shipRoll", DEFAULT_ROLL),
    );
}

/**
 * Light belonging to the ship alone.
 *
 * The whole route flies sunward, so every scene light reaches the ship from in
 * front and its visible side gets nothing — which is why it read as a black
 * silhouette. Rather than change the model's material to compensate, which would
 * stop it being the model's surface, it gets its own key and fill restricted to
 * its own meshes by `includedOnlyMeshes`. Nothing else in the scene sees them,
 * so the planets keep their backlighting exactly as it was.
 */
const KEY_INTENSITY = 13.0;
const FILL_INTENSITY = 1.15;

/**
 * Mostly non-metal, deliberately.
 *
 * A metal has no diffuse term — everything you see on it is reflection — so
 * "shiny but not reflecting the universe" is a contradiction while it stays
 * metallic: turn the reflections down and it simply goes dark, which is what
 * kept happening. Dropping the metalness lets the hull's own colour light up
 * under its own lamps, and the clear coat above supplies the polish. The result
 * reads as glossy painted panel rather than chrome.
 *
 * The model is authored as a mirror: base colour a grey-blue, roughness 0, and
 * no metallic factor at all — which in glTF means fully metallic. A perfect
 * mirror shows only what surrounds it, and what surrounds this one is mostly
 * empty space, so it rendered black however hard it was lit.
 *
 * Its colour is kept exactly as the file specifies. Only the finish is dialled
 * back, enough that the surface takes diffuse light and reads as the hull it is,
 * while still catching the nebulae in its reflections.
 */
const METALLIC = 0.22;
const ROUGHNESS = 0.035;

/**
 * How much brighter the hull's reflections are than the sky that supplies them.
 *
 * Kept low on purpose. Cranking it made the hull a mirror of the galaxy, which
 * is striking but means the ship is mostly showing the sky rather than itself.
 * The gloss now comes from a hard specular highlight off its own key light —
 * a tight, bright hotspot that travels over the panels as it banks — with only
 * enough environment for the surroundings to register faintly.
 */
const ENVIRONMENT_INTENSITY = 1.1;

/** Gentle idle motion so it never looks welded to the lens. */
const DRIFT_PITCH = 0.014;
const DRIFT_YAW = 0.02;
const DRIFT_RATE = 0.21;

/**
 * A ship flown just ahead of the camera.
 *
 * Parented to the camera's own transform rather than positioned in world space:
 * the scene runs under a floating origin, so anything meant to stay a fixed
 * distance from the camera has to be attached to it, not placed near it.
 *
 * It banks harder than the camera and slightly ahead of it, which is what sells
 * it as the thing flying rather than a decal on the lens — a real chase camera
 * always trails its subject's roll.
 */
export class ShipModel {
    private readonly carrier: TransformNode;
    private readonly pivot: TransformNode;
    private readonly cameraTransform: TransformNode;
    private readonly key: DirectionalLight;
    private roll = 0;
    private slide = 0;
    private slideVelocity = 0;
    private rise = 0;
    private riseVelocity = 0;
    private smoothedYaw = 0;
    private smoothedPitch = 0;
    private leadYaw = 0;
    private leadPitch = 0;
    private elapsed = 0;

    private constructor(
        carrier: TransformNode,
        pivot: TransformNode,
        cameraTransform: TransformNode,
        key: DirectionalLight,
    ) {
        this.carrier = carrier;
        this.pivot = pivot;
        this.cameraTransform = cameraTransform;
        this.key = key;
    }

    static async load(
        scene: Scene,
        cameraTransform: TransformNode,
        framing?: { apparentSize: number; ahead: number; below: number; swing: number },
    ): Promise<ShipModel | null> {
        if (framing !== undefined) {
            APPARENT_SIZE = framing.apparentSize;
            AHEAD = framing.ahead;
            BELOW = framing.below;
            ASIDE_SWING = framing.swing;
        }

        let result;
        try {
            result = await ImportMeshAsync(MODEL_URL, scene);
        } catch (error) {
            // A missing or unreadable model must not take the whole page down —
            // the universe is the point, the ship is an addition to it.
            console.error("Ship model failed to load", error);
            return null;
        }

        const carrier = new TransformNode("shipCarrier", scene);
        carrier.parent = cameraTransform;
        carrier.rotationQuaternion = Quaternion.Identity();

        const pivot = new TransformNode("shipPivot", scene);
        pivot.parent = carrier;
        pivot.rotationQuaternion = Quaternion.Identity();

        // A separate node carries the fixed axis correction, so the pivot is
        // free to hold only the bank and drift that change every frame.
        const orient = new TransformNode("shipOrient", scene);
        orient.parent = pivot;
        orient.rotationQuaternion = modelOrientation();

        const roots = result.meshes.filter((mesh) => mesh.parent === null);
        for (const root of roots) {
            root.parent = orient;
        }

        // Size from the model's own bounds rather than a guessed number, so
        // swapping the model for another does not require retuning the scale.
        let extent = 0;
        for (const mesh of result.meshes) {
            mesh.isPickable = false;
            mesh.alwaysSelectAsActiveMesh = true;
            const info = mesh.getBoundingInfo?.();
            if (info !== undefined) {
                extent = Math.max(extent, info.boundingBox.extendSize.length());
            }
        }
        if (extent > 0) {
            pivot.scaling.setAll((APPARENT_SIZE * AHEAD) / (2 * extent));
        }

        // Right-handed: the camera looks down its own −Z.
        carrier.position.set(0, -BELOW * AHEAD, -AHEAD);

        const lit: Array<AbstractMesh> = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);

        for (const mesh of lit) {
            const material = mesh.material as unknown as {
                metallic?: number | null;
                roughness?: number | null;
                environmentIntensity?: number;
                reflectionTexture?: unknown;
                clearCoat?: { isEnabled: boolean; intensity: number; roughness: number };
                specularIntensity?: number;
            } | null;
            if (material !== null && "metallic" in material) {
                material.metallic = METALLIC;
                material.roughness = ROUGHNESS;
                material.environmentIntensity = ENVIRONMENT_INTENSITY;
                if (scene.environmentTexture !== null) {
                    material.reflectionTexture = scene.environmentTexture;
                }
                material.specularIntensity = SPECULAR_INTENSITY;
                if (material.clearCoat !== undefined) {
                    material.clearCoat.isEnabled = true;
                    material.clearCoat.intensity = 1;
                    material.clearCoat.roughness = CLEAR_COAT_ROUGHNESS;
                }
            }
        }

        const key = new DirectionalLight("shipKey", new Vector3(0, 0, -1), scene);
        key.intensity = KEY_INTENSITY;
        key.includedOnlyMeshes = lit;

        const fill = new HemisphericLight("shipFill", new Vector3(0, 1, 0), scene);
        fill.intensity = FILL_INTENSITY;
        fill.includedOnlyMeshes = lit;

        // Rakes across the hull from behind and above, so the panel edges and the
        // leading edges of the wings pick up a hard line. Edge highlights are most
        // of what the eye reads as "polished".
        const rim = new DirectionalLight("shipRim", new Vector3(-0.6, -0.7, 0.4), scene);
        rim.intensity = RIM_INTENSITY;
        rim.includedOnlyMeshes = lit;

        return new ShipModel(carrier, pivot, cameraTransform, key);
    }

    /**
     * @param yawRate How fast the camera is turning about its up axis, rad/s.
     * @param pitchRate The same about its right axis.
     */
    update(
        layout: CorridorLayout,
        progress: number,
        yawRate: number,
        pitchRate: number,
        deltaSeconds: number,
    ): void {
        this.elapsed += deltaSeconds;

        const ahead = Math.min(1, progress + LEAD);

        // How much the course is about to change, as angles in the corridor's
        // own frame. Applied to the ship alone, so it banks and yaws into the
        // turn while the camera is still flying the old heading.
        const now = layout.tangent(progress);
        const soon = layout.tangent(ahead);
        const headingOf = (v: Vector3): number =>
            Math.atan2(Vector3.Dot(v, layout.lateral), Vector3.Dot(v, layout.forward));
        const targetYaw = (headingOf(soon) - headingOf(now)) * LEAD_GAIN;
        const targetPitch = (Math.asin(clampUnit(soon.y)) - Math.asin(clampUnit(now.y))) * LEAD_GAIN;

        this.leadYaw = lerpSmooth(this.leadYaw, targetYaw, LEAD_HALF_LIFE, deltaSeconds);
        this.leadPitch = lerpSmooth(this.leadPitch, targetPitch, LEAD_HALF_LIFE, deltaSeconds);

        // Taken from the route's own heading rather than the camera's measured
        // turn rate: same information, none of the differentiation noise.
        this.smoothedYaw = lerpSmooth(this.smoothedYaw, layout.headingOffset(progress), TURN_SMOOTHING, deltaSeconds);
        this.smoothedPitch = lerpSmooth(this.smoothedPitch, pitchRate * 0, TURN_SMOOTHING, deltaSeconds);

        // Trails the camera's turn — a followed vehicle falls to the outside of
        // frame as the camera swings after it — with the wander laid over so no
        // two passes trace quite the same line.
        const wander =
            WANDER_A * Math.sin(this.elapsed * WANDER_RATE_A * Math.PI * 2) +
            WANDER_B * Math.sin(this.elapsed * WANDER_RATE_B * Math.PI * 2 + 1.7);
        const slideTarget = clampUnit(-this.smoothedYaw * TURN_RESPONSE + wander);
        const riseTarget = clampUnit(wander * 0.34);

        const omega = 2 * Math.PI * GLIDE_FREQUENCY;
        const steps = Math.max(1, Math.min(16, Math.ceil(deltaSeconds / GLIDE_STEP)));
        const step = deltaSeconds / steps;
        const spring = (
            value: number,
            velocity: number,
            target: number,
        ): { value: number; velocity: number } => {
            let x = value;
            let v = velocity;
            for (let i = 0; i < steps; i++) {
                // Semi-implicit: velocity first, then position from the new
                // velocity. Stable where plain explicit Euler rings.
                v += (omega * omega * (target - x) - 2 * omega * v) * step;
                x += v * step;
            }
            return { value: x, velocity: v };
        };

        const slid = spring(this.slide, this.slideVelocity, slideTarget);
        this.slide = slid.value;
        this.slideVelocity = slid.velocity;

        const risen = spring(this.rise, this.riseVelocity, riseTarget);
        this.rise = risen.value;
        this.riseVelocity = risen.velocity;

        this.carrier.position.x = this.slide * ASIDE_SWING * AHEAD;
        this.carrier.position.y = -BELOW * AHEAD + this.rise * ASIDE_SWING * 0.35 * AHEAD;

        this.roll = lerpSmooth(
            this.roll,
            layout.bank(ahead) * BANK_GAIN + this.slide * SLIDE_BANK,
            BANK_HALF_LIFE,
            deltaSeconds,
        );

        const pitch = this.leadPitch + DRIFT_PITCH * Math.sin(this.elapsed * DRIFT_RATE);
        const yaw = this.leadYaw + DRIFT_YAW * Math.sin(this.elapsed * DRIFT_RATE * 0.63 + 1.1);
        Quaternion.RotationYawPitchRollToRef(yaw, pitch, this.roll, this.pivot.rotationQuaternion ?? Quaternion.Identity());

        // Follows the camera, but raked well off the view axis.
        //
        // A light pointing straight down the line of sight lights everything
        // flatly and hides its own highlight behind the geometry making it —
        // which is why the clear coat was not showing. Coming from over the
        // shoulder and above, the hotspot lands on the upper surfaces and the
        // wing edges, where it can be seen.
        this.key.direction
            .copyFrom(this.cameraTransform.forward)
            .addInPlace(this.cameraTransform.right.scale(0.55))
            .addInPlace(this.cameraTransform.up.scale(-0.8))
            .normalize();
    }

    /** Faces the model down the direction of travel; sign depends on how the model was authored. */
    setHeadingOffset(yawRadians: number): void {
        this.carrier.rotationQuaternion = Quaternion.RotationYawPitchRoll(yawRadians, 0, 0);
    }

    /** Current sideways position across the frame, −1..1. */
    frameOffset(): number {
        return this.slide;
    }

    dispose(): void {
        this.carrier.dispose(false, true);
    }
}

function clampUnit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(-1, value));
}
