export type DistributionShareResult = {
    shareUrl: string;
    expiresAt?: string;
    /** Canonical exam id, used to create a normalized server assignment after first publish. */
    examId?: string;
};

export type DistributionShareResultLike = string | DistributionShareResult;

export const EXISTING_GROUP_INVITE_ROTATION_CONFIRMATION =
    "새 링크를 발급하면 지금 배포한 링크와 QR은 즉시 사용할 수 없게 됩니다. 새 링크를 발급할까요?";

export function normalizeDistributionShareResult(
    result: DistributionShareResultLike,
): DistributionShareResult {
    if (typeof result === "string") return { shareUrl: result.trim() };
    const shareUrl = result.shareUrl.trim();
    const expiresAt = typeof result.expiresAt === "string"
        && Number.isFinite(Date.parse(result.expiresAt))
        ? result.expiresAt
        : undefined;
    const examId = typeof result.examId === "string" ? result.examId.trim() : "";
    return {
        shareUrl,
        ...(expiresAt ? { expiresAt } : {}),
        ...(examId ? { examId } : {}),
    };
}

export async function confirmExistingGroupInviteRotation(input: {
    needsConfirmation: boolean;
    confirm: (message: string) => boolean;
    rotateAndSave: () => Promise<DistributionShareResultLike>;
}): Promise<
    { status: "cancelled" }
    | { status: "saved"; result: DistributionShareResultLike }
> {
    if (input.needsConfirmation
        && !input.confirm(EXISTING_GROUP_INVITE_ROTATION_CONFIRMATION)) {
        return { status: "cancelled" };
    }
    return { status: "saved", result: await input.rotateAndSave() };
}
