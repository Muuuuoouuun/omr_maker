import type { ExamEntryInviteMetadata } from "@/lib/examEntryInviteLifecycle";

export type DistributionShareResult = {
    shareUrl: string;
    expiresAt?: string;
    /** Canonical exam id, used to create a normalized server assignment after first publish. */
    examId?: string;
    /** Safe metadata returned atomically with a one-time group invite bearer. */
    metadata?: ExamEntryInviteMetadata;
};

export type DistributionShareResultLike = string | DistributionShareResult;

export const EXISTING_GROUP_INVITE_ROTATION_CONFIRMATION =
    "새 링크를 발급하면 기존 링크와 QR은 즉시 무효화됩니다. 새 링크를 발급할까요?";

export function isGroupInviteShareUrl(value: string | null | undefined): boolean {
    if (typeof value !== "string") return false;
    const fragment = value.split("#", 2)[1];
    if (!fragment) return false;
    return new URLSearchParams(fragment).has("invite");
}

export function resolveInviteRotationExamId(
    result: DistributionShareResult,
    currentExamId?: string,
): string | null {
    const metadataExamId = result.metadata?.examId.trim() || "";
    const resultExamId = result.examId?.trim() || "";
    const current = currentExamId?.trim() || "";
    if (!metadataExamId) return null;
    if (current) {
        if (metadataExamId !== current || (resultExamId && resultExamId !== current)) return null;
        return current;
    }
    return resultExamId && metadataExamId === resultExamId ? resultExamId : null;
}

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
    const metadata = result.metadata;
    return {
        shareUrl,
        ...(expiresAt ? { expiresAt } : {}),
        ...(examId ? { examId } : {}),
        ...(metadata ? { metadata } : {}),
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
