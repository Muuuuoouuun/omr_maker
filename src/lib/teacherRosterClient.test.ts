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
    ROSTER_REVISION_CONFLICT_ERROR,
    saveTeacherRosterSnapshot,
} from "./teacherRosterClient";

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

beforeEach(() => {
    actions.load.mockReset();
    actions.save.mockReset();
});

describe("teacher roster client", () => {
    it("caches a canonical server load locally", async () => {
        const local = storage();
        actions.load.mockResolvedValue({ status: "loaded", snapshot, revision: 7 });
        await expect(loadTeacherRosterSnapshot(local)).resolves.toMatchObject({
            ...snapshot,
            remoteLoaded: true,
            remoteSynced: true,
        });
        expect(JSON.parse(local.getItem("omr_students") || "[]")).toHaveLength(1);
        expect(local.getItem("omr_roster_revision")).toBe("7");
    });

    it("passes the last loaded revision and advances it only after a canonical save", async () => {
        const local = storage();
        local.setItem("omr_roster_revision", "7");
        actions.save.mockResolvedValue({ status: "saved", snapshot, revision: 8 });

        await expect(saveTeacherRosterSnapshot(local, snapshot)).resolves.toEqual({
            localSaved: true,
            remoteSaved: true,
        });
        expect(actions.save).toHaveBeenCalledWith(snapshot, 7);
        expect(local.getItem("omr_roster_revision")).toBe("8");
    });

    it("uses a null expected revision for the first canonical save", async () => {
        const local = storage();
        actions.save.mockResolvedValue({ status: "saved", snapshot, revision: 1 });

        await saveTeacherRosterSnapshot(local, snapshot);

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

        await expect(saveTeacherRosterSnapshot(local, snapshot)).resolves.toEqual({
            localSaved: false,
            remoteSaved: true,
        });
    });

    it("does not replace the cached revision when a second device has already saved", async () => {
        const local = storage();
        local.setItem("omr_roster_revision", "7");
        actions.save.mockResolvedValue({ status: "conflict", error: "roster revision conflict" });

        await expect(saveTeacherRosterSnapshot(local, snapshot)).resolves.toEqual({
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
        await expect(saveTeacherRosterSnapshot(local, snapshot)).resolves.toEqual({
            localSaved: false,
            remoteSaved: false,
            remoteError: "db down",
        });
        expect(local.getItem("omr_students")).toBeNull();
    });

    it("uses local persistence only when the server explicitly returns local_only", async () => {
        const local = storage();
        actions.save.mockResolvedValue({ status: "local_only" });
        await expect(saveTeacherRosterSnapshot(local, snapshot)).resolves.toEqual({
            localSaved: true,
            remoteSaved: false,
        });
        expect(JSON.parse(local.getItem("omr_students") || "[]")).toHaveLength(1);
    });
});
