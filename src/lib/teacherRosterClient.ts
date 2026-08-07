import { loadTeacherCanonicalRoster, saveTeacherCanonicalRoster } from "@/app/actions/teacherRoster";
import {
    nextRosterTombstones,
    readLocalRosterSnapshot,
    readRosterTombstones,
    writeLocalRosterSnapshot,
    writeRosterTombstones,
    type RosterLoadResult,
    type RosterPersistenceResult,
    type RosterSnapshot,
} from "@/lib/rosterPersistence";

export const ROSTER_REVISION_STORAGE_KEY = "omr_roster_revision";
export const ROSTER_REVISION_CONFLICT_ERROR = "roster_revision_conflict";

function readRosterRevision(storage: Pick<Storage, "getItem">): number | null {
    const stored = storage.getItem(ROSTER_REVISION_STORAGE_KEY);
    if (stored === null || stored.trim() === "") return null;
    const parsed = Number(stored);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function writeRosterRevision(storage: Pick<Storage, "setItem">, revision: number): boolean {
    try {
        storage.setItem(ROSTER_REVISION_STORAGE_KEY, String(revision));
        return true;
    } catch {
        return false;
    }
}

export async function loadTeacherRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
): Promise<RosterLoadResult> {
    const localSnapshot = readLocalRosterSnapshot(storage);
    const result = await loadTeacherCanonicalRoster();
    if (result.status === "loaded") {
        writeLocalRosterSnapshot(storage, result.snapshot);
        writeRosterTombstones(storage, { students: {}, groups: {} });
        writeRosterRevision(storage, result.revision);
        return {
            ...result.snapshot,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
            remoteRevision: result.revision,
        };
    }
    if (result.status === "local_only") return { ...localSnapshot, remoteLoaded: false };
    return {
        ...localSnapshot,
        remoteLoaded: false,
        remoteSynced: false,
        pendingSyncCount: localSnapshot.students.length + localSnapshot.groups.length + localSnapshot.invites.length,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical roster gateway unavailable",
    };
}

export async function saveTeacherRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
    snapshot: RosterSnapshot,
): Promise<RosterPersistenceResult> {
    const previous = readLocalRosterSnapshot(storage);
    const result = await saveTeacherCanonicalRoster(snapshot, readRosterRevision(storage));
    if (result.status === "saved") {
        const snapshotSaved = writeLocalRosterSnapshot(storage, result.snapshot);
        writeRosterTombstones(storage, { students: {}, groups: {} });
        const revisionSaved = writeRosterRevision(storage, result.revision);
        return { localSaved: snapshotSaved && revisionSaved, remoteSaved: true };
    }
    if (result.status === "local_only") {
        const tombstones = nextRosterTombstones(previous, snapshot, readRosterTombstones(storage));
        const localSaved = writeLocalRosterSnapshot(storage, snapshot);
        writeRosterTombstones(storage, tombstones);
        return { localSaved, remoteSaved: false };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "conflict"
            ? ROSTER_REVISION_CONFLICT_ERROR
            : result.status === "unauthorized"
                ? "Teacher server session is missing"
                : result.error || (result.status === "invalid_roster" ? "Invalid roster payload" : "Canonical roster gateway unavailable"),
    };
}
