//  Scroll → camera target → smoothed real camera. Scroll never renders.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { type TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { setRotationQuaternion } from "@/frontend/helpers/transform";

import { lerpSmooth } from "@/utils/math";

import { type CorridorFlight } from "./corridorFlight";
import { type PointerInfluence } from "./pointerInfluence";

/**
 * Seconds for the camera to close half the remaining distance to the scroll
 * target.
 *
 * Shorter than it used to be on purpose: the page scroll is now eased itself,
 * so most of the smoothing already happened upstream. Damping hard a second
 * time here would only add lag between the copy and the world it sits in.
 */
const COARSE =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

// Measured, after a single wheel flick: the page settled by about 500ms but the
// camera was still moving at 1000ms. That trailing half-second is the whole of
// the "unresponsive" complaint — the scroll is eased once by SmoothScroll and
// then eased again here, and two exponentials in series read as lag rather than
// as calm. The glide upstream is the one doing the smoothing; this only has to
// take the edge off the handover.
const HALF_LIFE = COARSE ? 0.03 : 0.038;

/**
 * Ceiling on how fast the camera may turn, in radians per second.
 *
 * The corridor's aim is a pure function of scroll position, so without a ceiling
 * the wheel sets angular velocity directly and without bound. Measured on the
 * same page and machine, a gentle scroll turned the camera at about 5 deg/s and
 * a brisk one peaked at 572 — more than a full rotation per second.
 *
 * Rotation is what makes a flight sickening, far more than speed: the eye
 * reports self-motion the inner ear cannot corroborate, and rotation sharpens
 * that conflict in a way translation does not. It is therefore the one quantity
 * that must not be left in the hands of the scroll wheel.
 */
const MAX_TURN_RATE = (11 * Math.PI) / 180;

/**
 * Seconds for the camera to close half its remaining angle to the authored aim.
 *
 * Below the ceiling the camera eases instead of tracking exactly, so that
 * crossing into the ceiling is continuous. A bare clamp would snap between
 * limited and unlimited the instant demand dropped, which reads as a flinch at
 * the end of every fast turn.
 */
// The ceiling on turn rate is what keeps this comfortable to watch; the easing
// below it only exists so the rate does not step. Slower than it needs to be, it
// just adds latency on top of the ceiling.
const TURN_HALF_LIFE = 0.095;

/**
 * The idle float.
 *
 * A camera pinned exactly to a curve reads as a camera on rails, because nothing
 * real holds a heading that precisely — and "on rails" is most of what reads as
 * unnatural here. A fifth of a degree of wander, on three periods that do not
 * divide into one another, is what the eye takes for a vehicle rather than a
 * rig.
 *
 * The numbers are deliberately far below anything that matters for comfort: at
 * their fastest these contribute about 0.2 degrees per second against a ceiling
 * of eleven. It is not motion you can see happening; it is the absence of the
 * stillness that gave the flight away.
 */
const FLOAT_YAW = 0.0035;
const FLOAT_PITCH = 0.0028;
const FLOAT_ROLL = 0.006;
const FLOAT_YAW_RATE = 0.83;
const FLOAT_PITCH_RATE = 1.13;
const FLOAT_ROLL_RATE = 0.61;

/**
 * Drives Cosmos Journeyer's own camera transform from scroll position.
 *
 * The split matters: scroll events only ever write a number. All movement and
 * every render happens on the animation frame, so a fast scroll cannot force
 * extra frames, and the universe keeps animating when nothing is scrolling at
 * all.
 */
export class CameraDriver {
    private readonly flight: CorridorFlight;
    private readonly pointer: PointerInfluence;
    private readonly transform: TransformNode;

    /** Where the scrollbar says we should be. Written by the scroll listener. */
    private targetProgress = 0;
    /** Where the camera actually is. Chases the target on the frame clock. */
    private progress = 0;

    /** Set once, so the first frame starts composed instead of gliding in from beat 0. */
    private floatClock = 0;
    private snapped = false;

    /** Motion of the camera this frame, for whatever wants to visualise speed. */
    private progressRate = 0;
    private yawRate = 0;
    private pitchRate = 0;
    private readonly previousForward = Vector3.Zero();
    private hasPreviousForward = false;

    /** The rate-limited aim actually given to the camera, and scratch for the slerp. */
    private readonly aim = Quaternion.Identity();
    private readonly aimScratch = Quaternion.Identity();
    private hasAim = false;

    constructor(flight: CorridorFlight, pointer: PointerInfluence, transform: TransformNode) {
        this.flight = flight;
        this.pointer = pointer;
        this.transform = transform;
    }

    /** Called from the scroll listener. Does no work beyond storing the value. */
    setTargetProgress(progress: number): void {
        this.targetProgress = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
    }

    getProgress(): number {
        return this.progress;
    }

    /** Scroll progress covered per second, signed. */
    getProgressRate(): number {
        return this.progressRate;
    }

    /** Camera turn rate about its own up axis, radians per second. */
    getYawRate(): number {
        return this.yawRate;
    }

    /** Camera turn rate about its own right axis, radians per second. */
    getPitchRate(): number {
        return this.pitchRate;
    }

    /**
     * Advances the camera one frame.
     *
     * Runs ahead of Cosmos Journeyer's own frame callback so that its orbital
     * update and post-processing — atmospheric scattering especially, which is
     * evaluated from the camera position — see this frame's camera rather than
     * the previous one's.
     */
    update(deltaSeconds: number): void {
        this.floatClock += deltaSeconds;
        // Captured before the damping runs — reading it afterwards compares the
        // new progress against itself and the rate is always zero.
        const previousProgress = this.progress;

        if (!this.snapped) {
            this.progress = this.targetProgress;
            this.snapped = true;
        } else {
            this.progress = lerpSmooth(this.progress, this.targetProgress, HALF_LIFE, deltaSeconds);
        }

        this.pointer.update(deltaSeconds);

        const state = this.flight.sample(this.progress);

        this.transform.setAbsolutePosition(state.position);

        // Position follows the corridor exactly; only the aim is rate limited.
        // Travelling fast is comfortable, being spun is not, so the flight keeps
        // its responsiveness to the wheel and gives up only its ability to whip.
        const aim = this.limitTurn(state.rotation, deltaSeconds);

        // Post-multiplying applies the pointer offset in the camera's own frame,
        // so it reads as glancing around rather than orbiting the subject. The
        // float goes on last, for the same reason: it is the vehicle moving
        // under the shot, not the shot being re-aimed.
        const float = Quaternion.RotationYawPitchRoll(
            FLOAT_YAW * Math.sin(this.floatClock * FLOAT_YAW_RATE),
            FLOAT_PITCH * Math.sin(this.floatClock * FLOAT_PITCH_RATE),
            FLOAT_ROLL * Math.sin(this.floatClock * FLOAT_ROLL_RATE),
        );
        setRotationQuaternion(this.transform, aim.multiply(this.pointer.getOffset()).multiply(float));

        this.transform.computeWorldMatrix(true);

        // Rates are measured from the camera itself rather than predicted from
        // the curve, so anything reading them sees what actually happened —
        // including the damping and the pointer's contribution.
        const dt = deltaSeconds > 1e-6 ? deltaSeconds : 1e-6;
        this.progressRate = (this.progress - previousProgress) / dt;

        const forward = this.transform.forward;
        if (this.hasPreviousForward) {
            const swing = forward.subtract(this.previousForward);
            this.yawRate = Vector3.Dot(swing, this.transform.right) / dt;
            this.pitchRate = Vector3.Dot(swing, this.transform.up) / dt;
        } else {
            this.hasPreviousForward = true;
        }
        this.previousForward.copyFrom(forward);
    }

    /**
     * Moves the aim toward the authored one, easing, but never faster than
     * MAX_TURN_RATE.
     *
     * Taking the smaller of the eased rate and the ceiling — rather than
     * clamping the eased result — keeps angular velocity continuous across the
     * point where the ceiling starts binding.
     */
    private limitTurn(target: Quaternion, deltaSeconds: number): Quaternion {
        if (!this.hasAim) {
            this.aim.copyFrom(target);
            this.hasAim = true;
            return this.aim;
        }

        // Quaternions double-cover rotations: q and -q are the same orientation,
        // so slerping toward the far copy would take the long way round — a full
        // barrel roll to reach an aim a degree away.
        const destination = Quaternion.Dot(this.aim, target) < 0 ? target.scale(-1) : target;

        const angle = 2 * Math.acos(Math.min(1, Math.abs(Quaternion.Dot(this.aim, destination))));
        if (!Number.isFinite(angle) || angle <= 1e-6) {
            return this.aim;
        }

        const easedRate = (angle * (1 - Math.pow(0.5, deltaSeconds / TURN_HALF_LIFE))) / deltaSeconds;
        const step = Math.min(easedRate, MAX_TURN_RATE) * deltaSeconds;

        Quaternion.SlerpToRef(this.aim, destination, Math.min(1, step / angle), this.aimScratch);
        this.aim.copyFrom(this.aimScratch);
        this.aim.normalize();
        return this.aim;
    }
}

