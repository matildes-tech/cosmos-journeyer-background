//  Cosmos Journeyer's own warp dust, driven by scroll instead of a throttle.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { type TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { type Scene } from "@babylonjs/core/scene";

import { SpaceDots } from "@/frontend/assets/procedural/spaceDots";

import { lerpSmooth } from "@/utils/math";

/**
 * Throttle held even when nothing is scrolling.
 *
 * The ship shows dust only while the warp drive is engaged, because a parked
 * ship is genuinely stationary. A background is not: it should always read as
 * under way, so the dust never stops entirely — it only surges.
 */
const CRUISE_THROTTLE = 0.07;

/** Scroll rate, in progress per second, that corresponds to peak throttle. */
const FULL_THROTTLE_RATE = 0.22;

/**
 * Ceiling on the dust.
 *
 * At full throttle this is the ship's warp effect, and as a page background it
 * reads as a hyperspace tunnel rather than as travel. Capping it well below the
 * top keeps the streaks as a hint of speed instead of the subject.
 */
const PEAK_THROTTLE = 0.26;

/** Seconds for the throttle to close half the gap to its target. */
const THROTTLE_HALF_LIFE = 0.55;

/** Turn rate, in radians per second, that corresponds to full steering bend. */
const FULL_STEER_RATE = 0.35;

/** Matches the ship's own coupling of steering intent to dust bend. */
const STEER_RESPONSE = 5.0;

/**
 * The sense of speed.
 *
 * Bodies drifting past at interplanetary distances give the eye almost nothing
 * to judge motion by — the frame can look static even while the camera crosses
 * millions of kilometres. Cosmos Journeyer solves this in its ship with a field
 * of near-field dust that streaks along the direction of travel and bends when
 * you steer, and that is what makes its flight read as flight. This is the same
 * component, driven by how fast the page is being scrolled rather than by a
 * throttle lever.
 */
export class SpeedCue {
    private readonly dots: SpaceDots;
    private throttle = CRUISE_THROTTLE;

    constructor(scene: Scene, carrier: TransformNode, instanceCount: number) {
        // Cosmos Journeyer draws ten thousand of these. That is affordable in the
        // game, where nothing else is competing, but here they are additive
        // streaks over a frame that already carries four volumetric clouds — and
        // the throttle rises exactly when the page is being scrolled, so the
        // frame rate collapsed at the one moment smoothness matters. A third of
        // the count is indistinguishable at these speeds and costs a third as
        // much overdraw.
        this.dots = new SpaceDots(scene, { instanceCount });
        // Parented to the camera's own transform, so the dust travels with the
        // camera and its warp frame is always the direction of flight.
        this.dots.getTransform().parent = carrier;
        this.dots.setThrottle(CRUISE_THROTTLE);
    }

    /**
     * @param progressRate How fast scroll progress is changing, per second.
     * @param yawRate Camera turn rate about its up axis, radians per second.
     * @param pitchRate Camera turn rate about its right axis, radians per second.
     */
    update(deltaSeconds: number, progressRate: number, yawRate: number, pitchRate: number): void {
        const surge = Math.min(1, Math.abs(progressRate) / FULL_THROTTLE_RATE);
        const target = CRUISE_THROTTLE + (PEAK_THROTTLE - CRUISE_THROTTLE) * surge;
        this.throttle = lerpSmooth(this.throttle, target, THROTTLE_HALF_LIFE, deltaSeconds);
        this.dots.setThrottle(this.throttle);

        this.dots.setSteering(
            STEER_RESPONSE * clampUnit(yawRate / FULL_STEER_RATE),
            STEER_RESPONSE * clampUnit(pitchRate / FULL_STEER_RATE),
        );
        this.dots.update(deltaSeconds);
    }

    getThrottle(): number {
        return this.throttle;
    }

    dispose(): void {
        this.dots.dispose();
    }
}

function clampUnit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(-1, value));
}
