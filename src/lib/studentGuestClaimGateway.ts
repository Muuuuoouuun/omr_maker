import type { StudentServerIdentity } from "@/lib/studentServerSession";

interface GuestClaimRpcResult {
    data: unknown;
    error: { message?: string } | null;
}

export interface GuestClaimRpcClient {
    rpc(
        functionName: string,
        args: Record<string, unknown>,
    ): PromiseLike<GuestClaimRpcResult>;
}

export type GuestClaimResult =
    | { status: "not_requested"; acknowledgedAttemptIds: [] }
    | { status: "claimed"; acknowledgedAttemptIds: string[] }
    | { status: "partial"; acknowledgedAttemptIds: string[]; error: string; deferredAttemptCount?: number }
    | { status: "retryable_error"; acknowledgedAttemptIds: []; error: string };

const CLAIM_CHUNK_SIZE = 100;
export const GUEST_CLAIM_MAX_ATTEMPT_IDS = 500;
export const GUEST_CLAIM_MAX_ID_BYTES = 256;
export const GUEST_CLAIM_MAX_SERIALIZED_ID_BYTES = 64 * 1024;
export const GUEST_CLAIM_MAX_RPC_CHUNKS = 5;
const GUEST_CLAIM_BOUNDED_ERROR = "Guest attempt claim request exceeded safe bounds";

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function acknowledgedAttemptIds(value: unknown, requested: string[]): string[] {
    if (!Array.isArray(value)) return [];
    const allowed = new Set(requested);
    return [...new Set(value.map(clean).filter(id => id && allowed.has(id)))];
}

export function boundGuestClaimAttemptIds(
    values: unknown[],
): { attemptIds: string[]; deferredAttemptCount: number } {
    const attemptIds: string[] = [];
    const accepted = new Set<string>();
    let serializedBytes = 2; // JSON array brackets
    let deferredAttemptCount = 0;
    let saturated = false;
    for (const value of values) {
        const id = clean(value);
        if (!id || accepted.has(id)) continue;
        const encodedIdBytes = new TextEncoder().encode(JSON.stringify(id)).length;
        if (encodedIdBytes > GUEST_CLAIM_MAX_ID_BYTES + 2) {
            deferredAttemptCount += 1;
            continue;
        }
        const nextBytes = serializedBytes + encodedIdBytes + (attemptIds.length > 0 ? 1 : 0);
        if (
            saturated
            || attemptIds.length >= GUEST_CLAIM_MAX_ATTEMPT_IDS
            || nextBytes > GUEST_CLAIM_MAX_SERIALIZED_ID_BYTES
        ) {
            saturated = true;
            deferredAttemptCount += 1;
            continue;
        }
        accepted.add(id);
        attemptIds.push(id);
        serializedBytes = nextBytes;
    }
    return { attemptIds, deferredAttemptCount };
}

export async function claimSignedGuestAttempts(
    client: GuestClaimRpcClient,
    input: {
        guest: StudentServerIdentity | null;
        student: StudentServerIdentity;
        attemptIds?: string[];
    },
): Promise<GuestClaimResult> {
    const guestId = input.guest?.kind === "guest" ? clean(input.guest.guestId) : "";
    const studentId = input.student.kind === "student" ? clean(input.student.studentId) : "";
    const organizationId = clean(input.student.organizationId);
    const classId = clean(input.student.groupId);
    if (!guestId) return { status: "not_requested", acknowledgedAttemptIds: [] };
    if (!studentId || !organizationId || !classId) {
        return {
            status: "retryable_error",
            acknowledgedAttemptIds: [],
            error: "Verified student scope is incomplete",
        };
    }
    const { attemptIds, deferredAttemptCount } = boundGuestClaimAttemptIds(input.attemptIds || []);
    if (attemptIds.length === 0) {
        if (deferredAttemptCount > 0) {
            return {
                status: "partial",
                acknowledgedAttemptIds: [],
                deferredAttemptCount,
                error: GUEST_CLAIM_BOUNDED_ERROR,
            };
        }
        return { status: "claimed", acknowledgedAttemptIds: [] };
    }

    const acknowledged = new Set<string>();
    let firstError = "";
    for (
        let offset = 0, chunkIndex = 0;
        offset < attemptIds.length && chunkIndex < GUEST_CLAIM_MAX_RPC_CHUNKS;
        offset += CLAIM_CHUNK_SIZE, chunkIndex += 1
    ) {
        const chunk = attemptIds.slice(offset, offset + CLAIM_CHUNK_SIZE);
        try {
            const result = await client.rpc("omr_claim_guest_attempts_v1", {
                p_guest_id: guestId,
                p_student_profile_id: studentId,
                p_organization_id: organizationId,
                p_class_id: classId,
                p_student_name: clean(input.student.name),
                p_group_name: clean(input.student.groupName),
                p_attempt_ids: chunk,
            });
            if (result.error) {
                firstError ||= clean(result.error.message) || "Guest attempt claim failed";
                continue;
            }
            acknowledgedAttemptIds(result.data, chunk).forEach(id => acknowledged.add(id));
        } catch (error) {
            firstError ||= error instanceof Error ? error.message : "Guest attempt claim failed";
        }
    }
    const acknowledgedAttemptIdsResult = [...acknowledged];
    if (!firstError && deferredAttemptCount === 0) {
        return { status: "claimed", acknowledgedAttemptIds: acknowledgedAttemptIdsResult };
    }
    if (firstError && acknowledgedAttemptIdsResult.length === 0 && deferredAttemptCount === 0) {
        return { status: "retryable_error", acknowledgedAttemptIds: [], error: firstError };
    }
    if (firstError || deferredAttemptCount > 0) {
        return {
            status: "partial",
            acknowledgedAttemptIds: acknowledgedAttemptIdsResult,
            ...(deferredAttemptCount > 0 ? { deferredAttemptCount } : {}),
            error: firstError || GUEST_CLAIM_BOUNDED_ERROR,
        };
    }
    return { status: "claimed", acknowledgedAttemptIds: acknowledgedAttemptIdsResult };
}
