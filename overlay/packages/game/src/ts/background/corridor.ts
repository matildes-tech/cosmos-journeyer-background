//  A straight flight corridor inward through Sol, ending inside the Sun.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/** The corridor is authored in the untilted ecliptic; the flight rotates it into place. */
const UP = new Vector3(0, 1, 0);

/**
 * One body the flight passes.
 *
 * Radii are the real ones from Cosmos Journeyer's Sol system, in metres. They
 * are written down rather than read from the model because the corridor is laid
 * out before the scene exists — the layout decides where the bodies go, not the
 * other way round.
 */
export interface Stop {
    readonly objectId: string;
    readonly radius: number;
    /** Closest approach to the corridor, in the body's own radii. */
    readonly passRadii: number;
    /** Which side of the corridor it sits on, so bodies alternate past the camera. */
    readonly side: 1 | -1;
    /** Run-up before this stop, in multiples of its pass distance. */
    readonly leadFactor: number;
    readonly label: string;
}

/** Radius of the Sun, which is the destination rather than a fly-by. */
export const SUN_RADIUS = 695_508e3;
export const SUN_ID = "sun";

/**
 * The journey: inbound through Sol, in order of increasing size, ending in the
 * Sun itself.
 *
 * Flying inward means every planet is lit from behind — the Sun is ahead, the
 * planet between camera and Sun, so what shows is a crescent with a rim-lit
 * limb. That is not a compromise, it is what the inner solar system actually
 * looks like from a ship falling sunward, and it is why Cassini's backlit
 * Saturn is the most famous photograph of that planet ever taken.
 */
export const STOPS: readonly [Stop, ...Array<Stop>] = [
    { objectId: "mars", radius: 3_389.5e3, passRadii: 4, side: 1, leadFactor: 15, label: "Mars" },
    { objectId: "earth", radius: 6_371e3, passRadii: 4, side: -1, leadFactor: 15, label: "Earth and Moon" },
    { objectId: "neptune", radius: 24_622e3, passRadii: 3.6, side: 1, leadFactor: 14, label: "Neptune" },
    // Saturn is given somewhat more room than its radius alone suggests: the
    // rings extend well past the disc and are the widest thing on the route.
    { objectId: "saturn", radius: 58_232e3, passRadii: 5, side: -1, leadFactor: 14, label: "Saturn" },
    { objectId: "jupiter", radius: 69_911e3, passRadii: 3.6, side: 1, leadFactor: 13, label: "Jupiter" },
];

/**
 * Distance from the last planet to the centre of the Sun, in solar radii.
 *
 * This single leg is longer than the entire rest of the corridor, which is what
 * lets the Sun grow from a bright point to filling the frame.
 */
const SUN_APPROACH_RADII = 900;

/**
 * Progress at which the last planet is passed; everything after is the Sun.
 *
 * The run to the Sun is more than a hundred times longer than the whole planet
 * section. Giving it a proportionate share of the scroll is what turns it from a
 * lurch into an approach — measured on the old layout, where the planets ran to
 * five sixths of the scroll, travel per unit scroll stepped fifty-fold in a
 * single interval exactly where the last planet still filled the frame, and the
 * camera yawed there at over 500 deg/s.
 *
 * The exact value also keeps each planet inside its own panel: with seven
 * panels the stops land at 0.15, 0.30, 0.45, 0.60 and 0.75, one per panel from
 * the second to the sixth, so the copy still describes what is on screen beside
 * it. Changing this without checking that alignment will silently caption Saturn
 * over a shot of Jupiter.
 */
const PLANET_SPAN = 0.75;

/**
 * Intermediate anchors shaping the run to the Sun.
 *
 * Their distances fall geometrically rather than evenly, so the Sun's apparent
 * size grows at a steady rate and the acceleration is spread across the whole
 * leg instead of landing on one knot. Absolute speed still rises a great deal
 * here, which is harmless: with nothing near the camera, there is almost nothing
 * on screen whose motion could betray it.
 */
const SUN_LEG_ANCHORS = 7;

/** How close the shaped part of the approach runs, in solar radii. Inside this the screen is white. */
const SUN_LEG_FLOOR_RADII = 1.6;

/**
 * How sharply the run to the Sun eases out of the planet section.
 *
 * A plain geometric decay puts its quickest interval at the very start of the
 * leg — which is precisely where the last planet is still receding, and it
 * showed up as a ninety-fold jump in travel per unit scroll across one knot.
 * Bending the parameter first means the leg leaves the planets at something near
 * their own pace, builds to a cruise where there is nothing close enough for the
 * speed to register, and settles again as the Sun fills the frame.
 */
const SUN_LEG_EASE = 7.3;

/**
 * How far before closest approach a body is framed, in pass distances.
 *
 * At closest approach the subject is exactly abeam — 90 degrees off the flight
 * axis, so outside the frame of anything still flying straight. Framing earlier
 * puts it ahead and to one side, and it then sweeps past. That sweep is the
 * fly-by.
 */
export const DEFAULT_APPROACH_FACTOR = 2.6;

/**
 * Minimum clearance after a body before the next, in the previous body's pass
 * distances, so a small body is never placed inside the one it follows.
 */
const DEPART_FACTOR = 7;

/**
 * Width of a stop's glance envelope, as a share of total scroll.
 *
 * Wider than it needs to be, deliberately: the camera should ease onto a body
 * and ease off it over a long stretch of scroll rather than snapping to it.
 */
const GLANCE_SPAN_PROGRESS = 0.24;

/**
 * How far the ship swings to each side, in that body's pass distances.
 *
 * The ship weaves: it passes one planet on the left, the next on the right, and
 * so on. Independent bumps that each returned to a centre line did not read as
 * flight, because a real vehicle does not recentre between manoeuvres — it
 * carries momentum out of one turn and into the next. One continuous curve
 * through alternating waypoints does, and it is why this now looks flown rather
 * than animated.
 */
const SWING_FACTOR = 2.2;


/** Vertical share of the weave, a quarter-phase out, so the path rolls rather than staying flat. */
const RISE_FACTOR = 0.8;

/**
 * Maximum bank, in radians.
 *
 * Nearly flat, and deliberately. Roll is the least forgiving axis for comfort
 * because it fights the sense of which way is down, and space offers no horizon
 * to re-establish it. What is left is enough to feel the turns without the frame
 * appearing to tumble.
 */
const BANK_MAX = 0.06;

/**
 * The widest the nose ever swings off the corridor axis, in radians.
 *
 * The heading is authored rather than derived from velocity, and deliberately.
 * The true direction of travel mixes an along-track speed that varies by orders
 * of magnitude down the route with a lateral speed that does not, so wherever
 * the pace eases — which is exactly where each planet is — the lateral term
 * takes over and the nose snaps round. Measured, the turn rate was changing
 * almost completely from one step to the next. Referencing the swing to a fixed
 * scale instead makes heading a smooth, bounded function of scroll: the weave
 * still reads, and the turn eases in and out of every planet.
 */
const MAX_HEADING_SWING = (11 * Math.PI) / 180;

/** Half-width of the window the bank is averaged over, as a share of total scroll. */
const BANK_SMOOTHING = 0.035;

/** Companion placement, as multiples of the whole route's length. */
const COMPANION_AHEAD = 1.3;
const COMPANION_SIDE = 1.5;
const COMPANION_RISE = 0.55;

/** Where the white-out begins and ends, in solar radii from the Sun's centre. */
const WHITEOUT_START_RADII = 40;
const WHITEOUT_FULL_RADII = 2.2;

/**
 * The corridor geometry, resolved for one heading and approach factor.
 *
 * Both the star system layout and the camera read from the same instance, so a
 * body cannot end up somewhere the camera does not expect: there is exactly one
 * description of where everything is.
 *
 * The Sun sits at the system origin and the corridor runs straight into it, so
 * distances along the corridor are negative throughout and reach zero exactly
 * at the end of the page.
 */
export class CorridorLayout {
    readonly forward: Vector3;
    readonly lateral: Vector3;

    readonly stopF: ReadonlyArray<number>;
    /** Where each body is actually framed — a little before its closest approach. */
    readonly featureF: ReadonlyArray<number>;
    readonly startF: number;
    /** The Sun's centre. The flight ends here. */
    readonly endF = 0;

    /** Solved body positions, so an authored pass distance is the one achieved. */
    private readonly stopPositions: Array<Vector3>;

    private readonly approachFactor: number;
    private readonly passDistances: ReadonlyArray<number>;
    private readonly pacing: MonotoneCurve;
    /** Along-track reference that fixes how wide the widest turn is. */
    private readonly headingReference: number;
    private readonly lateralPath: NaturalSpline;
    private readonly risePath: NaturalSpline;
    /** Largest lateral acceleration anywhere on the path, so bank can be normalised to it. */
    private readonly peakLateralAcceleration: number;
    /** Largest sideways excursion anywhere on the route, so the weave can be normalised. */
    private readonly peakLateral: number;

    constructor(headingDegrees: number, approachFactor = DEFAULT_APPROACH_FACTOR, passScale = 1) {
        const h = (headingDegrees * Math.PI) / 180;
        this.forward = new Vector3(Math.cos(h), 0, Math.sin(h));
        this.lateral = new Vector3(-Math.sin(h), 0, Math.cos(h));

        this.approachFactor = approachFactor;
        this.passDistances = STOPS.map((s) => s.radius * s.passRadii * passScale);

        // The last planet sits one long solar approach short of the Sun; the rest
        // are stacked back from it, each with room to grow in frame and clearance
        // from whatever it follows.
        const last = STOPS.length - 1;
        const stopF = new Array<number>(STOPS.length).fill(0);
        stopF[last] = -SUN_APPROACH_RADII * SUN_RADIUS;
        for (let i = last; i > 0; i--) {
            const runUp = (STOPS[i]?.leadFactor ?? 14) * (this.passDistances[i] ?? 0);
            const clearance = DEPART_FACTOR * (this.passDistances[i - 1] ?? 0);
            stopF[i - 1] = (stopF[i] ?? 0) - Math.max(runUp, clearance);
        }
        this.stopF = stopF;
        this.featureF = stopF.map((f, i) => f - approachFactor * (this.passDistances[i] ?? 0));

        this.startF = (this.featureF[0] ?? 0) - (STOPS[0]?.leadFactor ?? 15) * (this.passDistances[0] ?? 0);

        const stopX = STOPS.map((_, i) => (PLANET_SPAN * (i + 1)) / STOPS.length);

        const anchorX = [0, ...stopX];
        const anchorY = [this.startF, ...STOPS.map((_, i) => this.featureF[i] ?? 0)];

        // The Sun leg, shaped rather than left as one enormous interval. Each
        // anchor sits a fixed fraction of the previous distance from the Sun, so
        // the Sun grows by the same factor over each equal slice of scroll.
        const sunStart = Math.abs(this.featureF[last] ?? 0);
        const sunFloor = SUN_LEG_FLOOR_RADII * SUN_RADIUS;
        if (sunStart > sunFloor) {
            const easeSpan = Math.exp(SUN_LEG_EASE) - 1;
            for (let k = 1; k < SUN_LEG_ANCHORS; k++) {
                const u = k / SUN_LEG_ANCHORS;
                const eased = (Math.exp(SUN_LEG_EASE * u) - 1) / easeSpan;
                anchorX.push(PLANET_SPAN + (1 - PLANET_SPAN) * u);
                anchorY.push(-sunStart * Math.pow(sunFloor / sunStart, eased));
            }
        }

        anchorX.push(1);
        anchorY.push(this.endF);
        this.pacing = new MonotoneCurve(anchorX, anchorY);

        // The weave is keyed on scroll progress, not on distance along the
        // corridor.
        //
        // Distance is badly behaved as a parameter here: the five planets sit
        // inside about three per cent of the route and the run to the Sun is all
        // the rest, so knots placed by distance are wildly uneven and the spline
        // through them swings hard between them. Progress spaces the knots
        // evenly by construction, and it is also the variable the viewer
        // actually moves through — so what is smooth in this parameter is what
        // looks smooth on screen.
        const weaveX = [0, ...stopX, 1];
        const weaveLateral = [0];
        const weaveRise = [0];
        for (let i = 0; i < STOPS.length; i++) {
            const stop = STOPS[i];
            const pass = this.passDistance(i);
            weaveLateral.push(-(stop?.side ?? 1) * SWING_FACTOR * pass);
            weaveRise.push((i % 2 === 0 ? 1 : -1) * RISE_FACTOR * pass);
        }
        weaveLateral.push(0);
        weaveRise.push(0);

        this.lateralPath = new NaturalSpline(weaveX, weaveLateral);
        this.risePath = new NaturalSpline(weaveX, weaveRise);

        // Sampled in the same parameter the spline is defined in, so the peak is
        // the real one. Sampling in distance previously missed it by orders of
        // magnitude, which left the bank permanently clamped and flipping sign.
        let peak = 0;
        let peakSlope = 0;
        for (let i = 0; i <= 600; i++) {
            const t = i / 600;
            peak = Math.max(peak, Math.abs(this.lateralPath.secondDerivative(t)));
            peakSlope = Math.max(peakSlope, Math.hypot(this.lateralPath.derivative(t), this.risePath.derivative(t)));
        }
        this.peakLateralAcceleration = peak > 0 ? peak : 1;

        let peakOffset = 0;
        for (let i = 0; i <= 600; i++) {
            peakOffset = Math.max(peakOffset, Math.abs(this.lateralPath.at(i / 600)));
        }
        this.peakLateral = peakOffset;
        this.headingReference = peakSlope > 0 ? peakSlope / Math.tan(MAX_HEADING_SWING) : 1;

        // Last, because solving a placement needs the finished corridor to
        // measure against.
        this.stopPositions = this.solveStopPositions();
    }

    passDistance(index: number): number {
        return this.passDistances[index] ?? 0;
    }

    /** A point on the flight path at scroll position `p` (0..1), relative to the Sun. */
    point(p: number): Vector3 {
        return this.forward
            .scale(this.distanceAt(p))
            .add(this.lateral.scale(this.lateralPath.at(p)))
            .add(UP.scale(this.risePath.at(p)));
    }

    /**
     * Direction of travel at `f`.
     *
     * Differentiated analytically rather than sampled, so it stays exact at every
     * scale — the arcs here span anything from tens of thousands to billions of
     * metres, and a fixed finite-difference step cannot serve both ends.
     */
    tangent(p: number): Vector3 {
        return this.forward
            .scale(this.headingReference)
            .add(this.lateral.scale(this.lateralPath.derivative(p)))
            .add(UP.scale(this.risePath.derivative(p)))
            .normalize();
    }

    /**
     * Bank angle at `f`, in radians.
     *
     * A coordinated turn banks so that lift balances the lateral acceleration:
     * tan(phi) = a_lateral / g. There is no gravity out here, so there is no
     * absolute scale for that ratio — but the shape of it still governs how a
     * turn reads. Taking bank as proportional to the path's own lateral
     * acceleration, normalised to the sharpest turn on the whole route, keeps
     * that relationship while bounding the roll to something watchable. Because
     * the path is C2, lateral acceleration is continuous, so the bank never steps.
     */
    bank(p: number): number {
        // Averaged over a small window rather than read pointwise.
        //
        // A cubic spline's second derivative is piecewise linear, so it has a
        // corner at every waypoint — continuous, but with a kink the eye reads
        // as the roll catching. Averaging across the corner removes it and costs
        // nothing but four extra evaluations.
        const w = BANK_SMOOTHING;
        const a = this.lateralPath.secondDerivative(p - w);
        const b = this.lateralPath.secondDerivative(p - w / 2);
        const c = this.lateralPath.secondDerivative(p);
        const d = this.lateralPath.secondDerivative(p + w / 2);
        const e = this.lateralPath.secondDerivative(p + w);
        const smoothed = (a + 2 * b + 3 * c + 2 * d + e) / 9;
        return BANK_MAX * clampUnit(smoothed / this.peakLateralAcceleration);
    }

    /**
     * Where the companion star sits: well behind the start of the flight, off to
     * one side and a little above the plane.
     *
     * Ahead and far off to one side — not behind the camera.
     *
     * Behind the camera it becomes a frontal fill: the planets light up flat and
     * lose the silhouette entirely, which is the whole character of flying
     * sunward. Ahead and to the side it back-lights like the Sun does, only from
     * a different angle and a different colour, so each body keeps its dark face
     * and picks up a second cool rim on the opposite limb from the Sun's warm one.
     */
    companionPosition(): Vector3 {
        const span = Math.abs(this.endF - this.startF);
        return this.point(0)
            .add(this.forward.scale(COMPANION_AHEAD * span))
            .add(this.lateral.scale(-COMPANION_SIDE * span))
            .add(UP.scale(COMPANION_RISE * span));
    }

    /** Length of the whole route, the unit everything large is measured in. */
    routeSpan(): number {
        return Math.abs(this.endF - this.startF);
    }

    /**
     * A point in the corridor's own frame, given offsets as fractions of the
     * route. Used to place things that are not on the flight path — the
     * companion star and the nebulae.
     */
    offsetPoint(ahead: number, side: number, rise: number): Vector3 {
        const span = this.routeSpan();
        return this.forward
            .scale(ahead * span)
            .add(this.lateral.scale(side * span))
            .add(UP.scale(rise * span));
    }

    /** Scroll position at which a stop is framed. Anchors are evenly spaced by construction. */
    stopProgress(index: number): number {
        return (PLANET_SPAN * (index + 1)) / STOPS.length;
    }

    /**
     * Where a stop's body must sit to be framed as the flight reaches its anchor.
     *
     * Ahead as well as to the side. Placed purely abeam, a body sits at ninety
     * degrees to the direction of travel the moment it is meant to be looked at,
     * which puts it outside the frame of anything flying forwards. Set ahead by
     * the approach factor it reads at a comfortable angle off the nose and then
     * sweeps past — and that sweep is the fly-by.
     */
    stopPosition(index: number): Vector3 {
        return (this.stopPositions[index] ?? Vector3.Zero()).clone();
    }

    /**
     * Where a body lands for a given offset multiplier.
     *
     * Both components scale together, on purpose. Stretching only the sideways
     * one moves the body further off the flight axis as well as further away,
     * and past about twenty-five degrees off axis it leaves the frame entirely —
     * the pass distance comes out right and the body is never seen. Scaling the
     * whole offset changes how far away it is while holding the bearing, so the
     * shot stays composed exactly as authored.
     */
    private placeStop(index: number, scale: number): Vector3 {
        const stop = STOPS[index];
        if (stop === undefined) return Vector3.Zero();
        const pass = this.passDistance(index) * scale;
        return this.point(this.stopProgress(index))
            .add(this.forward.scale(this.approachFactor * pass))
            .add(this.lateral.scale(stop.side * pass));
    }

    /** Nearest the corridor ever comes to a point, searched around a guess. */
    private closestApproach(target: Vector3, guess: number): number {
        let best = Number.POSITIVE_INFINITY;
        let at = guess;
        for (let k = 0; k <= 48; k++) {
            const p = Math.min(1, Math.max(0, guess - 0.05 + (0.14 * k) / 48));
            const d = Vector3.Distance(this.point(p), target);
            if (d < best) {
                best = d;
                at = p;
            }
        }
        // Refine around the best sample; the corridor is smooth here, so a few
        // bisections are plenty.
        let span = 0.14 / 48;
        for (let k = 0; k < 24; k++) {
            span *= 0.6;
            for (const p of [at - span, at + span]) {
                const clamped = Math.min(1, Math.max(0, p));
                const d = Vector3.Distance(this.point(clamped), target);
                if (d < best) {
                    best = d;
                    at = clamped;
                }
            }
        }
        return best;
    }

    /**
     * Solves each body's sideways offset so its authored pass distance is the
     * distance the camera actually achieves.
     *
     * Offsetting from the path point at a body's own stop progress silently
     * assumes the corridor is straight there. It is not: the weave's amplitude
     * is a multiple of each pass distance, and those differ thirtyfold from Mars
     * to Saturn, so the spline through them overshoots between knots. Measured on
     * the assumed placement, Neptune's closest approach came out at 1.27 radii —
     * 76 degrees of frame — against the 3.6 radii authored, while Jupiter sat
     * half again too far out. Bodies were arriving at sizes nobody had chosen.
     *
     * Rather than hand-tune around the overshoot, each offset is corrected by how
     * far the achieved approach missed the intended one. Two or three passes
     * converge because moving a body sideways changes its closest approach almost
     * proportionally.
     */
    private solveStopPositions(): Array<Vector3> {
        return STOPS.map((_, i) => {
            const target = this.passDistance(i);
            let scale = 1;
            let position = this.placeStop(i, scale);
            if (target <= 0) return position;
            for (let iteration = 0; iteration < 12; iteration++) {
                const achieved = this.closestApproach(position, this.stopProgress(i));
                if (!Number.isFinite(achieved) || achieved <= 0) break;
                const correction = target / achieved;
                if (Math.abs(correction - 1) < 0.01) break;
                // Damped, and bounded overall. Moving a body also moves it along
                // the corridor, into a stretch where the weave sits differently,
                // so a full-size step overshoots and the iteration rings instead
                // of settling — Saturn, whose offsets are the largest, ended up
                // three times too far out that way.
                scale = Math.min(4, Math.max(0.25, scale * Math.pow(correction, 0.55)));
                position = this.placeStop(i, scale);
            }
            return position;
        });
    }

    /**
     * The flight's own sideways position at `p`, normalised to −1..1.
     *
     * Continuous by construction, unlike the per-body side signal, which is zero
     * between bodies and saturates at each — anything driven by that swings out
     * and then waits, which reads as a pendulum rather than as flying. The weave
     * also already leans away from whichever body is coming up, so following it
     * keeps the clearance for free.
     */
    weaveOffset(p: number): number {
        const peak = this.peakLateral;
        if (peak <= 0) return 0;
        return clampUnit(this.lateralPath.at(Math.min(1, Math.max(0, p))) / peak);
    }

    /**
     * Where the flight is pointing relative to the corridor axis, −1..1.
     *
     * A *position*, not a rate. Anything driven by a measured turn rate inherits
     * that rate's noise — it is a frame-to-frame difference, and it spikes every
     * time the page jumps a scroll step, which no amount of low-passing fully
     * removes. This comes straight off the spline, so it is smooth by
     * construction and still says exactly what the camera is doing.
     */
    headingOffset(p: number): number {
        const t = this.tangent(Math.min(1, Math.max(0, p)));
        const heading = Math.atan2(Vector3.Dot(t, this.lateral), Vector3.Dot(t, this.forward));
        return clampUnit(heading / MAX_HEADING_SWING);
    }

    /** Distance along the corridor for a scroll position in 0..1. */
    distanceAt(progress: number): number {
        const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
        return this.pacing.at(p);
    }

    /** How completely the Sun has swallowed the frame, 0..1. */
    whiteout(p: number): number {
        const radii = Math.abs(this.distanceAt(p)) / SUN_RADIUS;
        const t = (WHITEOUT_START_RADII - radii) / (WHITEOUT_START_RADII - WHITEOUT_FULL_RADII);
        const x = Math.min(1, Math.max(0, t));
        return x * x * (3 - 2 * x);
    }

    /**
     * The stop currently dominating the frame, with how strongly, in 0..1.
     *
     * Measured in scroll, so every body gets the same share of attention no
     * matter how far apart they are in space.
     */
    /**
     * Influence of every stop at `p`, rather than only the nearest.
     *
     * Picking a single nearest body means that halfway between two planets the
     * choice flips — and because both still carry roughly half weight there, the
     * camera's look target jumps from one planet to the other in one frame. That
     * is the intermittent break. Blending all of them removes the switch
     * entirely: there is nothing to flip between.
     */
    stopWeights(p: number): Array<number> {
        return STOPS.map((_, i) => {
            const w = 1 - Math.abs(p - this.stopProgress(i)) / GLANCE_SPAN_PROGRESS;
            return Math.min(1, Math.max(0, w));
        });
    }

    /**
     * Which side the bodies in range lie on, blended, in −1..1.
     *
     * Weighted rather than picked, for the same reason the glance is: choosing
     * the nearest body makes this flip at the midpoint between two, and anything
     * driven by it would jump. Zero between passes, easing toward one side as a
     * body comes up.
     */
    weightedSide(p: number): number {
        const weights = this.stopWeights(p);
        let sum = 0;
        let total = 0;
        for (let i = 0; i < weights.length; i++) {
            const w = weights[i] ?? 0;
            if (w <= 0) continue;
            sum += w * (STOPS[i]?.side ?? 0);
            total += w;
        }
        return total > 0 ? sum / total : 0;
    }

    dominantStop(p: number): { index: number; weight: number } {
        const span = GLANCE_SPAN_PROGRESS;
        let index = 0;
        let weight = 0;
        for (let i = 0; i < STOPS.length; i++) {
            const w = 1 - Math.abs(p - this.stopProgress(i)) / span;
            if (w > weight) {
                weight = w;
                index = i;
            }
        }
        return { index, weight: Math.min(1, Math.max(0, weight)) };
    }
}

function clampUnit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(-1, value));
}

/**
 * Natural cubic spline: continuous value, slope *and* curvature.
 *
 * C2 continuity is the whole point. A curve that is only C1 has a step in its
 * acceleration at every waypoint, and although the path looks smooth on paper,
 * a camera flying it lurches at each join — which is exactly what "not natural"
 * felt like. With continuous curvature the lateral acceleration, and therefore
 * the bank, eases through every turn instead of snapping into it.
 */
export class NaturalSpline {
    private readonly xs: ReadonlyArray<number>;
    private readonly ys: ReadonlyArray<number>;
    private readonly m: ReadonlyArray<number>;

    constructor(xs: Array<number>, ys: Array<number>) {
        this.xs = xs;
        this.ys = ys;
        const n = xs.length;
        const m = new Array<number>(n).fill(0);

        if (n > 2) {
            // Solve the tridiagonal system for second derivatives, natural ends (m0 = mn = 0).
            const h = new Array<number>(n - 1).fill(0);
            for (let i = 0; i < n - 1; i++) h[i] = (xs[i + 1] ?? 0) - (xs[i] ?? 0);

            const alpha = new Array<number>(n).fill(0);
            for (let i = 1; i < n - 1; i++) {
                const hPrev = h[i - 1] ?? 1;
                const hCur = h[i] ?? 1;
                alpha[i] =
                    (6 / (hPrev + hCur)) *
                    (((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / hCur - ((ys[i] ?? 0) - (ys[i - 1] ?? 0)) / hPrev);
            }

            const c = new Array<number>(n).fill(0);
            const d = new Array<number>(n).fill(0);
            for (let i = 1; i < n - 1; i++) {
                const hPrev = h[i - 1] ?? 1;
                const hCur = h[i] ?? 1;
                const mu = hPrev / (hPrev + hCur);
                const lambda = hCur / (hPrev + hCur);
                const denom = 2 + mu * (c[i - 1] ?? 0);
                c[i] = -lambda / denom;
                d[i] = ((alpha[i] ?? 0) - mu * (d[i - 1] ?? 0)) / denom;
            }
            for (let i = n - 2; i >= 1; i--) {
                m[i] = (c[i] ?? 0) * (m[i + 1] ?? 0) + (d[i] ?? 0);
            }
        }
        this.m = m;
    }

    private segment(x: number): { i: number; h: number; a: number; b: number } {
        const n = this.xs.length;
        let i = 0;
        while (i < n - 2 && x > (this.xs[i + 1] ?? 0)) i++;
        const x0 = this.xs[i] ?? 0;
        const x1 = this.xs[i + 1] ?? 1;
        const h = x1 - x0 || 1;
        return { i, h, a: (x1 - x) / h, b: (x - x0) / h };
    }

    at(x: number): number {
        const { i, h, a, b } = this.segment(x);
        const y0 = this.ys[i] ?? 0;
        const y1 = this.ys[i + 1] ?? 0;
        const m0 = this.m[i] ?? 0;
        const m1 = this.m[i + 1] ?? 0;
        return a * y0 + b * y1 + (((a * a * a - a) * m0 + (b * b * b - b) * m1) * h * h) / 6;
    }

    derivative(x: number): number {
        const { i, h, a, b } = this.segment(x);
        const y0 = this.ys[i] ?? 0;
        const y1 = this.ys[i + 1] ?? 0;
        const m0 = this.m[i] ?? 0;
        const m1 = this.m[i + 1] ?? 0;
        return (y1 - y0) / h + (((3 * b * b - 1) * m1 - (3 * a * a - 1) * m0) * h) / 6;
    }

    secondDerivative(x: number): number {
        const { i, a, b } = this.segment(x);
        return a * (this.m[i] ?? 0) + b * (this.m[i + 1] ?? 0);
    }
}

/**
 * Monotone cubic interpolation (Fritsch-Carlson).
 *
 * Scroll cannot map linearly to distance: the final approach to the Sun is
 * longer than the whole rest of the corridor, so a linear map would spend the
 * entire page crossing empty space and flick past the planets inside a single
 * frame. Anchoring each stop to an equal share of scroll and interpolating
 * monotonically gives roughly constant *angular* speed, which is what reads as
 * steady flight. Monotone specifically — an ordinary spline overshoots between
 * anchors, which here would fly the camera backwards.
 */
export class MonotoneCurve {
    private readonly xs: ReadonlyArray<number>;
    private readonly ys: ReadonlyArray<number>;
    private readonly slopes: ReadonlyArray<number>;

    constructor(xs: Array<number>, ys: Array<number>) {
        this.xs = xs;
        this.ys = ys;

        const n = xs.length;
        const h = new Array<number>(Math.max(0, n - 1)).fill(0);
        const delta = new Array<number>(Math.max(0, n - 1)).fill(0);
        for (let i = 0; i < n - 1; i++) {
            const step = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
            h[i] = step;
            delta[i] = step === 0 ? 0 : ((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / step;
        }

        const d = new Array<number>(n).fill(0);
        d[0] = delta[0] ?? 0;
        d[n - 1] = delta[n - 2] ?? 0;
        for (let i = 1; i < n - 1; i++) {
            const a = delta[i - 1] ?? 0;
            const b = delta[i] ?? 0;
            if (a * b <= 0) {
                d[i] = 0;
            } else {
                const h1 = h[i - 1] ?? 1;
                const h2 = h[i] ?? 1;
                const w1 = 2 * h2 + h1;
                const w2 = h2 + 2 * h1;
                d[i] = (w1 + w2) / (w1 / a + w2 / b);
            }
        }
        this.slopes = d;
    }

    /** dY/dX at x — needed because the camera's speed along the corridor is not constant. */
    derivative(x: number): number {
        const n = this.xs.length;
        if (n < 2) return 0;
        const first = this.xs[0] ?? 0;
        const last = this.xs[n - 1] ?? 0;
        const xc = Math.min(last, Math.max(first, x));

        let i = 0;
        while (i < n - 2 && xc > (this.xs[i + 1] ?? 0)) i++;

        const x0 = this.xs[i] ?? 0;
        const x1 = this.xs[i + 1] ?? 0;
        const y0 = this.ys[i] ?? 0;
        const y1 = this.ys[i + 1] ?? 0;
        const d0 = this.slopes[i] ?? 0;
        const d1 = this.slopes[i + 1] ?? 0;

        const h = x1 - x0;
        if (h === 0) return 0;
        const t = (xc - x0) / h;
        const t2 = t * t;
        return ((6 * t2 - 6 * t) * y0 + (-6 * t2 + 6 * t) * y1) / h + (3 * t2 - 4 * t + 1) * d0 + (3 * t2 - 2 * t) * d1;
    }

    at(x: number): number {
        const n = this.xs.length;
        if (n === 0) return 0;
        if (x <= (this.xs[0] ?? 0)) return this.ys[0] ?? 0;
        if (x >= (this.xs[n - 1] ?? 0)) return this.ys[n - 1] ?? 0;

        let i = 0;
        while (i < n - 2 && x > (this.xs[i + 1] ?? 0)) i++;

        const x0 = this.xs[i] ?? 0;
        const x1 = this.xs[i + 1] ?? 0;
        const y0 = this.ys[i] ?? 0;
        const y1 = this.ys[i + 1] ?? 0;
        const d0 = this.slopes[i] ?? 0;
        const d1 = this.slopes[i + 1] ?? 0;

        const hh = x1 - x0;
        const t = hh === 0 ? 0 : (x - x0) / hh;
        const t2 = t * t;
        const t3 = t2 * t;

        return (
            (2 * t3 - 3 * t2 + 1) * y0 +
            (t3 - 2 * t2 + t) * hh * d0 +
            (-2 * t3 + 3 * t2) * y1 +
            (t3 - t2) * hh * d1
        );
    }
}
