//  The camera flying the corridor.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { type Matrix } from "@babylonjs/core/Maths/math";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { type Scene } from "@babylonjs/core/scene";

import { lookAt, roll } from "@/frontend/helpers/transform";
import { type StarSystemController } from "@/frontend/universe/starSystemController";

import { STOPS, type CorridorLayout } from "./corridor";

export interface CameraState {
    readonly position: Vector3;
    readonly rotation: Quaternion;
}

/**
 * How far the camera turns toward a body as it passes, as a fraction of the way
 * from straight ahead to looking right at it.
 *
 * Zero is a pure fly-by: bodies enter at the edge of frame and are gone. That is
 * technically the straightest flight and reads as though the camera never
 * noticed them. A small value keeps each body in shot through the pass while the
 * flight path itself stays dead straight — the camera looks, it does not steer.
 */
const GLANCE = 0.22;

/** Arbitrary distance for the look-at point; only its direction matters. */
const LOOK_AHEAD = 1e9;

/**
 * Smootherstep: zero first *and* second derivative at both ends.
 *
 * Plain smoothstep still has a curvature step where it meets the flat part, and
 * on a slow glance that reads as the camera flinching as a planet comes into
 * range. This one eases in and out of the turn cleanly.
 */
function smootherstep(t: number): number {
    const x = Math.min(1, Math.max(0, t));
    return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Turns scroll progress into a camera state on the corridor.
 *
 * The position is always exactly on the straight line — nothing curves the path,
 * so the flight cannot wander. All the character comes from pacing, from the
 * bodies passing at their authored distances, and from a slight glance and bank.
 */
export class CorridorFlight {
    private readonly probe: TransformNode;
    private readonly starSystem: StarSystemController;
    private readonly layout: CorridorLayout;
    private readonly rightHanded: boolean;

    constructor(scene: Scene, starSystem: StarSystemController, layout: CorridorLayout) {
        this.starSystem = starSystem;
        this.layout = layout;
        this.rightHanded = scene.useRightHandedSystem;

        this.probe = new TransformNode("corridorFlightProbe", scene);
        this.probe.rotationQuaternion = Quaternion.Identity();
    }

    /**
     * Where the star currently is.
     *
     * The scene uses a floating origin: every frame the world is translated so
     * the camera sits near zero, which keeps a star system inside float32. That
     * makes absolute world coordinates a moving target — a camera placed at a
     * fixed absolute point drifts away from the system a little more every
     * frame, and after a few seconds the whole system is off at 1e13 metres.
     *
     * The corridor is therefore laid out relative to the star and rebased onto
     * the star's live transform each frame, so the camera always lands in the
     * same frame the bodies are actually in.
     */
    /**
     * The system's reference plane.
     *
     * Cosmos Journeyer tilts every orbit into a plane derived from the star —
     * for the Sun that is its 7.25 degree axial tilt. The layout is authored in
     * the untilted frame, which is what the orbital elements need, so the camera
     * has to be rotated into the same plane or it flies 7 degrees off and the
     * planets pass thousands of kilometres above it.
     */
    private plane(): Matrix {
        return this.starSystem.getReferencePlaneRotation();
    }

    private systemOrigin(): Vector3 {
        // Anchored on the Sun specifically. The corridor is measured from it and
        // ends inside it, so the finale has to be exact; the Sun is also the one
        // body that does not orbit, which makes it the only stable reference.
        // The planets do drift along their orbits, but the glance reads their
        // live transforms, so the framing follows them.
        const star = this.starSystem.getStellarObjects()[0];
        return star === undefined ? Vector3.Zero() : star.getTransform().getAbsolutePosition();
    }

    /**
     * Live world position of a stop's body, falling back to where the layout put
     * it. The bodies are on real orbits, so they drift from their authored point over
     * time; reading the live transform keeps the glance pointed at the body
     * rather than at where it started.
     */
    private bodyPosition(index: number): Vector3 {
        const stop = STOPS[index];
        if (stop !== undefined) {
            const object = this.starSystem.getOrbitalObjectById(stop.objectId);
            if (object !== undefined) {
                return object.getTransform().getAbsolutePosition();
            }
        }
        return this.systemOrigin().add(Vector3.TransformCoordinates(this.layout.stopPosition(index), this.plane()));
    }

    sample(progress: number): CameraState {
        const plane = this.plane();
        const position = this.systemOrigin().add(Vector3.TransformCoordinates(this.layout.point(progress), plane));
        // The path weaves, so the direction of travel is its own tangent rather
        // than a fixed axis.
        const forward = Vector3.TransformNormal(this.layout.tangent(progress), plane).normalize();

        // Every body in range pulls on the look direction, weighted. No single
        // body is ever "the" target, so there is no moment where the target
        // switches and the camera snaps across.
        // Aim at the weighted average *position* of the bodies in range, not at
        // an average of the directions to them.
        //
        // Averaging directions cancels: two bodies on opposite sides give unit
        // vectors that partly subtract, and if the sum ever passes near zero
        // length, normalising it flips the camera round violently. Averaging
        // positions cannot do that — the mean of two points out in front is
        // still a point out in front — so the aim moves smoothly however the
        // weights shift.
        const weights = this.layout.stopWeights(progress);
        const centroid = Vector3.Zero();
        let totalWeight = 0;
        for (let i = 0; i < weights.length; i++) {
            const w = smootherstep(weights[i] ?? 0);
            if (w <= 0.0001) continue;
            centroid.addInPlace(this.bodyPosition(i).scale(w));
            totalWeight += w;
        }

        let direction = forward;
        if (totalWeight > 0.0001) {
            const toTarget = centroid.scaleInPlace(1 / totalWeight).subtractInPlace(position);
            const length = toTarget.length();
            if (length > 0) {
                direction = Vector3.Lerp(
                    forward,
                    toTarget.scaleInPlace(1 / length),
                    GLANCE * Math.min(1, totalWeight),
                ).normalize();
            }
        }

        this.probe.setAbsolutePosition(position);
        lookAt(this.probe, position.add(direction.scale(LOOK_AHEAD)), this.rightHanded);
        this.probe.computeWorldMatrix(true);

        roll(this.probe, -this.layout.bank(progress));
        this.probe.computeWorldMatrix(true);

        return {
            position,
            rotation: (this.probe.absoluteRotationQuaternion ?? Quaternion.Identity()).clone(),
        };
    }

    /** How completely the Sun has swallowed the frame, 0..1. */
    whiteout(progress: number): number {
        return this.layout.whiteout(progress);
    }

    /** Label of whatever the flight is currently passing, for the debug overlay. */
    currentLabel(progress: number): string {
        const { index, weight } = this.layout.dominantStop(progress);
        if (weight <= 0.02) {
            return progress > 0.88 ? "into the Sun" : "open space";
        }
        return `${STOPS[index]?.label ?? "?"}  (${(weight * 100).toFixed(0)}%)`;
    }
}
