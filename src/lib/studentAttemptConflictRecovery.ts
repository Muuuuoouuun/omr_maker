import type { StudentAttemptSessionState } from "./studentAttemptSessionContract";

export type LatestAttemptObservation =
    | { status: "active"; session: StudentAttemptSessionState; leaseToken: string }
    | { status: "lease_conflict"; session: StudentAttemptSessionState }
    | { status: "submitted"; session: StudentAttemptSessionState }
    | { status: "other" };

export async function observeLatestAttemptSession(
    currentLeaseToken: string,
    observe: (currentLeaseToken: string) => Promise<{
        status: string;
        session?: StudentAttemptSessionState;
        leaseToken?: string;
    }>,
): Promise<LatestAttemptObservation> {
    const result = await observe(currentLeaseToken);
    if (result.status === "active" && result.session && result.leaseToken) {
        return { status: "active", session: result.session, leaseToken: result.leaseToken };
    }
    if (result.status === "lease_conflict" && result.session) {
        return { status: "lease_conflict", session: result.session };
    }
    if (result.status === "submitted" && result.session) {
        return { status: "submitted", session: result.session };
    }
    return { status: "other" };
}

export function takeoverRequestFromLatestSession(session: StudentAttemptSessionState) {
    return {
        sessionId: session.sessionId,
        expectedRevision: session.revision,
        expectedLeaseEpoch: session.leaseEpoch,
    };
}
