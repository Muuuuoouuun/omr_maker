import { describe, expect, it } from "vitest";
import {
    clearDurableAttemptResumeCredential,
    durableAttemptResumeKey,
    readDurableAttemptResumeCredential,
    writeDurableAttemptResumeCredential,
} from "./studentAttemptLeaseStorage";

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}

describe("durable attempt same-tab resume credentials", () => {
    it("scopes a ticket and lease to actor, exam, and attempt mode", () => {
        const storage = memoryStorage();
        const key = durableAttemptResumeKey("exam-1", "student-1", "base");
        expect(writeDurableAttemptResumeCredential(storage, key, { ticket: "ticket-1", leaseToken: "lease-1" })).toBe(true);
        expect(readDurableAttemptResumeCredential(storage, key)).toEqual({ ticket: "ticket-1", leaseToken: "lease-1" });
        expect(readDurableAttemptResumeCredential(storage, durableAttemptResumeKey("exam-1", "student-2", "base"))).toBeNull();
        clearDurableAttemptResumeCredential(storage, key);
        expect(readDurableAttemptResumeCredential(storage, key)).toBeNull();
    });

    it("fails closed for malformed or oversized credentials", () => {
        const storage = memoryStorage();
        storage.setItem("bad", JSON.stringify({ ticket: "x".repeat(32_769), leaseToken: "lease" }));
        expect(readDurableAttemptResumeCredential(storage, "bad")).toBeNull();
    });

    it("uses a stable encoded exact assignment tuple and rejects delimiter collisions or legacy targeted scope", () => {
        const exact = durableAttemptResumeKey({
            examId: "exam:1", actorId: "student/1", assignmentId: "assignment:reused",
            assignmentRevision: 8, retakeSegment: "base:scope",
        });
        const collision = durableAttemptResumeKey({
            examId: "exam", actorId: "1:student", assignmentId: "assignment",
            assignmentRevision: 8, retakeSegment: "reused:base:scope",
        });
        expect(exact).not.toBe(collision);
        expect(exact).toMatch(/^omr_attempt_lease:v2:/);
        expect(durableAttemptResumeKey({
            examId: "exam-1", actorId: "student-1", assignmentId: "assignment-reused",
            retakeSegment: "base",
        })).toBeNull();
    });

    it("self-validates the embedded exact scope and rejects copied credentials from another generation", () => {
        const storage = memoryStorage();
        const revision7 = durableAttemptResumeKey({
            examId: "exam-1", actorId: "student-1", assignmentId: "assignment-reused",
            assignmentRevision: 7, retakeSegment: "base",
        });
        const revision8 = durableAttemptResumeKey({
            examId: "exam-1", actorId: "student-1", assignmentId: "assignment-reused",
            assignmentRevision: 8, retakeSegment: "base",
        });
        expect(revision7).toBeTypeOf("string");
        expect(revision8).toBeTypeOf("string");
        expect(writeDurableAttemptResumeCredential(storage, revision7!, {
            ticket: "ticket-7", leaseToken: "lease-7",
        })).toBe(true);
        storage.setItem(revision8!, storage.getItem(revision7!) || "");
        expect(readDurableAttemptResumeCredential(storage, revision8!)).toBeNull();
    });
});
