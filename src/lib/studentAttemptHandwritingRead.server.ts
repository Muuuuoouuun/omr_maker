import type { Attempt } from "@/types/omr";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import { attemptOwnedBy } from "@/lib/studentExamCore";
import {
    isRemoteAssetStoredDataRef,
    type RemoteAssetStoredDataRef,
} from "@/lib/remoteAssetContract.server";
import {
    createStaffRemoteAssetSignedUrlWithGateway,
    type RemoteAssetSupabaseGatewayClient,
    type RemoteAssetSignedUrlResult,
} from "@/lib/remoteAssetGateway.server";

export function resolveOwnedStudentHandwritingRef(
    attempt: Attempt,
    identity: StudentServerIdentity,
): RemoteAssetStoredDataRef | null {
    const ref = attempt.handwriting?.strokesRef || attempt.drawingsRef;
    if (
        attempt.status !== "completed"
        || attempt.organizationId !== identity.organizationId
        || !attemptOwnedBy(attempt, identity)
        || !isRemoteAssetStoredDataRef(ref)
        || ref.kind !== "attempt_handwriting"
        || ref.organizationId !== identity.organizationId
        || ref.attemptId !== attempt.id
    ) return null;
    return ref;
}

type SignRemoteAsset = typeof createStaffRemoteAssetSignedUrlWithGateway;

export async function createOwnedStudentHandwritingSignedUrlWithGateway(
    client: RemoteAssetSupabaseGatewayClient,
    attempt: Attempt,
    identity: StudentServerIdentity,
    sign: SignRemoteAsset = createStaffRemoteAssetSignedUrlWithGateway,
): Promise<RemoteAssetSignedUrlResult> {
    const ref = resolveOwnedStudentHandwritingRef(attempt, identity);
    if (!ref) return { status: "scope_denied" };
    return sign(client, {
        assetId: ref.key,
        organizationId: ref.organizationId,
        kind: "attempt_handwriting",
        attemptId: attempt.id,
    });
}
