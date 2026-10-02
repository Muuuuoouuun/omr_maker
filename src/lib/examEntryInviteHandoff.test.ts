import { describe, expect, it } from "vitest";
import {
    captureExamEntryInviteFragment,
    readExamEntryInviteHandoff,
} from "./examEntryInviteHandoff";

class MemoryStorage {
    private values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
    removeItem(key: string) { this.values.delete(key); }
}

describe("tab-scoped exam invite handoff", () => {
    it("captures a fragment, binds it to the exam, and immediately scrubs browser history", () => {
        const storage = new MemoryStorage();
        const replacements: string[] = [];
        const token = "a".repeat(43);
        expect(captureExamEntryInviteFragment({
            examId: "exam-1",
            hash: `#invite=${token}`,
            pathname: "/solve/exam-1",
            search: "?retake=1",
            storage,
            replaceUrl: url => replacements.push(url),
            now: 1_000,
        })).toBe(token);
        expect(replacements).toEqual(["/solve/exam-1?retake=1"]);
        expect(readExamEntryInviteHandoff(storage, "exam-1", 2_000)).toBe(token);
    });

    it("does not cross exam or tab boundaries", () => {
        const firstTab = new MemoryStorage();
        const secondTab = new MemoryStorage();
        captureExamEntryInviteFragment({
            examId: "exam-1", hash: `#invite=${"b".repeat(43)}`,
            pathname: "/solve/exam-1", search: "", storage: firstTab,
            replaceUrl: () => undefined, now: 1_000,
        });
        expect(readExamEntryInviteHandoff(firstTab, "exam-2", 2_000)).toBeNull();
        expect(readExamEntryInviteHandoff(secondTab, "exam-1", 2_000)).toBeNull();
        expect(readExamEntryInviteHandoff(firstTab, "exam-1", 2_000)).toBeNull();
    });

    it("deletes malformed and expired handoffs", () => {
        const storage = new MemoryStorage();
        captureExamEntryInviteFragment({
            examId: "exam-1", hash: `#invite=${"c".repeat(43)}`,
            pathname: "/solve/exam-1", search: "", storage,
            replaceUrl: () => undefined, now: 1_000, ttlMs: 15_000,
        });
        expect(readExamEntryInviteHandoff(storage, "exam-1", 16_001)).toBeNull();
        expect(readExamEntryInviteHandoff(storage, "exam-1", 2_000)).toBeNull();
    });

    it("binds the handoff to the first authenticated account and deletes it on account switch", () => {
        const storage = new MemoryStorage();
        captureExamEntryInviteFragment({
            examId: "exam-1", hash: `#invite=${"d".repeat(43)}`,
            pathname: "/solve/exam-1", search: "", storage,
            replaceUrl: () => undefined, now: 1_000,
        });
        expect(readExamEntryInviteHandoff(storage, "exam-1", 2_000, "student-1")).toBe("d".repeat(43));
        expect(readExamEntryInviteHandoff(storage, "exam-1", 3_000, "student-2")).toBeNull();
        expect(readExamEntryInviteHandoff(storage, "exam-1", 4_000, "student-1")).toBeNull();
    });

    it("scrubs a malformed invite fragment without storing it", () => {
        const storage = new MemoryStorage();
        const replacements: string[] = [];
        expect(captureExamEntryInviteFragment({
            examId: "exam-1", hash: "#invite=raw-workspace-id",
            pathname: "/solve/exam-1", search: "", storage,
            replaceUrl: url => replacements.push(url), now: 1_000,
        })).toBeNull();
        expect(replacements).toEqual(["/solve/exam-1"]);
    });
});
