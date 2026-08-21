//  Eased scrolling, in the manner of Lenis.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { lerpSmooth } from "@/utils/math";

/**
 * Seconds for the page to close half the distance to where the wheel has asked
 * it to go. This is the whole feel of the thing: too short and the wheel still
 * reads as discrete notches, too long and the page swims behind the pointer.
 */
const COARSE =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

/**
 * Seconds to close half the gap to the scroll position.
 *
 * Much shorter on touch. A finger is already a direct manipulation — the page
 * moves exactly as far as it is dragged — so easing on top of it does not read
 * as softness, it reads as the scene lagging behind the hand.
 */
const HALF_LIFE = COARSE ? 0.022 : 0.062;

/**
 * Wheel delta multiplier.
 *
 * Above 1 a notch covers more of the page, so the whole journey takes fewer
 * wheel actions. Sensitivity is not lost with it because the easing, not the
 * step size, is what makes the movement feel calm.
 */
const WHEEL_SCALE = 1.35;

/** Below this many pixels the glide is over; stop writing scroll positions. */
const SETTLE_EPSILON = 0.35;

/**
 * Smooth, inertial scrolling with a real scrollbar behind it.
 *
 * The native wheel moves the document in discrete jumps, and damping only the
 * camera afterwards makes it worse rather than better: the text lands instantly
 * while the world it sits in keeps sliding, and the two visibly disagree. Easing
 * the document itself keeps copy and camera locked together and gives the wheel
 * the weight of something with mass.
 *
 * Anything that is not the wheel — dragging the scrollbar, arrow keys, a phone's
 * own touch scrolling — is left completely alone and simply resynced, so the
 * page never fights an input it did not choose to handle.
 */
export class SmoothScroll {
    private target: number;
    private current: number;
    private maximum = 0;
    /** Set immediately before we move the page, so our own scroll event is not mistaken for the user's. */
    private selfScrolling = false;

    private readonly onWheel: (e: WheelEvent) => void;
    private readonly onScroll: () => void;
    private readonly onResize: () => void;

    constructor() {
        this.target = window.scrollY;
        this.current = window.scrollY;
        this.measure();

        this.onWheel = (e: WheelEvent) => {
            // Leave zoom and horizontal gestures to the browser.
            if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
            e.preventDefault();
            this.target = clamp(this.target + e.deltaY * WHEEL_SCALE, 0, this.maximum);
        };

        this.onScroll = () => {
            // A flag, not a distance test. The old version resynced whenever the
            // page had moved more than two pixels from where we last put it —
            // which is true on every frame of a fast glide, so it would abandon
            // the glide mid-flight and the movement stuttered. Only a scroll we
            // did not cause should take over.
            if (this.selfScrolling) {
                this.selfScrolling = false;
                return;
            }
            this.target = window.scrollY;
            this.current = window.scrollY;
        };

        this.onResize = () => this.measure();

        window.addEventListener("wheel", this.onWheel, { passive: false });
        window.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("resize", this.onResize);
    }

    private measure(): void {
        this.maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        this.target = clamp(this.target, 0, this.maximum);
    }

    /** Advances the glide. Call once per frame, before reading progress. */
    update(deltaSeconds: number): void {
        if (this.maximum <= 0) {
            this.measure();
            return;
        }
        this.current = lerpSmooth(this.current, this.target, HALF_LIFE, deltaSeconds);
        if (Math.abs(this.current - this.target) < SETTLE_EPSILON) {
            this.current = this.target;
        }
        if (Math.abs(this.current - window.scrollY) > 0.05) {
            this.selfScrolling = true;
            window.scrollTo(0, this.current);
        }
    }

    /** Scroll position as 0..1. */
    getProgress(): number {
        return this.maximum <= 0 ? 0 : clamp(this.current / this.maximum, 0, 1);
    }

    dispose(): void {
        window.removeEventListener("wheel", this.onWheel);
        window.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("resize", this.onResize);
    }
}

function clamp(value: number, low: number, high: number): number {
    if (!Number.isFinite(value)) return low;
    return Math.min(high, Math.max(low, value));
}
