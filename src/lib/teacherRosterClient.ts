import { loadTeacherCanonicalRoster, saveTeacherCanonicalRoster } from "@/app/actions/teacherRoster";
import {
    nextRosterTombstones,
    readLocalRosterSnapshot,
    readRosterTombstones,
    ROSTER_TOMBSTONE_STORAGE_KEY,
    writeLocalRosterSnapshot,
    writeRosterTombstones,
    type RosterLoadResult,
    type RosterPersistenceResult,
    type RosterSnapshot,
} from "@/lib/rosterPersistence";
import { ROSTER_STORAGE_KEYS } from "@/lib/rosterStorage";
import type { CanonicalCollectionMeta } from "@/lib/canonicalCollectionContract";

export const ROSTER_REVISION_STORAGE_KEY = "omr_roster_revision";
export const ROSTER_REVISION_CONFLICT_ERROR = "roster_revision_conflict";

export interface TeacherRosterRemoteCandidate {
    snapshot: RosterSnapshot;
    revision: number;
    meta: CanonicalCollectionMeta;
}

export interface TeacherRosterSnapshotLoadResult extends RosterLoadResult {
    candidate?: TeacherRosterRemoteCandidate;
    meta?: CanonicalCollectionMeta;
}

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
): Promise<TeacherRosterSnapshotLoadResult> {
    const localSnapshot = readLocalRosterSnapshot(storage);
    const result = await loadTeacherCanonicalRoster();
    if (result.status === "loaded") {
        const meta = result.meta as unknown;
        if (!validRosterCollectionMeta(meta)) {
            return {
                students: [],
                groups: [],
                invites: [],
                remoteLoaded: false,
                remoteSynced: false,
                remoteError: "Invalid canonical roster collection",
            };
        }
        const candidate = { snapshot: result.snapshot, revision: result.revision, meta };
        return {
            ...result.snapshot,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
            remoteRevision: result.revision,
            meta,
            candidate,
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

export function persistTeacherRosterCandidate(
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    candidate: TeacherRosterRemoteCandidate,
): boolean {
    if (!validRosterCollectionMeta(candidate.meta)
        || !Number.isSafeInteger(candidate.revision)
        || candidate.revision < 0) {
        return false;
    }
    const affectedKeys = [
        ROSTER_STORAGE_KEYS.students,
        ROSTER_STORAGE_KEYS.groups,
        ROSTER_STORAGE_KEYS.invites,
        ROSTER_TOMBSTONE_STORAGE_KEY,
        ROSTER_REVISION_STORAGE_KEY,
    ];
    let previous: Map<string, string | null>;
    try {
        previous = new Map(affectedKeys.map(key => [key, storage.getItem(key)]));
    } catch {
        return false;
    }
    const snapshotSaved = writeLocalRosterSnapshot(storage, candidate.snapshot);
    const tombstonesSaved = writeRosterTombstones(storage, { students: {}, groups: {} });
    const revisionSaved = writeRosterRevision(storage, candidate.revision);
    if (snapshotSaved && tombstonesSaved && revisionSaved) return true;
    for (const key of affectedKeys) {
        try {
            const value = previous.get(key);
            if (value === null || value === undefined) storage.removeItem(key);
            else storage.setItem(key, value);
        } catch {
            // Best-effort rollback is the only recovery localStorage exposes.
        }
    }
    return false;
}

function validRosterCollectionMeta(value: unknown): value is CanonicalCollectionMeta {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const meta = value as Record<string, unknown>;
    if (Object.keys(meta).sort().join(",") !== "loadedAt,organizationId,parsedCount,rawCount") return false;
    const organizationId = typeof meta.organizationId === "string" ? meta.organizationId.trim() : "";
    const loadedAt = typeof meta.loadedAt === "string" ? meta.loadedAt : "";
    const timestamp = Date.parse(loadedAt);
    return !!organizationId
        && organizationId === meta.organizationId
        && Number.isFinite(timestamp)
        && new Date(timestamp).toISOString() === loadedAt
        && Number.isSafeInteger(meta.rawCount)
        && Number(meta.rawCount) >= 0
        && meta.rawCount === meta.parsedCount;
}

function predicateAllowsWrite(isCurrent: () => boolean): boolean {
    try {
        return isCurrent();
    } catch {
        return false;
    }
}

type RosterSaveQueueState = {
    tail: Promise<void>;
    lastSuccessfulRevision?: number;
};

export interface TeacherRosterSaveScope {
    readonly organizationId: string;
    readonly accountId: string;
    readonly sessionGeneration: number;
}

const rosterSaveQueues = new WeakMap<object, Map<string, RosterSaveQueueState>>();

function validatedTeacherRosterSaveScope(value: unknown): TeacherRosterSaveScope | null {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const keys = Reflect.ownKeys(value);
        if (keys.length !== 3 || !["organizationId", "accountId", "sessionGeneration"].every(key => keys.includes(key))) return null;
        const record = value as Record<string, unknown>;
        for (const key of keys) {
            if (typeof key !== "string") return null;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        }
        const organizationId = record.organizationId;
        const accountId = record.accountId;
        const sessionGeneration = record.sessionGeneration;
        const invalidText = (text: unknown) => typeof text !== "string"
            || !text
            || text !== text.trim()
            || /[\u0000-\u001f\u007f-\u009f]/u.test(text);
        if (invalidText(organizationId)
            || invalidText(accountId)
            || !Number.isSafeInteger(sessionGeneration)
            || Number(sessionGeneration) < 1) return null;
        return Object.freeze({
            organizationId: organizationId as string,
            accountId: accountId as string,
            sessionGeneration: sessionGeneration as number,
        });
    } catch {
        return null;
    }
}

function teacherRosterSaveScopeKey(scope: TeacherRosterSaveScope): string {
    return JSON.stringify([scope.organizationId, scope.accountId, scope.sessionGeneration]);
}

function withRosterSaveLock<T>(
    storage: object,
    scope: TeacherRosterSaveScope,
    operation: (state: RosterSaveQueueState) => Promise<T>,
): Promise<T> {
    const scopeKey = teacherRosterSaveScopeKey(scope);
    const queues = rosterSaveQueues.get(storage) ?? new Map<string, RosterSaveQueueState>();
    const existing = queues.get(scopeKey);
    const state: RosterSaveQueueState = existing ?? { tail: Promise.resolve() };
    const run = existing
        ? existing.tail.then(() => operation(state))
        : operation(state);
    const tail = run.then(() => undefined, () => undefined);
    state.tail = tail;
    queues.set(scopeKey, state);
    rosterSaveQueues.set(storage, queues);
    void tail.then(() => {
        const currentQueues = rosterSaveQueues.get(storage);
        if (!currentQueues || currentQueues.get(scopeKey)?.tail !== tail) return;
        currentQueues.delete(scopeKey);
        if (currentQueues.size === 0) rosterSaveQueues.delete(storage);
    });
    return run;
}

export function restoreDeletedStudentsIntoCurrentRoster(
    current: RosterSnapshot,
    removedStudents: RosterSnapshot["students"],
): RosterSnapshot {
    const currentIds = new Set(current.students.map(student => student.id));
    const missing = removedStudents.filter(student => !currentIds.has(student.id));
    return {
        students: [...missing, ...current.students],
        groups: current.groups,
        invites: current.invites,
    };
}

export async function saveTeacherRosterSnapshotIfCurrent(
    storage: Pick<Storage, "getItem" | "setItem">,
    snapshot: RosterSnapshot,
    isCurrent: () => boolean,
    expectedRevision: number | null,
    scope: TeacherRosterSaveScope,
): Promise<RosterPersistenceResult | { status: "stale" | "rejected" }> {
    const safeScope = validatedTeacherRosterSaveScope(scope);
    if (!safeScope
        || (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
        return { status: "rejected" };
    }
    return withRosterSaveLock(storage, safeScope, async queue => {
        if (!predicateAllowsWrite(isCurrent)) return { status: "stale" };
        const previous = readLocalRosterSnapshot(storage);
        if (!predicateAllowsWrite(isCurrent)) return { status: "stale" };
        const revision = queue.lastSuccessfulRevision ?? expectedRevision;
        const result = await saveTeacherCanonicalRoster(snapshot, revision);
        if (result.status === "saved") queue.lastSuccessfulRevision = result.revision;
        if (!predicateAllowsWrite(isCurrent)) return { status: "stale" };
        if (result.status === "saved") {
            const snapshotSaved = writeLocalRosterSnapshot(storage, result.snapshot);
            writeRosterTombstones(storage, { students: {}, groups: {} });
            const revisionSaved = writeRosterRevision(storage, result.revision);
            return { localSaved: snapshotSaved && revisionSaved, remoteSaved: true, remoteRevision: result.revision };
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
    });
}

export async function saveTeacherRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
    snapshot: RosterSnapshot,
    scope: TeacherRosterSaveScope,
): Promise<RosterPersistenceResult> {
    const result = await saveTeacherRosterSnapshotIfCurrent(storage, snapshot, () => true, readRosterRevision(storage), scope);
    if ("status" in result) {
        return { localSaved: false, remoteSaved: false, remoteError: "Roster save ownership expired" };
    }
    return result;
}
