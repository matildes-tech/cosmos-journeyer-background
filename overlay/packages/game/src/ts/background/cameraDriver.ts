//  Scroll → camera target → smoothed real camera. Scroll never renders.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
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
const HALF_LIFE = 0.045;

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
    private snapped = false;

    /** Motion of the camera this frame, for whatever wants to visualise speed. */
    private progressRate = 0;
    private yawRate = 0;
    private pitchRate = 0;
    private readonly previousForward = Vector3.Zero();
    private hasPreviousForward = false;

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

        // Post-multiplying applies the pointer offset in the camera's own frame,
        // so it reads as glancing around rather than orbiting the subject.
        setRotationQuaternion(this.transform, state.rotation.multiply(this.pointer.getOffset()));

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
}

