interface GuestClaimPayloadTarget {
    guestId: string;
    studentId: string;
    studentName: string;
    classId: string;
    groupName: string;
    mergedAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function rewriteOwner(value: Record<string, unknown>, target: GuestClaimPayloadTarget): Record<string, unknown> {
    const preserved = { ...value };
    delete preserved.guestId;
    return {
        ...preserved,
        studentId: target.studentId,
        studentProfileId: target.studentId,
        studentName: target.studentName,
        groupId: target.classId,
        groupName: target.groupName,
        identityType: "temporary",
    };
}

export function rewriteGuestClaimAttemptPayload(
    payload: Record<string, unknown>,
    target: GuestClaimPayloadTarget,
): Record<string, unknown> {
    const rewritten = rewriteOwner(payload, target);
    const questionResults = Array.isArray(payload.questionResults)
        ? payload.questionResults.map(value => {
            const item = record(value);
            return item ? rewriteOwner(item, target) : value;
        })
        : payload.questionResults;
    return {
        ...rewritten,
        classId: target.classId,
        mergedFromGuestId: target.guestId,
        mergedAt: target.mergedAt,
        ...(Array.isArray(payload.questionResults) ? { questionResults } : {}),
    };
}
