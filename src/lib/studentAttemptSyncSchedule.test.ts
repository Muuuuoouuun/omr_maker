import { describe, expect, it } from "vitest";
import * as schedule from "./studentAttemptSyncSchedule";

describe("student attempt sync scheduling", () => {
    it("assigns each session a stable bounded delay per sync channel", () => {
        expect(typeof schedule.studentAttemptSyncDelayMs).toBe("function");
        expect(schedule.studentAttemptSyncDelayMs("session-42", "checkpoint")).toBe(
            schedule.studentAttemptSyncDelayMs("session-42", "checkpoint"),
        );
        expect(schedule.studentAttemptSyncDelayMs("session-42", "checkpoint")).toBeGreaterThanOrEqual(5_000);
        expect(schedule.studentAttemptSyncDelayMs("session-42", "checkpoint")).toBeLessThanOrEqual(6_500);
        expect(schedule.studentAttemptSyncDelayMs("session-42", "heartbeat")).toBeGreaterThanOrEqual(15_000);
        expect(schedule.studentAttemptSyncDelayMs("session-42", "heartbeat")).toBeLessThanOrEqual(19_000);
    });

    it("spreads a 100-student cohort across the jitter windows", () => {
        const sessionIds = Array.from({ length: 100 }, (_, index) => `session-${index}`);
        const checkpointDelays = sessionIds.map(sessionId => schedule.studentAttemptSyncDelayMs(sessionId, "checkpoint"));
        const heartbeatDelays = sessionIds.map(sessionId => schedule.studentAttemptSyncDelayMs(sessionId, "heartbeat"));
        expect(new Set(checkpointDelays).size).toBeGreaterThan(75);
        expect(new Set(heartbeatDelays).size).toBeGreaterThan(75);
    });

    it("records a lease renewal only for a successful active response", () => {
        expect(typeof schedule.leaseRenewedAtAfterSyncResult).toBe("function");
        expect(schedule.leaseRenewedAtAfterSyncResult(1_000, "active", 9_000)).toBe(9_000);
        expect(schedule.leaseRenewedAtAfterSyncResult(1_000, "service_unavailable", 9_000)).toBe(1_000);
        expect(schedule.leaseRenewedAtAfterSyncResult(1_000, "aborted", 9_000)).toBe(1_000);
    });

    it("suppresses heartbeat only while a successful checkpoint renewal is recent", () => {
        expect(typeof schedule.shouldSendStudentAttemptHeartbeat).toBe("function");
        expect(schedule.shouldSendStudentAttemptHeartbeat(null, 20_000)).toBe(true);
        expect(schedule.shouldSendStudentAttemptHeartbeat(10_000, 20_000)).toBe(false);
        expect(schedule.shouldSendStudentAttemptHeartbeat(5_000, 20_000)).toBe(true);
    });

    it("defers to an in-flight checkpoint without letting a stalled request starve the lease", () => {
        expect(typeof schedule.shouldDeferHeartbeatForCheckpoint).toBe("function");
        expect(schedule.shouldDeferHeartbeatForCheckpoint(null, 20_000)).toBe(false);
        expect(schedule.shouldDeferHeartbeatForCheckpoint(10_000, 20_000)).toBe(true);
        expect(schedule.shouldDeferHeartbeatForCheckpoint(5_000, 20_000)).toBe(false);
    });
});
