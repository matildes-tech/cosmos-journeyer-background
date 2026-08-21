//  Device-appropriate rendering budget for the background.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { type AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

export type Tier = "desktop" | "mobile";

export interface QualityProfile {
    readonly tier: Tier;
    /**
     * Upper bound on device pixel ratio. The scene is expensive per pixel, and a
     * 3x phone panel costs nine times a 1x one for detail nobody can resolve at
     * arm's length.
     */
    readonly maxPixelRatio: number;
    /**
     * How far ahead of closest approach each body is framed, in pass distances.
     *
     * Babylon holds vertical field of view fixed, so a portrait viewport keeps
     * far less of the horizontal view and clips a subject sitting well off the
     * flight axis. Approaching from further ahead narrows that angle, which is
     * what actually fits the shot — and it does so without touching field of
     * view, so perspective and relative scale stay exactly as authored.
     */
    readonly approachFactor: number;
    /**
     * Multiplies every closest approach.
     *
     * These used to halve it, which put the camera around two radii out and let
     * a body subtend as much as 84 degrees. Something filling the visual field
     * while it sweeps is the strongest driver of visually-induced self-motion
     * there is, and it was a large part of why the flight was uncomfortable.
     * Bodies are now framed at roughly 25-35 degrees: still dominant in the
     * composition, no longer wrapped around the viewer.
     */
    readonly passScale: number;
    /** How many of the nebulae to build. A phone cannot march four of them. */
    readonly nebulaLimit: number;
    /** Multiplies each cloud's march steps. */
    readonly nebulaStepScale: number;
    /** Near-field dust instances. */
    readonly dustInstances: number;
    /** Ship size as a fraction of its distance, and where it sits. */
    readonly shipApparentSize: number;
    readonly shipAhead: number;
    readonly shipBelow: number;
    /**
     * How far the ship glides across, as a fraction of its distance.
     *
     * Much smaller in portrait: the frame is barely half as wide in angle, so a
     * swing that reads as a graceful drift on a desktop throws the ship straight
     * out of shot on a phone.
     */
    readonly shipSwing: number;
}

const DESKTOP: QualityProfile = {
    tier: "desktop",
    maxPixelRatio: 2,
    approachFactor: 2.6,
    passScale: 1,
    nebulaLimit: 4,
    nebulaStepScale: 1,
    dustInstances: 3200,
    shipApparentSize: 0.86,
    shipAhead: 8.5,
    shipBelow: 0.4,
    shipSwing: 0.7,
};

/**
 * A phone is not a smaller desktop.
 *
 * The volumetric clouds are marched per pixel and are by far the heaviest thing
 * here, so a phone gets two of them at reduced steps rather than four. The ship
 * is smaller and further off: at portrait aspect the same framing fills the
 * screen, and there is far less width for it to glide across. Bodies are passed
 * wider for the same reason — a shot composed for landscape crops badly when the
 * frame is taller than it is wide.
 */
const MOBILE: QualityProfile = {
    tier: "mobile",
    maxPixelRatio: 1.25,
    approachFactor: 4.8,
    passScale: 1.15,
    nebulaLimit: 2,
    nebulaStepScale: 0.55,
    dustInstances: 1100,
    shipApparentSize: 0.6,
    shipAhead: 11,
    shipBelow: 0.28,
    shipSwing: 0.26,
};

/**
 * Picks a profile from input capability rather than user-agent string.
 *
 * A coarse pointer with no hover is the honest signal for "phone or tablet" —
 * it survives desktop-mode browsers and does not need a device list to maintain.
 */
export function detectProfile(): QualityProfile {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return DESKTOP;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const noHover = window.matchMedia("(hover: none)").matches;
    const narrow = window.innerWidth < 820;
    return coarse && (noHover || narrow) ? MOBILE : DESKTOP;
}

/**
 * Applies the profile to the engine.
 *
 * Babylon's hardware scaling level is the inverse of resolution scale: 1 renders
 * at CSS resolution, 0.5 at twice it. Deriving it from the capped ratio keeps a
 * retina display sharp without ever rendering more pixels than the cap allows.
 */
export function applyProfile(engine: AbstractEngine, profile: QualityProfile): void {
    const ratio = Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio);
    engine.setHardwareScalingLevel(1 / ratio);
}
