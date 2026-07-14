import type { TeacherDataStatus } from "@/lib/teacherServerAccess";
import { classifyTeacherServerStatus } from "@/lib/teacherExamClient";
import {
    applyRosterTombstonesToSnapshot,
    loadRosterSnapshot,
    mergeRosterSnapshots,
    nextRosterTombstones,
    readLocalRosterSnapshot,
    readRosterTombstones,
    saveRosterSnapshot,
    writeLocalRosterSnapshot,
    writeRosterTombstones,
    type RosterLoadResult,
    type RosterPersistenceResult,
    type RosterSnapshot,
} from "@/lib/rosterPersistence";
import {
    loadTeacherRosterAction,
    saveTeacherRosterAction,
} from "@/app/actions/teacherRoster";

/**
 * Client-side wrapper over the teacher roster server actions (B3). Roster holds
 * the most sensitive rows (student PII), so the same fail-closed policy applies:
 * the org-scoped service-role boundary is primary; `degraded_local` keeps the
 * existing local + publishable path; `denied` reads/writes only the on-device
 * snapshot and never touches the publishable key.
 */

export interface LoadTeacherRosterDeps {
    server: () => Promise<{ status: string; snapshot?: RosterSnapshot }>;
    readLocal: () => RosterSnapshot;
    /** Apply tombstones + merge onto local + write local; returns the merged snapshot. */
    reconcileServer: (serverSnapshot: RosterSnapshot) => RosterSnapshot;
    /** Best-effort push of local-only rows back up. Returns whether it synced. */
    pushMerged: (merged: RosterSnapshot) => Promise<boolean>;
    loadExistingFull: () => Promise<RosterLoadResult>;
}

export async function loadTeacherRosterWithDeps(deps: LoadTeacherRosterDeps): Promise<RosterLoadResult> {
    let status = "degraded_local";
    let serverSnapshot: RosterSnapshot | undefined;
    try {
        const res = await deps.server();
        status = res.status;
        serverSnapshot = res.snapshot;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server" && serverSnapshot) {
        const merged = deps.reconcileServer(serverSnapshot);
        let remoteSynced = true;
        try {
            remoteSynced = await deps.pushMerged(merged);
        } catch {
            remoteSynced = false;
        }
        return { ...merged, remoteLoaded: true, remoteSynced, pendingSyncCount: 0 };
    }
    if (decision === "degraded_fallback") {
        return deps.loadExistingFull();
    }
    return { ...deps.readLocal(), remoteLoaded: false, remoteError: `server_${status}` };
}

export interface SaveTeacherRosterDeps {
    server: (snapshot: RosterSnapshot) => Promise<{ status: string }>;
    /** Write the snapshot + tombstones to local storage; returns localSaved. */
    writeLocalAndTombstones: (snapshot: RosterSnapshot) => boolean;
    saveExistingFull: (snapshot: RosterSnapshot) => Promise<RosterPersistenceResult>;
}

export async function saveTeacherRosterWithDeps(
    snapshot: RosterSnapshot,
    deps: SaveTeacherRosterDeps,
): Promise<RosterPersistenceResult> {
    let status = "degraded_local";
    try {
        const res = await deps.server(snapshot);
        status = res.status;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "degraded_fallback") {
        return deps.saveExistingFull(snapshot);
    }
    // ok or local_only: always persist locally (offline-first). Only ok reports a
    // remote save; a denial/error keeps the roster on-device without a
    // publishable-key write.
    const localSaved = deps.writeLocalAndTombstones(snapshot);
    if (decision === "server") {
        return { localSaved, remoteSaved: true };
    }
    return { localSaved, remoteSaved: false, remoteError: `server_${status}` };
}

/* --------------------------------------------- bound wrappers for screens -- */

type RosterStorage = Pick<Storage, "getItem" | "setItem">;

export function loadTeacherRoster(storage: RosterStorage): Promise<RosterLoadResult> {
    return loadTeacherRosterWithDeps({
        server: () => loadTeacherRosterAction() as Promise<{ status: TeacherDataStatus; snapshot?: RosterSnapshot }>,
        readLocal: () => readLocalRosterSnapshot(storage),
        reconcileServer: (serverSnapshot) => {
            const withTombstones = applyRosterTombstonesToSnapshot(serverSnapshot, readRosterTombstones(storage));
            const merged = mergeRosterSnapshots(readLocalRosterSnapshot(storage), withTombstones);
            writeLocalRosterSnapshot(storage, merged);
            return merged;
        },
        pushMerged: async (merged) => (await saveTeacherRosterAction(merged)).status === "ok",
        loadExistingFull: () => loadRosterSnapshot(storage),
    });
}

export function saveTeacherRoster(storage: RosterStorage, snapshot: RosterSnapshot): Promise<RosterPersistenceResult> {
    return saveTeacherRosterWithDeps(snapshot, {
        server: (snap) => saveTeacherRosterAction(snap) as Promise<{ status: TeacherDataStatus }>,
        writeLocalAndTombstones: (snap) => {
            const previous = readLocalRosterSnapshot(storage);
            const tombstones = nextRosterTombstones(previous, snap, readRosterTombstones(storage));
            const localSaved = writeLocalRosterSnapshot(storage, snap);
            writeRosterTombstones(storage, tombstones);
            return localSaved;
        },
        saveExistingFull: (snap) => saveRosterSnapshot(storage, snap),
    });
}
