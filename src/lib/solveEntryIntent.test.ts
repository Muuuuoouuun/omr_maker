import { describe, expect, it } from "vitest";
import {
    SOLVE_ENTRY_INTENT_STORAGE_KEY,
    SOLVE_ENTRY_INTENT_TTL_MS,
    consumeSolveEntryIntent,
    hasSolveEntryIntent,
    recordSolveEntryIntent,
    recordSolveEntryIntentForPath,
} from "./solveEntryIntent";

class MemoryStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
    removeItem(key: string) { this.values.delete(key); }
}

const TARGET = { examId: "exam-1", studentId: "student-1" };

describe("solve entry intent", () => {
    it("is honoured once within the TTL and then forgotten", () => {
        const storage = new MemoryStorage();
        expect(recordSolveEntryIntent(TARGET, { storage, now: 1_000 })).toBe(true);
        expect(hasSolveEntryIntent(TARGET, { storage, now: 1_000 + SOLVE_ENTRY_INTENT_TTL_MS })).toBe(true);
        expect(consumeSolveEntryIntent(TARGET, { storage, now: 1_000 + SOLVE_ENTRY_INTENT_TTL_MS })).toBe(true);
        expect(storage.values.has(SOLVE_ENTRY_INTENT_STORAGE_KEY)).toBe(false);
        expect(consumeSolveEntryIntent(TARGET, { storage, now: 2_000 })).toBe(false);
    });

    it("expires after 120 seconds and is removed by the failed read", () => {
        const storage = new MemoryStorage();
        recordSolveEntryIntent(TARGET, { storage, now: 1_000 });
        expect(SOLVE_ENTRY_INTENT_TTL_MS).toBe(120_000);
        expect(hasSolveEntryIntent(TARGET, { storage, now: 1_001 + SOLVE_ENTRY_INTENT_TTL_MS })).toBe(false);
        expect(consumeSolveEntryIntent(TARGET, { storage, now: 1_001 + SOLVE_ENTRY_INTENT_TTL_MS })).toBe(false);
        expect(storage.values.has(SOLVE_ENTRY_INTENT_STORAGE_KEY)).toBe(false);
    });

    it("rejects an intent created in the future", () => {
        const storage = new MemoryStorage();
        recordSolveEntryIntent(TARGET, { storage, now: 10_000 });
        expect(consumeSolveEntryIntent(TARGET, { storage, now: 9_000 })).toBe(false);
    });

    it.each([
        ["another exam", { examId: "exam-2", studentId: "student-1" }],
        ["another student", { examId: "exam-1", studentId: "student-2" }],
        ["an assignment scope the intent did not name", { examId: "exam-1", studentId: "student-1", assignmentId: "assignment-1" }],
    ])("rejects and consumes an intent for %s", (_label, target) => {
        const storage = new MemoryStorage();
        recordSolveEntryIntent(TARGET, { storage, now: 1_000 });
        expect(consumeSolveEntryIntent(target, { storage, now: 1_500 })).toBe(false);
        // The mismatch still burns the one-shot intent.
        expect(consumeSolveEntryIntent(TARGET, { storage, now: 1_600 })).toBe(false);
    });

    it("binds the assignment scope", () => {
        const storage = new MemoryStorage();
        recordSolveEntryIntent({ ...TARGET, assignmentId: "assignment-1" }, { storage, now: 1_000 });
        expect(hasSolveEntryIntent({ ...TARGET, assignmentId: "assignment-2" }, { storage, now: 1_100 })).toBe(false);
        expect(hasSolveEntryIntent(TARGET, { storage, now: 1_100 })).toBe(false);
        expect(consumeSolveEntryIntent({ ...TARGET, assignmentId: "assignment-1" }, { storage, now: 1_100 })).toBe(true);
    });

    it("records post-login redirects only for solve paths and keeps the assignment scope", () => {
        const storage = new MemoryStorage();
        expect(recordSolveEntryIntentForPath("/student/dashboard", "student-1", { storage, now: 1_000 })).toBe(false);
        expect(recordSolveEntryIntentForPath("/solve/exam-1/extra", "student-1", { storage, now: 1_000 })).toBe(false);
        expect(storage.values.size).toBe(0);
        expect(recordSolveEntryIntentForPath(
            "/solve/exam-1?assignment=assignment-9&assignmentRevision=2",
            "student-1",
            { storage, now: 1_000 },
        )).toBe(true);
        expect(consumeSolveEntryIntent({ ...TARGET, assignmentId: "assignment-9" }, { storage, now: 1_100 })).toBe(true);
    });

    it("ignores malformed stored values and missing identity", () => {
        const storage = new MemoryStorage();
        expect(recordSolveEntryIntent({ examId: "exam-1", studentId: "" }, { storage })).toBe(false);
        storage.setItem(SOLVE_ENTRY_INTENT_STORAGE_KEY, "{not json");
        expect(consumeSolveEntryIntent(TARGET, { storage, now: 1_000 })).toBe(false);
        expect(storage.values.has(SOLVE_ENTRY_INTENT_STORAGE_KEY)).toBe(false);
    });

    it("treats storage exceptions as no intent", () => {
        const throwing = {
            getItem: () => { throw new Error("blocked"); },
            setItem: () => { throw new Error("blocked"); },
            removeItem: () => { throw new Error("blocked"); },
        };
        expect(recordSolveEntryIntent(TARGET, { storage: throwing, now: 1_000 })).toBe(false);
        expect(hasSolveEntryIntent(TARGET, { storage: throwing, now: 1_000 })).toBe(false);
        expect(consumeSolveEntryIntent(TARGET, { storage: throwing, now: 1_000 })).toBe(false);
        expect(recordSolveEntryIntent(TARGET, { storage: null })).toBe(false);
        expect(consumeSolveEntryIntent(TARGET, { storage: null })).toBe(false);
    });

    it("refuses an intent that cannot be removed after reading", () => {
        const storage = new MemoryStorage();
        recordSolveEntryIntent(TARGET, { storage, now: 1_000 });
        const stuck = { ...storage, getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage), removeItem: () => { throw new Error("blocked"); } };
        expect(consumeSolveEntryIntent(TARGET, { storage: stuck, now: 1_100 })).toBe(false);
    });
});
