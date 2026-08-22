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
const HALF_LIFE = COARSE ? 0.022 : 0.05;

/** Quiet time in front of a wheel event for it to count as a new gesture. */
const GESTURE_GAP = 160;
/** Floor on how long a page takes, so a fast wheel cannot double-step. */
const PAGE_MIN_MS = 260;

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
    private lastWheel = 0;
    private paging = false;
    private pagingSince = 0;

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
            if (Math.abs(e.deltaY) < 2) return;

            // One gesture, one section.
            //
            // A wheel does not send one event per flick — a notch sends a burst,
            // and a trackpad sends a stream that carries on coasting for about a
            // second after the fingers leave. So a gesture is recognised by the
            // gap in front of it: the first event after a quiet moment pages,
            // and everything still arriving belongs to the same gesture and is
            // swallowed.
            const now = performance.now();
            const startsGesture = now - this.lastWheel > GESTURE_GAP;
            this.lastWheel = now;
            if (!startsGesture || this.paging) return;
            this.page(e.deltaY > 0 ? 1 : -1);
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

        // The wheel is only captured where there is a wheel. On touch this class
        // reads the document and never writes to it.
        if (!COARSE) {
            window.addEventListener("wheel", this.onWheel, { passive: false });
        }
        window.addEventListener("scroll", this.onScroll, { passive: true });
        window.addEventListener("resize", this.onResize);
    }

    /**
     * Where a section begins, in document pixels.
     *
     * Read from the sections themselves rather than computed from a height, so
     * it stays true if the layout changes. The end of the document is a stop in
     * its own right: the closing panel lives past the last section.
     */
    private stops(): Array<number> {
        const panels = Array.from(document.querySelectorAll<HTMLElement>(".panel"));
        const tops = panels.map((panel) => clamp(panel.offsetTop, 0, this.maximum));
        if (tops.length === 0 || (tops[tops.length - 1] ?? 0) < this.maximum - 1) {
            tops.push(this.maximum);
        }
        return tops;
    }

    /** Moves one section, in the given direction. */
    private page(direction: number): void {
        const tops = this.stops();
        if (tops.length === 0) return;
        let nearest = 0;
        for (let i = 1; i < tops.length; i++) {
            if (Math.abs((tops[i] ?? 0) - this.target) < Math.abs((tops[nearest] ?? 0) - this.target)) {
                nearest = i;
            }
        }
        // A gesture that starts mid-section should complete the section it is in
        // rather than skip the one it has not arrived at yet.
        const here = tops[nearest] ?? 0;
        if (direction > 0 && here > this.target + 2) {
            this.target = here;
        } else if (direction < 0 && here < this.target - 2) {
            this.target = here;
        } else {
            const next = Math.max(0, Math.min(tops.length - 1, nearest + direction));
            this.target = tops[next] ?? this.target;
        }
        this.paging = true;
        this.pagingSince = performance.now();
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

        // Touch: follow the document, never drive it.
        //
        // On iOS a programmatic scroll during a momentum fling cancels the fling
        // outright. Easing the document here meant calling scrollTo on almost
        // every frame, so every flick died the instant the finger left the glass
        // and scrolling felt broken. There is nothing to smooth in any case —
        // the browser's own momentum is already smooth, and a finger is direct.
        if (COARSE) {
            this.current = window.scrollY;
            this.target = this.current;
            return;
        }
        this.current = lerpSmooth(this.current, this.target, HALF_LIFE, deltaSeconds);
        if (Math.abs(this.current - this.target) < SETTLE_EPSILON) {
            this.current = this.target;
            // Released on arrival, not on a timer, so the next gesture always
            // begins from a section rather than from halfway between two.
            if (this.paging && performance.now() - this.pagingSince > PAGE_MIN_MS) {
                this.paging = false;
            }
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
        if (!COARSE) {
            window.removeEventListener("wheel", this.onWheel);
        }
        window.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("resize", this.onResize);
    }
}

function clamp(value: number, low: number, high: number): number {
    if (!Number.isFinite(value)) return low;
    return Math.min(high, Math.max(low, value));
}
