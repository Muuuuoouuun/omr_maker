import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterSnapshot } from "./rosterPersistence";

const actions = vi.hoisted(() => ({
    load: vi.fn(),
    save: vi.fn(),
}));

vi.mock("@/app/actions/teacherRoster", () => ({
    loadTeacherCanonicalRoster: actions.load,
    saveTeacherCanonicalRoster: actions.save,
}));

import {
    loadTeacherRosterSnapshot,
    persistTeacherRosterCandidate,
    ROSTER_REVISION_CONFLICT_ERROR,
    saveTeacherRosterSnapshot,
    saveTeacherRosterSnapshotIfCurrent,
} from "./teacherRosterClient";
import * as teacherRosterClient from "./teacherRosterClient";

function storage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear() { values.clear(); },
        getItem(key) { return values.get(key) ?? null; },
        key(index) { return [...values.keys()][index] ?? null; },
        removeItem(key) { values.delete(key); },
        setItem(key, value) { values.set(key, value); },
    } as Storage;
}

const snapshot: RosterSnapshot = {
    groups: [{ id: "class-a", name: "A반", count: 1, avgScore: 80, color: "#4f46e5" }],
    students: [{
        id: "student-1", name: "학생", email: "student@example.com", group: "A반", avatar: "#4f46e5",
        avgScore: 80, examsTaken: 1, lastActive: "오늘", trend: "up", status: "active",
    }],
    invites: [],
};

const collectionMeta = {
    organizationId: "org-1",
    loadedAt: "2026-08-09T01:02:03.000Z",
    rawCount: 3,
    parsedCount: 3,
};
const orgAScope = Object.freeze({ organizationId: "org-a", accountId: "teacher-a", sessionGeneration: 1 });
const orgBScope = Object.freeze({ organizationId: "org-b", accountId: "teacher-b", sessionGeneration: 2 });

beforeEach(() => {
    actions.load.mockReset();
    actions.save.mockReset();
});

describe("teacher roster client", () => {
    it("returns a canonical remote candidate without persisting before caller authorization", async () => {
        const local = storage();
        const setItem = vi.fn(() => { throw new Error("write before identity fence"); });
        local.setItem = setItem;
        actions.load.mockResolvedValue({
            status: "loaded",
            snapshot,
            revision: 7,
            meta: collectionMeta,
        });

        const loaded = await loadTeacherRosterSnapshot(local);

        expect(loaded).toMatchObject({
            ...snapshot,
            remoteLoaded: true,
            remoteSynced: true,
            candidate: {
                snapshot,
                revision: 7,
                meta: collectionMeta,
            },
        });
        expect(setItem).not.toHaveBeenCalled();
    });

    it("persists a remote roster candidate only through the explicit post-fence function", async () => {
        const local = storage();
        const candidate = { snapshot, revision: 7, meta: collectionMeta };

        expect(persistTeacherRosterCandidate(local, candidate)).toBe(true);

        expect(JSON.parse(local.getItem("omr_students") || "[]")).toHaveLength(1);
        expect(local.getItem("omr_roster_revision")).toBe("7");
    });

    it.each([1, 2, 3, 4, 5])("rolls back every legacy roster key when candidate write %i fails", failAt => {
        const local = storage();
        const keys = [
            "omr_students",
            "omr_groups",
            "omr_invites",
            "omr_roster_tombstones",
            "omr_roster_revision",
        ];
        const previous = new Map(keys.map((key, index) => [key, `previous-exact-bytes-${index}`]));
        previous.forEach((value, key) => local.setItem(key, value));
        const setItem = local.setItem.bind(local);
        let writes = 0;
        local.setItem = (key, value) => {
            writes += 1;
            if (writes === failAt) throw new Error(`candidate write ${failAt} failed`);
            setItem(key, value);
        };

        expect(persistTeacherRosterCandidate(local, {
            snapshot,
            revision: 7,
            meta: collectionMeta,
        })).toBe(false);
        expect(Object.fromEntries(keys.map(key => [key, local.getItem(key)]))).toEqual(
            Object.fromEntries(previous),
        );
    });

    it("removes newly-created legacy roster keys when a candidate write fails", () => {
        const local = storage();
        const keys = [
            "omr_students",
            "omr_groups",
            "omr_invites",
            "omr_roster_tombstones",
            "omr_roster_revision",
        ];
        const setItem = local.setItem.bind(local);
        let writes = 0;
        local.setItem = (key, value) => {
            writes += 1;
            if (writes === 3) throw new Error("candidate write failed");
            setItem(key, value);
        };

        expect(persistTeacherRosterCandidate(local, {
            snapshot,
            revision: 7,
            meta: collectionMeta,
        })).toBe(false);
        expect(keys.map(key => local.getItem(key))).toEqual(keys.map(() => null));
    });

    it.each([
        ["a noncanonical loadedAt", { ...collectionMeta, loadedAt: "2026-08-09T10:02:03+09:00" }],
        ["a whitespace-padded loadedAt", { ...collectionMeta, loadedAt: ` ${collectionMeta.loadedAt} ` }],
        ["a raw/parsed mismatch", { ...collectionMeta, rawCount: 4 }],
        ["an extra metadata key", { ...collectionMeta, page: 1 }],
    ])("returns no usable remote roster for %s", async (_label, meta) => {
        const local = storage();
        actions.load.mockResolvedValue({ status: "loaded", snapshot, revision: 7, meta });

        await expect(loadTeacherRosterSnapshot(local)).resolves.toMatchObject({
            students: [],
            groups: [],
            invites: [],
            remoteLoaded: false,
            remoteError: "Invalid canonical roster collection",
        });
        expect(local.getItem("omr_roster_revision")).toBeNull();
    });

    it("passes the last loaded revision and advances it only after a canonical save", async () => {
        const local = storage();
        local.setItem("omr_roster_revision", "7");
        actions.save.mockResolvedValue({ status: "saved", snapshot, revision: 8 });

        await expect(saveTeacherRosterSnapshot(local, snapshot, orgAScope)).resolves.toEqual({
            localSaved: true,
            remoteSaved: true,
            remoteRevision: 8,
        });
        expect(actions.save).toHaveBeenCalledWith(snapshot, 7);
        expect(local.getItem("omr_roster_revision")).toBe("8");
    });

    it("uses a null expected revision for the first canonical save", async () => {
        const local = storage();
        actions.save.mockResolvedValue({ status: "saved", snapshot, revision: 1 });

        await saveTeacherRosterSnapshot(local, snapshot, orgAScope);

        expect(actions.save).toHaveBeenCalledWith(snapshot, null);
    });

    it("reports a local cache failure without losing a successful canonical save", async () => {
        const local = storage();
        const setItem = local.setItem.bind(local);
        local.setItem = (key, value) => {
            if (key === "omr_roster_revision") throw new Error("storage blocked");
            setItem(key, value);
        };
        actions.save.mockResolvedValue({ status: "saved", snapshot, revision: 1 });

        await expect(saveTeacherRosterSnapshot(local, snapshot, orgAScope)).resolves.toEqual({
            localSaved: false,
            remoteSaved: true,
            remoteRevision: 1,
        });
    });

    it("does not replace the cached revision when a second device has already saved", async () => {
        const local = storage();
        local.setItem("omr_roster_revision", "7");
        actions.save.mockResolvedValue({ status: "conflict", error: "roster revision conflict" });

        await expect(saveTeacherRosterSnapshot(local, snapshot, orgAScope)).resolves.toEqual({
            localSaved: false,
            remoteSaved: false,
            remoteError: ROSTER_REVISION_CONFLICT_ERROR,
        });
        expect(actions.save).toHaveBeenCalledWith(snapshot, 7);
        expect(local.getItem("omr_roster_revision")).toBe("7");
        expect(local.getItem("omr_students")).toBeNull();
    });

    it("fails closed without writing local state on a production-style server error", async () => {
        const local = storage();
        actions.save.mockResolvedValue({ status: "service_unavailable", error: "db down" });
        await expect(saveTeacherRosterSnapshot(local, snapshot, orgAScope)).resolves.toEqual({
            localSaved: false,
            remoteSaved: false,
            remoteError: "db down",
        });
        expect(local.getItem("omr_students")).toBeNull();
    });

    it("uses local persistence only when the server explicitly returns local_only", async () => {
        const local = storage();
        actions.save.mockResolvedValue({ status: "local_only" });
        await expect(saveTeacherRosterSnapshot(local, snapshot, orgAScope)).resolves.toEqual({
            localSaved: true,
            remoteSaved: false,
        });
        expect(JSON.parse(local.getItem("omr_students") || "[]")).toHaveLength(1);
    });

    it("checks ownership before the server call and immediately before all post-await local writes", async () => {
        const local = storage();
        let release!: (value: { status: "saved"; snapshot: RosterSnapshot; revision: number }) => void;
        const response = new Promise<{ status: "saved"; snapshot: RosterSnapshot; revision: number }>(resolve => {
            release = resolve;
        });
        actions.save.mockReturnValue(response);
        let current = true;

        const pending = saveTeacherRosterSnapshotIfCurrent(local, snapshot, () => current, 7, orgAScope);
        expect(actions.save).toHaveBeenCalledTimes(1);
        current = false;
        release({ status: "saved", snapshot, revision: 8 });

        await expect(pending).resolves.toEqual({ status: "stale" });
        expect(local.getItem("omr_students")).toBeNull();
        expect(local.getItem("omr_groups")).toBeNull();
        expect(local.getItem("omr_roster_revision")).toBeNull();

        actions.save.mockClear();
        await expect(saveTeacherRosterSnapshotIfCurrent(local, snapshot, () => false, 7, orgAScope)).resolves.toEqual({ status: "stale" });
        expect(actions.save).not.toHaveBeenCalled();
    });

    it("hands the successful revision to the next queued save in the same tenant scope", async () => {
        const local = storage();
        const latestSnapshot = { ...snapshot, invites: [{ id: "invite-new", email: "new@example.com", sentAt: "오늘", status: "pending" as const }] };
        let releaseFirst!: (value: { status: "saved"; snapshot: RosterSnapshot; revision: number }) => void;
        actions.save
            .mockReturnValueOnce(new Promise(resolve => { releaseFirst = resolve; }))
            .mockResolvedValueOnce({ status: "saved", snapshot: latestSnapshot, revision: 9 });
        let firstCurrent = true;

        const first = saveTeacherRosterSnapshotIfCurrent(local, snapshot, () => firstCurrent, 7, orgAScope);
        firstCurrent = false;
        const second = saveTeacherRosterSnapshotIfCurrent(local, latestSnapshot, () => true, 7, orgAScope);

        expect(actions.save).toHaveBeenCalledTimes(1);
        releaseFirst({ status: "saved", snapshot, revision: 8 });
        await expect(first).resolves.toEqual({ status: "stale" });
        const secondResult = await second;
        expect(actions.save).toHaveBeenNthCalledWith(2, latestSnapshot, 8);
        expect(secondResult).toEqual({ localSaved: true, remoteSaved: true, remoteRevision: 9 });
        expect(JSON.parse(local.getItem("omr_invites") || "[]")).toEqual(latestSnapshot.invites);
    });

    it("never carries a successful tenant A revision into tenant B", async () => {
        const local = storage();
        const tenantB = { ...snapshot, groups: [{ ...snapshot.groups[0], id: "tenant-b-group" }] };
        let releaseA!: (value: { status: "saved"; snapshot: RosterSnapshot; revision: number }) => void;
        actions.save
            .mockReturnValueOnce(new Promise(resolve => { releaseA = resolve; }))
            .mockResolvedValueOnce({ status: "saved", snapshot: tenantB, revision: 43 });
        let tenantACurrent = true;

        const saveA = saveTeacherRosterSnapshotIfCurrent(local, snapshot, () => tenantACurrent, 7, orgAScope);
        tenantACurrent = false;
        const saveB = saveTeacherRosterSnapshotIfCurrent(local, tenantB, () => true, 42, orgBScope);

        expect(actions.save).toHaveBeenNthCalledWith(1, snapshot, 7);
        expect(actions.save).toHaveBeenNthCalledWith(2, tenantB, 42);
        releaseA({ status: "saved", snapshot, revision: 8 });
        await expect(saveA).resolves.toEqual({ status: "stale" });
        await expect(saveB).resolves.toEqual({ localSaved: true, remoteSaved: true, remoteRevision: 43 });
    });

    it("persists the latest delete-undo snapshot through same-scope revision handoff", async () => {
        const local = storage();
        const deleted: RosterSnapshot = { ...snapshot, students: [] };
        const currentInvite = { id: "invite-current", email: "current@example.com", sentAt: "방금 전", status: "pending" as const };
        const latestBeforeUndo: RosterSnapshot = { ...deleted, invites: [currentInvite] };
        const restored = teacherRosterClient.restoreDeletedStudentsIntoCurrentRoster(latestBeforeUndo, snapshot.students);
        let releaseDelete!: (value: { status: "saved"; snapshot: RosterSnapshot; revision: number }) => void;
        actions.save
            .mockReturnValueOnce(new Promise(resolve => { releaseDelete = resolve; }))
            .mockResolvedValueOnce({ status: "saved", snapshot: restored, revision: 9 });

        let deleteCurrent = true;
        const deleteSave = saveTeacherRosterSnapshotIfCurrent(local, deleted, () => deleteCurrent, 7, orgAScope);
        deleteCurrent = false;
        const undoSave = saveTeacherRosterSnapshotIfCurrent(local, restored, () => true, 7, orgAScope);
        releaseDelete({ status: "saved", snapshot: deleted, revision: 8 });

        await expect(deleteSave).resolves.toEqual({ status: "stale" });
        await expect(undoSave).resolves.toEqual({ localSaved: true, remoteSaved: true, remoteRevision: 9 });
        expect(actions.save.mock.calls.map(([, revision]) => revision)).toEqual([7, 8]);
        expect(JSON.parse(local.getItem("omr_students") || "[]")).toEqual(restored.students);
        expect(JSON.parse(local.getItem("omr_invites") || "[]")).toEqual([currentInvite]);
    });

    it("rejects a mutable accessor-backed save scope before any Action or local write", async () => {
        const local = storage();
        actions.save.mockResolvedValue({ status: "local_only" });
        const invalidScope = {
            get organizationId() { return "org-a"; },
            accountId: "teacher-a",
            sessionGeneration: 1,
        };

        await expect(saveTeacherRosterSnapshotIfCurrent(
            local,
            snapshot,
            () => true,
            7,
            invalidScope,
        )).resolves.toEqual({ status: "rejected" });
        expect(actions.save).not.toHaveBeenCalled();
        expect(local.getItem("omr_students")).toBeNull();
    });

    it("merges deleted students into the latest same-tenant snapshot without replacing newer data", () => {
        const restore = (teacherRosterClient as unknown as {
            restoreDeletedStudentsIntoCurrentRoster?: (current: RosterSnapshot, removed: RosterSnapshot["students"]) => RosterSnapshot;
        }).restoreDeletedStudentsIntoCurrentRoster;
        expect(restore).toBeTypeOf("function");
        if (!restore) return;
        const removed = snapshot.students[0];
        const newerStudent = { ...removed, id: "student-2", name: "추가 학생" };
        const latest: RosterSnapshot = {
            students: [newerStudent],
            groups: [{ ...snapshot.groups[0], name: "현재 반", count: 1 }],
            invites: [{ id: "invite-current", email: "current-invite@example.com", sentAt: "방금 전", status: "pending" }],
        };

        const restored = restore(latest, [removed]);

        expect(restored.students).toEqual([removed, newerStudent]);
        expect(restored.groups).toEqual(latest.groups);
        expect(restored.invites).toEqual(latest.invites);

        const currentVersion = { ...removed, name: "현재 이름", email: "current@example.com" };
        const deduplicated = restore({ ...latest, students: [currentVersion, newerStudent] }, [removed]);
        expect(deduplicated.students).toEqual([currentVersion, newerStudent]);
    });
});
