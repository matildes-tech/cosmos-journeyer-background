//  Builds Cosmos Journeyer's star system as a page background.
//
//  Cosmos Journeyer is licensed AGPL-3.0-only; this file is part of a derived
//  work and carries the same licence.

import "@babylonjs/core/Physics/physicsEngineComponent";

import { type AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { Scene } from "@babylonjs/core/scene";
import HavokPhysics from "@babylonjs/havok";

import { EncyclopaediaGalacticaManager } from "@/backend/encyclopaedia/encyclopaediaGalacticaManager";

import { UniverseBackend } from "@/backend/universe/universeBackend";

import { type ILoadingProgressMonitor } from "@/frontend/assets/loadingProgressMonitor";
import { loadRenderingAssets } from "@/frontend/assets/renderingAssets";
import { SoundPlayerMock } from "@/frontend/audio/soundPlayer";
import { TtsMock } from "@/frontend/audio/tts";
import { Player } from "@/frontend/player/player";
import { StarSystemView } from "@/frontend/starSystemView";
import { NotificationManagerMock, type INotificationManager } from "@/frontend/ui/notificationManager";
import { ChunkForgeWorkers } from "@/frontend/universe/planets/telluricPlanet/terrain/chunks/chunkForgeWorkers";

import { getPhysicsEngineV2 } from "@/utils/physicsEngineV2";

import { type CorridorLayout } from "./corridor";
import { getCorridorSystemModel } from "./corridorSystem";

import { initI18n } from "@/i18n";
import { Settings } from "@/settings";

export interface UniverseBackground {
    readonly scene: Scene;
    readonly starSystemView: StarSystemView;
}

/**
 * Removes the game's UI containers from document flow.
 *
 * They are already hidden through Cosmos Journeyer's own switches; this only
 * stops them contributing document height. Anything appended to <body> while the
 * scene was being built belongs to the game, so this needs no knowledge of which
 * elements those are.
 */
function takeGameUiOutOfFlow(existingBefore: ReadonlySet<Element>): void {
    for (const element of Array.from(document.body.children)) {
        if (existingBefore.has(element) || !(element instanceof HTMLElement)) {
            continue;
        }
        element.style.position = "fixed";
        element.style.top = "0";
        element.style.left = "0";
        element.style.pointerEvents = "none";
    }
}

/**
 * Creates the scene the page sits on top of.
 *
 * This is deliberately the same construction Cosmos Journeyer's own main menu
 * performs — the Vesta system, their assets, their post-processing — with the
 * game shell left out rather than torn down: no ship, no HUD, no menu, no
 * target cursors. Nothing about the 3D scene itself is modified, so what renders
 * is what renders on their site.
 *
 * The audio, TTS and notification mocks are Cosmos Journeyer's own; they are the
 * supported way to run a star system without the game's services attached.
 */
export async function createUniverseBackground(
    engine: AbstractEngine,
    progressMonitor: ILoadingProgressMonitor,
    layout: CorridorLayout,
): Promise<UniverseBackground> {
    await initI18n();

    // Cosmos Journeyer appends its UI containers straight to <body>, and relies
    // on the game's own stylesheet to take them out of flow. This page does not
    // load that stylesheet, so they would sit in normal flow and add thousands
    // of pixels of document height — which silently desynchronises scroll
    // position from the camera. Snapshotting first lets us neutralise whatever
    // it adds without hardcoding element ids that change between versions.
    const bodyChildrenBefore = new Set(Array.from(document.body.children));

    const systemModel = getCorridorSystemModel(layout);
    const universeBackend = new UniverseBackend(systemModel);
    const player = Player.Default(universeBackend);

    const encyclopaedia = new EncyclopaediaGalacticaManager();
    const soundPlayer = new SoundPlayerMock();
    const tts = new TtsMock();
    const notificationManager: INotificationManager = new NotificationManagerMock();

    // Floating origin is what makes a star system survive float32: the world
    // re-centres on the camera instead of letting coordinates grow past precision.
    const scene = new Scene(engine, { useFloatingOrigin: true });
    scene.useRightHandedSystem = true;
    scene.clearColor.set(0, 0, 0, 1);

    const havokPlugin = new HavokPlugin(true, await HavokPhysics());
    havokPlugin.setVelocityLimits(10_000, 10_000);
    scene.enablePhysics(Vector3.Zero(), havokPlugin);
    const physicsEngine = getPhysicsEngineV2(scene);

    const assets = await loadRenderingAssets(scene, progressMonitor);

    // Coarser terrain, and less of it.
    //
    // Cosmos Journeyer builds planet surfaces in chunks as the camera moves,
    // which is why the frame rate halved the moment the page was scrolled and
    // recovered whenever it stopped. That detail exists so you can land on a
    // planet; this flight never gets nearer than fifteen radii, where a 64-vertex
    // chunk and a 16-vertex chunk are the same handful of pixels.
    Settings.VERTEX_RESOLUTION = 16;
    Settings.CHUNK_RENDERING_DISTANCE_MULTIPLIER = 1;

    const chunkForgeResult = await ChunkForgeWorkers.New(Settings.VERTEX_RESOLUTION);
    if (!chunkForgeResult.success) {
        throw chunkForgeResult.error;
    }

    const starSystemView = new StarSystemView(
        scene,
        player,
        engine,
        physicsEngine,
        encyclopaedia,
        universeBackend,
        soundPlayer,
        tts,
        notificationManager,
        assets,
        chunkForgeResult.value,
        progressMonitor,
    );

    await starSystemView.resetPlayer(player);

    // Their own switches for the game layer, used rather than reaching into the DOM.
    starSystemView.setUIEnabled(false);

    await starSystemView.loadStarSystem(universeBackend.fallbackSystem);
    starSystemView.initStarSystem(0);

    // The free camera, not the spaceship: nothing should fly the ship here, and
    // the timeline needs a transform it can write to directly.
    await starSystemView.switchToDefaultControls(false);

    starSystemView.hideHtmlUI();
    starSystemView.targetCursorLayer.setEnabled(false);

    takeGameUiOutOfFlow(bodyChildrenBefore);

    return { scene, starSystemView };
}
