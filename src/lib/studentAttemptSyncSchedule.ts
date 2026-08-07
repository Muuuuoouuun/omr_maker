import {
    STUDENT_ATTEMPT_CHECKPOINT_MS,
    STUDENT_ATTEMPT_HEARTBEAT_MS,
} from "./studentAttemptSessionContract";

export type StudentAttemptSyncChannel = "checkpoint" | "heartbeat";

export const STUDENT_ATTEMPT_CHECKPOINT_JITTER_MS = 1_500;
export const STUDENT_ATTEMPT_HEARTBEAT_JITTER_MS = 4_000;

function stableHash(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}

export function studentAttemptSyncDelayMs(
    sessionId: string,
    channel: StudentAttemptSyncChannel,
): number {
    const baseMs = channel === "checkpoint"
        ? STUDENT_ATTEMPT_CHECKPOINT_MS
        : STUDENT_ATTEMPT_HEARTBEAT_MS;
    const maxJitterMs = channel === "checkpoint"
        ? STUDENT_ATTEMPT_CHECKPOINT_JITTER_MS
        : STUDENT_ATTEMPT_HEARTBEAT_JITTER_MS;
    return baseMs + (stableHash(`${sessionId}:${channel}`) % (maxJitterMs + 1));
}

export function leaseRenewedAtAfterSyncResult(
    previousRenewedAtMs: number | null,
    resultStatus: unknown,
    observedAtMs: number,
): number | null {
    return resultStatus === "active" ? observedAtMs : previousRenewedAtMs;
}

export function shouldSendStudentAttemptHeartbeat(
    lastCheckpointLeaseRenewedAtMs: number | null,
    nowMs: number,
): boolean {
    return lastCheckpointLeaseRenewedAtMs === null
        || nowMs - lastCheckpointLeaseRenewedAtMs >= STUDENT_ATTEMPT_HEARTBEAT_MS;
}

export function shouldDeferHeartbeatForCheckpoint(
    checkpointStartedAtMs: number | null,
    nowMs: number,
): boolean {
    return checkpointStartedAtMs !== null
        && nowMs - checkpointStartedAtMs < STUDENT_ATTEMPT_HEARTBEAT_MS;
}
