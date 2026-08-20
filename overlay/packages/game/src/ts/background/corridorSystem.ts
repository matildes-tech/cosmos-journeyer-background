//  The Vesta system, re-laid-out along a straight flight corridor.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { StarSystemModel } from "@cosmos-journeyer/universe-model";

import { getSolSystemModel } from "@/backend/universe/customSystems/sol/sol";

import { STOPS, type CorridorLayout } from "./corridor";

/** Bodies not on the corridor are dropped, so nothing drifts through the shot unplanned. */
/**
 * Kept even though the corridor never frames them. The Moon stays because it is
 * Earth's, and it orbits Earth rather than the Sun — removing it would be a
 * change to the solar system, not to the flight path.
 */
const KEEP_OFF_CORRIDOR: ReadonlyArray<string> = ["moon"];

/**
 * Sets orbital elements that put a body at an exact point in space.
 *
 * Cosmos Journeyer composes an orbit as Ry(ascendingNode) · Rz(inclination) ·
 * Ry(argumentOfPeriapsis) applied to a point on the ellipse. Taking a circular
 * orbit with both the periapsis argument and the anomaly at zero, that reduces
 * to (a·cos i·cos O, a·sin i, −a·cos i·sin O), which inverts in closed form.
 *
 * The earlier version pinned inclination to zero, which silently flattened any
 * height out of the target — harmless while the path stayed near the ecliptic,
 * and badly wrong once it began climbing, because every body then landed
 * somewhere the camera never flies past.
 */
function placeAt(orbit: MutableOrbit, target: Vector3): void {
    const a = target.length();
    orbit.semiMajorAxis = a;
    orbit.eccentricity = 0;
    orbit.p = 2;
    orbit.argumentOfPeriapsis = 0;
    orbit.initialMeanAnomaly = 0;
    if (a <= 0) {
        orbit.inclination = 0;
        orbit.longitudeOfAscendingNode = 0;
        return;
    }
    orbit.inclination = Math.asin(Math.min(1, Math.max(-1, target.y / a)));
    orbit.longitudeOfAscendingNode = Math.atan2(-target.z, target.x);
}

interface MutableOrbit {
    parentIds: Array<string>;
    argumentOfPeriapsis: number;
    semiMajorAxis: number;
    initialMeanAnomaly: number;
    longitudeOfAscendingNode: number;
    inclination: number;
    eccentricity: number;
    p: number;
}

interface MutableBody {
    id: string;
    name?: string;
    mass: number;
    orbit: MutableOrbit;
}

/**
 * Rewrites the Sol system so every body the flight passes lies on the corridor.
 *
 * The bodies are moved by authoring their orbital elements, not by overriding
 * their transforms each frame. That keeps Cosmos Journeyer's own Keplerian
 * simulation in charge — the bodies still orbit, still rotate, still light and
 * shadow each other — and it means nothing has to fight the engine for control
 * of a position every frame.
 *
 * The arithmetic is simple because of how their orbit code composes: for a
 * circular orbit with zero inclination and zero argument of periapsis, the
 * position at t=0 is just (a·cos M₀, 0, a·sin M₀). So a target point in the
 * ecliptic plane is reached with a = |P| and M₀ = atan2(P.z, P.x).
 *
 * Orbital periods at these radii are months to years, so the layout holds still
 * for any realistic visit while never actually being frozen.
 */
export function getCorridorSystemModel(layout: CorridorLayout): StarSystemModel {
    const model = structuredClone(getSolSystemModel()) as unknown as {
        stellarObjects: Array<MutableBody>;
        planets: Array<MutableBody>;
        satellites: Array<MutableBody>;
        orbitalFacilities: Array<MutableBody>;
        anomalies: Array<MutableBody>;
    };

    const star = model.stellarObjects[0];
    if (star === undefined) {
        throw new Error("Sol has no stellar object to anchor the corridor on");
    }

    // Slow the orbits right down.
    //
    // At these radii the planets complete an orbit in weeks, which sounds slow
    // until you notice Mars drifts further in a couple of minutes than its
    // entire closest-approach distance — a page left open loses its framing.
    // Orbital period goes as 1/sqrt(parent mass), so cutting the Sun's mass by
    // ten thousand makes every period a hundred times longer and the layout
    // effectively still. Nothing visible depends on this number: the Sun's
    // appearance comes from its radius and temperature, and the planets keep
    // spinning on their axes, which is rotation, not orbit.
    star.mass *= 1e-4;

    const onCorridor = new Set(STOPS.map((s) => s.objectId));

    const place = (body: MutableBody): boolean => {
        if (KEEP_OFF_CORRIDOR.includes(body.id)) {
            return false;
        }
        const index = STOPS.findIndex((s) => s.objectId === body.id);
        if (index < 0) {
            return false;
        }
        // The star defines the origin the corridor is measured against, so it is
        // the one body that must not be moved.
        if (body.id === star.id) {
            return true;
        }

        const target = layout.stopPosition(index);

        body.orbit.parentIds = [star.id];
        placeAt(body.orbit, target);
        return true;
    };

    const prune = (bodies: Array<MutableBody>): Array<MutableBody> =>
        bodies.filter((body) => {
            const placed = place(body);
            return placed || onCorridor.has(body.id) || KEEP_OFF_CORRIDOR.includes(body.id);
        });

    // A second sun, over the ship's shoulder.
    //
    // Cosmos Journeyer lights bodies only from registered stellar objects — its
    // planet shaders take a list of them, so an ordinary Babylon light added to
    // the scene would do nothing. Adding a star to the system model instead goes
    // through their own pipeline and simply works. Hot and blue rather than a
    // second yellow sun, so the fill reads as a different source and the frames
    // gain a cool/warm split instead of going flat.
    const companionAt = layout.companionPosition();
    const companion = structuredClone(star) as MutableBody & Record<string, unknown>;
    companion.id = "companion";
    companion.name = "Companion";
    companion['radius'] = (star as unknown as { radius: number }).radius * 2.4;
    companion['blackBodyTemperature'] = 11_000;
    companion.mass = star.mass;
    companion.orbit.parentIds = [star.id];
    placeAt(companion.orbit, companionAt);
    model.stellarObjects.push(companion as unknown as MutableBody);

    model.planets = prune(model.planets);
    model.satellites = prune(model.satellites);
    model.orbitalFacilities = prune(model.orbitalFacilities);
    model.anomalies = prune(model.anomalies);
    model.stellarObjects.forEach(place);

    return model as unknown as StarSystemModel;
}
