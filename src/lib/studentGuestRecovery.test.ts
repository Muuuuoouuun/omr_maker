import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildGuestRecoveryExport,
    discardGuestRecovery,
    readGuestRecoveryState,
} from "./studentGuestRecovery";

function memoryStorage(initial: Record<string, string> = {}): Storage {
    const values = new Map(Object.entries(initial));
    return {
        get length() { return values.size; },
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn(key => values.get(key) ?? null),
        key: vi.fn(index => [...values.keys()][index] ?? null),
        removeItem: vi.fn(key => values.delete(key)),
        setItem: vi.fn((key, value) => values.set(key, value)),
    };
}

const pending = JSON.stringify({ guestId: "guest-1", queuedAt: "2026-07-28T00:00:00.000Z" });
const localAttempt = {
    id: "client-chosen-id",
    examId: "arbitrary-exam",
    examTitle: "로컬 기록",
    studentName: "Guest",
    studentId: "guest:guest-1",
    guestId: "guest-1",
    identityType: "guest",
    startedAt: "1900-01-01T00:00:00.000Z",
    finishedAt: "2999-01-01T00:00:00.000Z",
    score: 999,
    totalScore: 1,
    answers: { 1: 4 },
    status: "completed",
};

describe("unverified guest recovery", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", {
            locks: {
                request: async (
                    _name: string,
                    _options: object,
                    operation: () => Promise<unknown>,
                ) => operation(),
            },
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("classifies arbitrary local id/exam/payload/time as export-only, never canonical proof", () => {
        const storage = memoryStorage({
            omr_pending_guest_merge: pending,
            omr_attempts: JSON.stringify([localAttempt]),
        });

        const state = readGuestRecoveryState(storage);
        expect(state).toMatchObject({
            status: "unverified",
            guestId: "guest-1",
            attemptIds: ["client-chosen-id"],
            canRetryDbClaim: true,
        });
        expect(buildGuestRecoveryExport(state!)).toContain('"verification":"unverified_local_only"');
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
    });

    it("keeps corrupt attempt-store bytes quarantinable but never deletes them under generic discard", async () => {
        const raw = '[{"body":"PIN 1234","broken":';
        const storage = memoryStorage({
            omr_pending_guest_merge: pending,
            omr_attempts: raw,
        });

        const state = readGuestRecoveryState(storage);
        expect(state).toMatchObject({
            status: "attempt_store_corrupt",
            guestId: "guest-1",
            byteLength: expect.any(Number),
            canRetryDbClaim: false,
        });
        expect(buildGuestRecoveryExport(state!)).toContain(raw);
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();

        await expect(discardGuestRecovery(state!, storage)).resolves.toEqual({ status: "blocked" });
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();

        await expect(discardGuestRecovery(
            state!,
            storage,
            { quarantineWholeAttemptStore: true },
        )).resolves.toEqual({ status: "quarantined" });
        expect(storage.setItem).toHaveBeenCalledWith("omr_attempts_quarantine", expect.stringContaining(raw));
        expect(storage.removeItem).toHaveBeenCalledWith("omr_attempts");
        expect(storage.removeItem).toHaveBeenCalledWith("omr_pending_guest_merge");
    });

    it("keeps marker corruption scoped away from valid unrelated student attempts", async () => {
        const rawPending = '{"legacyGuest":';
        const unrelated = {
            ...localAttempt,
            id: "unrelated-student-secret",
            studentId: "student-99",
            guestId: undefined,
            identityType: "temporary",
        };
        const rawAttempts = JSON.stringify([unrelated]);
        const storage = memoryStorage({
            omr_pending_guest_merge: rawPending,
            omr_attempts: rawAttempts,
        });

        const state = readGuestRecoveryState(storage);
        expect(state).toMatchObject({
            status: "marker_corrupt",
            guestId: "",
            canRetryDbClaim: false,
        });
        const exported = buildGuestRecoveryExport(state!);
        expect(exported).toContain(rawPending);
        expect(exported).not.toContain("unrelated-student-secret");
        expect(exported).not.toContain(rawAttempts);
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();

        await expect(discardGuestRecovery(state!, storage)).resolves.toEqual({ status: "discarded" });
        expect(storage.getItem("omr_attempts")).toBe(rawAttempts);
        expect(storage.getItem("omr_pending_guest_merge")).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledTimes(1);
        expect(storage.removeItem).toHaveBeenCalledWith("omr_pending_guest_merge");
    });

    it("discards only the selected guest recovery records and preserves other students", async () => {
        const other = { ...localAttempt, id: "student-record", studentId: "student-2", guestId: undefined, identityType: "temporary" };
        const storage = memoryStorage({
            omr_pending_guest_merge: pending,
            omr_attempts: JSON.stringify([localAttempt, other]),
        });
        const state = readGuestRecoveryState(storage)!;

        await expect(discardGuestRecovery(state, storage)).resolves.toEqual({ status: "discarded" });
        expect(JSON.parse(storage.getItem("omr_attempts") || "[]")).toEqual([other]);
        expect(storage.getItem("omr_pending_guest_merge")).toBeNull();
    });

    it("aborts stale quarantine inside the attempt-index lock when another tab changes the store", async () => {
        const capturedRaw = '[{"broken":';
        const concurrentRaw = JSON.stringify([{ ...localAttempt, id: "newer-tab-attempt" }]);
        const storage = memoryStorage({
            omr_pending_guest_merge: pending,
            omr_attempts: capturedRaw,
        });
        const state = readGuestRecoveryState(storage)!;
        const request = vi.fn(async (
            _name: string,
            _options: object,
            operation: () => Promise<unknown>,
        ) => {
            storage.setItem("omr_attempts", concurrentRaw);
            return operation();
        });
        vi.stubGlobal("navigator", { locks: { request } });

        await expect(discardGuestRecovery(
            state,
            storage,
            { quarantineWholeAttemptStore: true },
        )).resolves.toEqual({ status: "stale" });
        expect(request).toHaveBeenCalledWith(
            "omr-storage:attempt-index",
            { mode: "exclusive" },
            expect.any(Function),
        );
        expect(storage.getItem("omr_attempts")).toBe(concurrentRaw);
        expect(storage.getItem("omr_pending_guest_merge")).toBe(pending);
        expect(storage.getItem("omr_attempts_quarantine")).toBeNull();
    });
});
