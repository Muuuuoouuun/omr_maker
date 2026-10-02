import type { KakaoNotificationCandidate, KakaoNotificationCandidateKind } from "@/lib/kakaoNotificationQueue";
import { formatRegionScopedLabel } from "@/lib/dashboardSelection";

export const KAKAO_CANDIDATE_REVIEW_STORAGE_KEY = "omr_kakao_candidate_reviews";

export type KakaoCandidateReviewStatus = "ready" | "hold" | "excluded";

export interface KakaoCandidateReviewRecord {
    candidateId: string;
    status: KakaoCandidateReviewStatus;
    channel: "kakao";
    kind: KakaoNotificationCandidateKind;
    examId: string;
    title: string;
    targetCount: number;
    studentIds: string[];
    studentNames: string[];
    updatedAt: string;
}

export type KakaoCandidateReviewMap = Record<string, KakaoCandidateReviewRecord>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function cleanStudentTargets(
    idsValue: unknown,
    namesValue: unknown,
    targetCount: number,
): { studentIds: string[]; studentNames: string[] } | null {
    if (!Array.isArray(idsValue) || !Array.isArray(namesValue)
        || idsValue.length !== namesValue.length || idsValue.length !== targetCount) return null;
    const studentIds: string[] = [];
    const studentNames: string[] = [];
    const seenIds = new Set<string>();
    for (let index = 0; index < idsValue.length; index += 1) {
        const studentId = clean(idsValue[index]);
        const displayName = clean(namesValue[index]);
        if (!studentId || !displayName || seenIds.has(studentId)) return null;
        seenIds.add(studentId);
        studentIds.push(studentId);
        studentNames.push(displayName);
    }
    return { studentIds, studentNames };
}

function isReviewStatus(value: unknown): value is KakaoCandidateReviewStatus {
    return value === "ready" || value === "hold" || value === "excluded";
}

function normalizeReviewRecord(value: unknown): KakaoCandidateReviewRecord | null {
    if (!isRecord(value)) return null;
    const candidateId = clean(value.candidateId);
    const status = value.status;
    const examId = clean(value.examId);
    const title = clean(value.title);
    const kind = clean(value.kind) as KakaoNotificationCandidateKind;
    const updatedAt = clean(value.updatedAt);
    const targetCount = Number(value.targetCount);

    if (!candidateId || !isReviewStatus(status) || !examId || !title || !updatedAt
        || !Number.isSafeInteger(targetCount) || targetCount < 0) return null;
    if (kind !== "missing_exam" && kind !== "retake_recommendation" && kind !== "class_retake_recommendation") return null;
    const targets = cleanStudentTargets(value.studentIds, value.studentNames, targetCount);
    if (!targets) return null;

    return {
        candidateId,
        status,
        channel: "kakao",
        kind,
        examId,
        title,
        targetCount,
        studentIds: targets.studentIds,
        studentNames: targets.studentNames,
        updatedAt,
    };
}

export function parseKakaoCandidateReviews(raw: string | null | undefined): KakaoCandidateReviewMap {
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw) as unknown;
        const items = Array.isArray(parsed)
            ? parsed
            : isRecord(parsed)
                ? Object.values(parsed)
                : [];

        const reviews: KakaoCandidateReviewMap = {};
        for (const item of items) {
            const record = normalizeReviewRecord(item);
            if (record) reviews[record.candidateId] = record;
        }
        return reviews;
    } catch {
        return {};
    }
}

export function readKakaoCandidateReviews(storage: Pick<Storage, "getItem">): KakaoCandidateReviewMap {
    return parseKakaoCandidateReviews(storage.getItem(KAKAO_CANDIDATE_REVIEW_STORAGE_KEY));
}

export function writeKakaoCandidateReviews(storage: Pick<Storage, "setItem">, reviews: KakaoCandidateReviewMap): boolean {
    try {
        storage.setItem(KAKAO_CANDIDATE_REVIEW_STORAGE_KEY, JSON.stringify(reviews));
        return true;
    } catch {
        return false;
    }
}

export function setKakaoCandidateReview(
    storage: Pick<Storage, "getItem" | "setItem">,
    candidate: KakaoNotificationCandidate,
    status: KakaoCandidateReviewStatus,
    now = new Date(),
): KakaoCandidateReviewMap {
    const reviews = readKakaoCandidateReviews(storage);
    reviews[candidate.id] = {
        candidateId: candidate.id,
        status,
        channel: "kakao",
        kind: candidate.kind,
        examId: candidate.examId,
        title: candidate.title,
        targetCount: candidate.targetCount,
        studentIds: candidate.studentIds,
        studentNames: candidate.studentNames,
        updatedAt: now.toISOString(),
    };
    writeKakaoCandidateReviews(storage, reviews);
    return reviews;
}

export function buildKakaoCandidateMessagePreview(candidate: KakaoNotificationCandidate): string {
    const firstTargets = candidate.studentNames.length > 0
        ? candidate.studentNames.slice(0, 3).join(", ")
        : candidate.targetCount > 0
            ? `${candidate.targetCount}명`
            : "대상 학생";
    const extraCount = Math.max(0, candidate.targetCount - 3);
    const targetLabel = extraCount > 0 ? `${firstTargets} 외 ${extraCount}명` : firstTargets;

    if (candidate.kind === "missing_exam") {
        return `[${candidate.examTitle}] ${targetLabel} 미응시 확인이 필요합니다. 제출 여부를 확인해 주세요.`;
    }

    if (candidate.kind === "class_retake_recommendation") {
        const group = candidate.groupNames[0]
            ? `${formatRegionScopedLabel(candidate.groupNames[0], candidate.regionNames[0])} `
            : "";
        return `[${candidate.examTitle}] ${group}취약 유형 보완 재시험 후보가 준비되었습니다.`;
    }

    return `[${candidate.examTitle}] 오답 유형 보완 재시험 후보가 준비되었습니다.`;
}

export function summarizeKakaoCandidateReviews(
    candidates: KakaoNotificationCandidate[],
    reviews: KakaoCandidateReviewMap,
) {
    const summary = {
        unreviewed: 0,
        ready: 0,
        hold: 0,
        excluded: 0,
    };

    for (const candidate of candidates) {
        const status = reviews[candidate.id]?.status;
        if (status === "ready") summary.ready += 1;
        else if (status === "hold") summary.hold += 1;
        else if (status === "excluded") summary.excluded += 1;
        else summary.unreviewed += 1;
    }

    return summary;
}
