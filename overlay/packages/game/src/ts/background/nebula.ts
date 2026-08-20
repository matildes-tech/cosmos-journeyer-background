//  A second nebula, with a place in the world rather than a place in the sky.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import { Constants } from "@babylonjs/core/Engines/constants";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { type Mesh } from "@babylonjs/core/Meshes/mesh";
import { type Scene } from "@babylonjs/core/scene";

const SHADER_NAME = "flightNebula";

/**
 * Marched inside a sphere, in the sphere's own local space.
 *
 * Local space is the point: the scene runs at solar-system scale under a
 * floating origin, and a density field sampled from coordinates of that size
 * would be destroyed by float precision before it produced any structure.
 * Normalised to the sphere's radius, the field is sampled around unit scale
 * however far from the origin the nebula actually sits.
 */
const FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vLocal;

uniform vec3 uCameraLocal;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uDensity;
uniform float uIntensity;
uniform float uTime;
uniform float uSeed;
uniform float uSteps;

const int MAX_STEPS = 16;

float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
        mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
        mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
        f.z);
}

float fbm(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 4; octave++) {
        total += amplitude * valueNoise(p);
        p *= 2.03;
        amplitude *= 0.5;
    }
    return total;
}

void main(void) {
    // Intersect the unit sphere analytically rather than trusting which face was
    // rasterised. With culling off the near face is drawn too, and a ray that
    // stops at the fragment never enters the volume at all — the cloud simply
    // does not render. Solving for entry and exit works from outside and from
    // within, so flying into it keeps working.
    vec3 rayDir = normalize(vLocal - uCameraLocal);
    float b = dot(uCameraLocal, rayDir);
    float c = dot(uCameraLocal, uCameraLocal) - 1.0;
    float disc = b * b - c;
    if (disc <= 0.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    float rootDisc = sqrt(disc);
    float tNear = max(-b - rootDisc, 0.0);
    float tFar = -b + rootDisc;
    if (tFar <= tNear) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    // Step count is per-cloud: a small, distant nebula covers few pixels and
    // needs far less marching than one filling the frame. The loop bound stays
    // constant for portability; the break does the work.
    float stepSize = (tFar - tNear) / uSteps;

    vec3 accumulated = vec3(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < MAX_STEPS; i++) {
        if (float(i) >= uSteps) break;
        vec3 probe = uCameraLocal + rayDir * (tNear + stepSize * (float(i) + 0.5));

        // Only inside the unit sphere, and fading well before its shell so the
        // nebula has no visible edge to give itself away as geometry.
        float envelope = smoothstep(1.0, 0.35, length(probe));

        float shape = fbm(probe * 2.1 + uSeed);
        shape = smoothstep(0.42, 0.95, shape) * envelope;
        if (shape <= 0.001) continue;

        float wisp = fbm(probe * 6.5 - uSeed * 0.5);
        float density = shape * (0.55 + 0.75 * wisp) * uDensity;

        // Two-tone: the denser cores take the second colour, so the cloud has
        // internal structure instead of one flat wash.
        vec3 tint = mix(uColorA, uColorB, clamp(wisp * 1.35, 0.0, 1.0));

        float absorbed = density * stepSize;
        accumulated += tint * absorbed * transmittance;
        transmittance *= 1.0 - clamp(absorbed * 0.85, 0.0, 1.0);
        // Give up early on a ray that is already saturated: with two clouds on
        // screen the march is the frame's dominant cost, and the last steps of a
        // dense ray change nothing visible.
        if (transmittance < 0.08) break;
    }

    vec3 color = accumulated * uIntensity;
    // Per-pixel dither: without it the faint outer falloff bands badly on dark.
    color += (hash13(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
}
`;

const VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vLocal;

void main(void) {
    vLocal = position;
    gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

export interface NebulaOptions {
    /** Radius in metres. */
    readonly radius: number;
    readonly colorA: Color3;
    readonly colorB: Color3;
    readonly density?: number;
    readonly intensity?: number;
    readonly seed?: number;
    /** March steps, up to 16. Fewer for clouds that stay small on screen. */
    readonly steps?: number;
}

/**
 * A nebula you can fly toward.
 *
 * Unlike the Milky Way — a cubemap at infinity, which no amount of travel can
 * approach — this one occupies a position in the system, so closing on it makes
 * it grow. It is additive and writes no depth, so it never occludes a planet;
 * it only ever adds light, the way a real emission nebula does.
 */
export class Nebula {
    private readonly mesh: Mesh;
    private readonly material: ShaderMaterial;
    private readonly inverseWorld = new Matrix();
    private readonly cameraLocal = Vector3.Zero();
    private elapsed = 0;

    constructor(scene: Scene, options: NebulaOptions) {
        Effect.ShadersStore[`${SHADER_NAME}VertexShader`] ??= VERTEX;
        Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] ??= FRAGMENT;

        // A unit sphere, scaled. The shader marches in units of the radius, so
        // letting the world matrix carry the scale keeps the field sampled around
        // unit magnitude no matter how large the nebula actually is.
        this.mesh = MeshBuilder.CreateSphere("flightNebula", { diameter: 2, segments: 16 }, scene);
        this.mesh.scaling.setAll(options.radius);
        this.mesh.isPickable = false;
        this.mesh.alwaysSelectAsActiveMesh = true;
        // Drawn from the inside faces, so flying into it keeps working.
        this.mesh.material = null;
        this.mesh.infiniteDistance = false;

        this.material = new ShaderMaterial(
            "flightNebulaMaterial",
            scene,
            SHADER_NAME,
            {
                attributes: ["position"],
                uniforms: ["worldViewProjection", "uCameraLocal", "uColorA", "uColorB", "uDensity", "uIntensity", "uTime", "uSeed", "uSteps"],
            },
        );
        this.material.backFaceCulling = false;
        this.material.alphaMode = Constants.ALPHA_ADD;
        this.material.disableDepthWrite = true;
        // Babylon decides a material is transparent from its alpha, not from its
        // blend mode. Left at 1 this drew in the opaque pass with depth writes on
        // and punched a black disc through the sky. Below 1 it joins the
        // transparent pass, where it adds light and occludes nothing — while the
        // depth test still lets nearer planets pass in front of it.
        this.material.alpha = 0.999;
        this.material.needDepthPrePass = false;
        this.material.setColor3("uColorA", options.colorA);
        this.material.setColor3("uColorB", options.colorB);
        this.material.setFloat("uDensity", options.density ?? 1.0);
        this.material.setFloat("uIntensity", options.intensity ?? 1.0);
        this.material.setFloat("uSeed", options.seed ?? 3.7);
        this.material.setFloat("uSteps", Math.max(4, Math.min(16, options.steps ?? 16)));
        this.material.setFloat("uTime", 0);
        this.mesh.material = this.material;

        // Behind everything solid: it adds light, it never hides anything.
        this.mesh.renderingGroupId = 0;
    }

    /**
     * @param centre Absolute world position of the nebula this frame — it must be
     *   rebased every frame, because the floating origin moves the whole world.
     */
    update(centre: Vector3, cameraPosition: Vector3, deltaSeconds: number): void {
        this.elapsed += deltaSeconds;
        this.mesh.setAbsolutePosition(centre);
        this.mesh.computeWorldMatrix(true);

        this.mesh.getWorldMatrix().invertToRef(this.inverseWorld);
        // Includes the scale, so this lands in the same unit space the shader marches.
        Vector3.TransformCoordinatesToRef(cameraPosition, this.inverseWorld, this.cameraLocal);

        this.material.setVector3("uCameraLocal", this.cameraLocal);
        this.material.setFloat("uTime", this.elapsed);
    }

    dispose(): void {
        this.mesh.dispose();
        this.material.dispose();
    }
}
