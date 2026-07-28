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
    | { status: "not_requested"; claimedCount: 0 }
    | { status: "claimed"; claimedCount: number }
    | { status: "retryable_error"; claimedCount: 0; error: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function claimedCount(value: unknown): number {
    const candidate = Array.isArray(value) ? value[0] : value;
    const numeric = typeof candidate === "number"
        ? candidate
        : typeof candidate === "string"
            ? Number(candidate)
            : Number.NaN;
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
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
    if (!guestId) return { status: "not_requested", claimedCount: 0 };
    if (!studentId || !organizationId || !classId) {
        return {
            status: "retryable_error",
            claimedCount: 0,
            error: "Verified student scope is incomplete",
        };
    }
    const attemptIds = [...new Set((input.attemptIds || []).map(clean).filter(Boolean))].slice(0, 100);

    try {
        const result = await client.rpc("omr_claim_guest_attempts_v1", {
            p_guest_id: guestId,
            p_student_profile_id: studentId,
            p_organization_id: organizationId,
            p_class_id: classId,
            p_student_name: clean(input.student.name),
            p_group_name: clean(input.student.groupName),
            p_attempt_ids: attemptIds,
        });
        if (result.error) {
            return {
                status: "retryable_error",
                claimedCount: 0,
                error: clean(result.error.message) || "Guest attempt claim failed",
            };
        }
        return { status: "claimed", claimedCount: claimedCount(result.data) };
    } catch (error) {
        return {
            status: "retryable_error",
            claimedCount: 0,
            error: error instanceof Error ? error.message : "Guest attempt claim failed",
        };
    }
}
