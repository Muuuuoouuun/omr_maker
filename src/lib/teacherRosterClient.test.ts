import { describe, expect, it, vi } from "vitest";
import {
    loadTeacherRosterWithDeps,
    saveTeacherRosterWithDeps,
} from "./teacherRosterClient";
import type { RosterSnapshot } from "./rosterPersistence";

function snapshot(studentIds: string[]): RosterSnapshot {
    return {
        students: studentIds.map(id => ({ id, name: id })) as RosterSnapshot["students"],
        groups: [],
        invites: [],
    };
}

describe("loadTeacherRosterWithDeps", () => {
    it("reconciles and pushes the server snapshot on ok", async () => {
        const reconcileServer = vi.fn((s: RosterSnapshot) => s);
        const pushMerged = vi.fn(async () => true);
        const loadExistingFull = vi.fn();
        const result = await loadTeacherRosterWithDeps({
            server: async () => ({ status: "ok", snapshot: snapshot(["srv"]) }),
            readLocal: () => snapshot([]),
            reconcileServer,
            pushMerged,
            loadExistingFull,
        });
        expect(reconcileServer).toHaveBeenCalledOnce();
        expect(pushMerged).toHaveBeenCalledOnce();
        expect(result.remoteLoaded).toBe(true);
        expect(result.remoteSynced).toBe(true);
        expect(result.students.map(s => s.id)).toEqual(["srv"]);
        expect(loadExistingFull).not.toHaveBeenCalled();
    });

    it("still returns the merged snapshot but flags remoteSynced false when the push fails", async () => {
        const result = await loadTeacherRosterWithDeps({
            server: async () => ({ status: "ok", snapshot: snapshot(["srv"]) }),
            readLocal: () => snapshot([]),
            reconcileServer: (s) => s,
            pushMerged: async () => { throw new Error("push failed"); },
            loadExistingFull: vi.fn(),
        });
        expect(result.remoteLoaded).toBe(true);
        expect(result.remoteSynced).toBe(false);
    });

    it("reads only the local snapshot on denied (no publishable path)", async () => {
        const reconcileServer = vi.fn();
        const loadExistingFull = vi.fn();
        const result = await loadTeacherRosterWithDeps({
            server: async () => ({ status: "denied" }),
            readLocal: () => snapshot(["local"]),
            reconcileServer,
            pushMerged: vi.fn(),
            loadExistingFull,
        });
        expect(result.remoteLoaded).toBe(false);
        expect(result.remoteError).toBe("server_denied");
        expect(result.students.map(s => s.id)).toEqual(["local"]);
        expect(reconcileServer).not.toHaveBeenCalled();
        expect(loadExistingFull).not.toHaveBeenCalled();
    });

    it("uses the existing local + publishable path on degraded_local", async () => {
        const loadExistingFull = vi.fn(async () => ({ ...snapshot(["legacy"]), remoteLoaded: true }));
        const result = await loadTeacherRosterWithDeps({
            server: async () => ({ status: "degraded_local" }),
            readLocal: () => snapshot([]),
            reconcileServer: vi.fn(),
            pushMerged: vi.fn(),
            loadExistingFull,
        });
        expect(loadExistingFull).toHaveBeenCalledOnce();
        expect(result.students.map(s => s.id)).toEqual(["legacy"]);
    });
});

describe("saveTeacherRosterWithDeps", () => {
    it("writes local and reports remoteSaved on ok", async () => {
        const writeLocalAndTombstones = vi.fn(() => true);
        const saveExistingFull = vi.fn();
        const result = await saveTeacherRosterWithDeps(snapshot(["a"]), {
            server: async () => ({ status: "ok" }),
            writeLocalAndTombstones,
            saveExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: true });
        expect(writeLocalAndTombstones).toHaveBeenCalledOnce();
        expect(saveExistingFull).not.toHaveBeenCalled();
    });

    it("keeps the roster on-device but no remote save on denied (no publishable write)", async () => {
        const saveExistingFull = vi.fn();
        const result = await saveTeacherRosterWithDeps(snapshot(["a"]), {
            server: async () => ({ status: "denied" }),
            writeLocalAndTombstones: () => true,
            saveExistingFull,
        });
        expect(result).toEqual({ localSaved: true, remoteSaved: false, remoteError: "server_denied" });
        expect(saveExistingFull).not.toHaveBeenCalled();
    });

    it("delegates to the existing save on degraded_local", async () => {
        const saveExistingFull = vi.fn(async () => ({ localSaved: true, remoteSaved: true }));
        await saveTeacherRosterWithDeps(snapshot(["a"]), {
            server: async () => ({ status: "degraded_local" }),
            writeLocalAndTombstones: () => true,
            saveExistingFull,
        });
        expect(saveExistingFull).toHaveBeenCalledOnce();
    });
});
