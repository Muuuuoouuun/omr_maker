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

export async function loadTeacherRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
): Promise<RosterLoadResult> {
    const localSnapshot = readLocalRosterSnapshot(storage);
    const result = await loadTeacherCanonicalRoster();
    if (result.status === "loaded") {
        writeLocalRosterSnapshot(storage, result.snapshot);
        writeRosterTombstones(storage, { students: {}, groups: {} });
        return { ...result.snapshot, remoteLoaded: true, remoteSynced: true, pendingSyncCount: 0 };
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
    const result = await saveTeacherCanonicalRoster(snapshot);
    if (result.status === "saved") {
        const localSaved = writeLocalRosterSnapshot(storage, result.snapshot);
        writeRosterTombstones(storage, { students: {}, groups: {} });
        return { localSaved, remoteSaved: true };
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
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || (result.status === "invalid_roster" ? "Invalid roster payload" : "Canonical roster gateway unavailable"),
    };
}
