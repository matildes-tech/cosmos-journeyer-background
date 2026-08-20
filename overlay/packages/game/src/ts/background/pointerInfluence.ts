//  Subtle pointer / touch parallax layered on top of the scroll camera.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { Quaternion } from "@babylonjs/core/Maths/math.vector";

import { lerpSmooth } from "@/utils/math";

/** Maximum look-around, in radians. Deliberately tiny — this must not read as a camera control. */
const MAX_YAW = (2.0 * Math.PI) / 180;
const MAX_PITCH = (1.4 * Math.PI) / 180;

/** Seconds for the offset to close half the distance to the pointer. */
const HALF_LIFE = 0.25;

/**
 * Turns pointer position into a small orientation offset.
 *
 * The offset is absolute, never accumulated: it is a pure function of where the
 * pointer currently is, so it cannot drift, cannot wind up, and always returns
 * to neutral when the pointer is centred or lifted. That is what keeps it from
 * competing with the scroll narrative — the scroll owns where the camera is,
 * this only nudges where it looks.
 */
export class PointerInfluence {
    private targetX = 0;
    private targetY = 0;
    private x = 0;
    private y = 0;

    private readonly onPointerMove: (e: PointerEvent) => void;
    private readonly onPointerLeave: () => void;
    private readonly onTouchMove: (e: TouchEvent) => void;
    private readonly onTouchEnd: () => void;

    constructor() {
        this.onPointerMove = (e: PointerEvent) => {
            // Touch scrolling generates pointermove too; letting it through would
            // tie the look direction to the finger doing the scrolling.
            if (e.pointerType === "touch") return;
            this.setFromClient(e.clientX, e.clientY);
        };
        this.onPointerLeave = () => {
            this.targetX = 0;
            this.targetY = 0;
        };
        this.onTouchMove = (e: TouchEvent) => {
            const t = e.touches[0];
            if (t === undefined) return;
            // A fraction of the effect a mouse gets: on touch the finger is also
            // scrolling, so a strong coupling feels like the page is fighting back.
            this.setFromClient(t.clientX, t.clientY, 0.35);
        };
        this.onTouchEnd = () => {
            this.targetX = 0;
            this.targetY = 0;
        };

        window.addEventListener("pointermove", this.onPointerMove, { passive: true });
        window.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
        window.addEventListener("touchmove", this.onTouchMove, { passive: true });
        window.addEventListener("touchend", this.onTouchEnd, { passive: true });
    }

    private setFromClient(clientX: number, clientY: number, scale = 1): void {
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        this.targetX = ((clientX / w) * 2 - 1) * scale;
        this.targetY = ((clientY / h) * 2 - 1) * scale;
    }

    /** Advances the damping. Call once per frame before {@link getOffset}. */
    update(deltaSeconds: number): void {
        this.x = lerpSmooth(this.x, this.targetX, HALF_LIFE, deltaSeconds);
        this.y = lerpSmooth(this.y, this.targetY, HALF_LIFE, deltaSeconds);
    }

    /**
     * The offset as a local-space rotation, to post-multiply onto the camera's
     * base orientation so it reads as looking around rather than orbiting.
     */
    getOffset(): Quaternion {
        return Quaternion.RotationYawPitchRoll(this.x * MAX_YAW, this.y * MAX_PITCH, 0);
    }

    dispose(): void {
        window.removeEventListener("pointermove", this.onPointerMove);
        window.removeEventListener("pointerleave", this.onPointerLeave);
        window.removeEventListener("touchmove", this.onTouchMove);
        window.removeEventListener("touchend", this.onTouchEnd);
    }
}
