import { describe, expect, it, vi } from "vitest";
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

    it("keeps corrupt storage byte-for-byte during login/read and offers explicit export/discard", () => {
        const raw = '[{"body":"PIN 1234","broken":';
        const storage = memoryStorage({
            omr_pending_guest_merge: pending,
            omr_attempts: raw,
        });

        const state = readGuestRecoveryState(storage);
        expect(state).toMatchObject({
            status: "corrupt",
            guestId: "guest-1",
            byteLength: expect.any(Number),
            canRetryDbClaim: false,
        });
        expect(buildGuestRecoveryExport(state!)).toContain(raw);
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();

        expect(discardGuestRecovery(state!, storage)).toBe(true);
        expect(storage.removeItem).toHaveBeenCalledWith("omr_attempts");
        expect(storage.removeItem).toHaveBeenCalledWith("omr_pending_guest_merge");
    });

    it("keeps a corrupt or legacy pending marker visible without mutating either raw value", () => {
        const rawPending = '{"legacyGuest":';
        const rawAttempts = JSON.stringify([localAttempt]);
        const storage = memoryStorage({
            omr_pending_guest_merge: rawPending,
            omr_attempts: rawAttempts,
        });

        const state = readGuestRecoveryState(storage);
        expect(state).toMatchObject({
            status: "corrupt",
            guestId: "",
            canRetryDbClaim: false,
        });
        const exported = buildGuestRecoveryExport(state!);
        expect(exported).toContain(rawPending);
        expect(exported).toContain(rawAttempts);
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
    });

    it("discards only the selected guest recovery records and preserves other students", () => {
        const other = { ...localAttempt, id: "student-record", studentId: "student-2", guestId: undefined, identityType: "temporary" };
        const storage = memoryStorage({
            omr_pending_guest_merge: pending,
            omr_attempts: JSON.stringify([localAttempt, other]),
        });
        const state = readGuestRecoveryState(storage)!;

        expect(discardGuestRecovery(state, storage)).toBe(true);
        expect(JSON.parse(storage.getItem("omr_attempts") || "[]")).toEqual([other]);
        expect(storage.getItem("omr_pending_guest_merge")).toBeNull();
    });
});
