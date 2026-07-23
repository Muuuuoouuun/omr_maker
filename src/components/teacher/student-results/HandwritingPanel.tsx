"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Download, PenLine, Send } from "lucide-react";
import type { Attempt, AttemptFeedback, FeedbackDownloadPolicy, PdfDrawings } from "@/types/omr";
import { mergePdfDrawings } from "@/lib/feedbackPersistence";
import { formatKoreanDateTime } from "@/lib/pure";
import { getPlanLabel } from "@/utils/plans";
import StatusPill from "@/components/dashboard/StatusPill";
import LockedFeaturePanel from "./LockedFeaturePanel";
import styles from "./StudentResultHub.module.css";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

export type HandwritingStatus = "idle" | "loading" | "ready" | "error";
export type FeedbackViewMode = "student" | "markup" | "combined";

interface HandwritingPanelProps {
    attempt: Attempt;
    handwritingArchiveEnabled: boolean;
    feedbackEnabled: boolean;
    handwritingStatus: HandwritingStatus;
    pdfFile: File | null;
    drawings?: PdfDrawings;
    teacherMarkupDrawings: PdfDrawings;
    feedbackViewMode: FeedbackViewMode;
    onFeedbackViewModeChange(mode: FeedbackViewMode): void;
    onTeacherMarkupChange(page: number, newPaths: string[]): void;
    feedback: AttemptFeedback | null;
    feedbackSummary: string;
    onFeedbackSummaryChange(value: string): void;
    feedbackPolicy: FeedbackDownloadPolicy;
    onFeedbackPolicyChange(patch: Partial<FeedbackDownloadPolicy>): void;
    feedbackNotice: string;
    feedbackSaving: boolean;
    onSaveFeedback(returnAfterSave: boolean): Promise<void>;
    onDownloadHandwriting(): void;
    onRetry(): void;
}

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
}

function dateTimeLocalValue(iso?: string): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const offsetMs = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value: string): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatFeedbackDate(iso?: string): string {
    return iso ? formatKoreanDateTime(iso) : "-";
}

function EmptyState({ title, description }: { title: string; description: string }) {
    return (
        <div className={styles.state} role="status">
            <h2>{title}</h2>
            <p>{description}</p>
        </div>
    );
}

function ErrorState({ title, onRetry }: { title: string; onRetry(): void }) {
    return (
        <div className={styles.state} role="alert">
            <h2>{title}</h2>
            <p>네트워크 상태를 확인한 뒤 다시 시도해 주세요.</p>
            <button type="button" className="btn btn-secondary" onClick={onRetry}>다시 시도</button>
        </div>
    );
}

export default function HandwritingPanel({
    attempt,
    handwritingArchiveEnabled,
    feedbackEnabled,
    handwritingStatus,
    pdfFile,
    drawings,
    teacherMarkupDrawings,
    feedbackViewMode,
    onFeedbackViewModeChange,
    onTeacherMarkupChange,
    feedback,
    feedbackSummary,
    onFeedbackSummaryChange,
    feedbackPolicy,
    onFeedbackPolicyChange,
    feedbackNotice,
    feedbackSaving,
    onSaveFeedback,
    onDownloadHandwriting,
    onRetry,
}: HandwritingPanelProps) {
    if (!handwritingArchiveEnabled) {
        return (
            <LockedFeaturePanel
                title="학생 필기 보관"
                description="Pro 이상에서는 이후 제출부터 PDF 필기를 자동으로 보관합니다."
                previewItems={["문항별 필기 위치", "교사 첨삭", "합쳐 보기와 파일 저장"]}
            />
        );
    }

    if (!attempt.handwritingArchived) {
        return <EmptyState title="저장된 필기가 없습니다" description="이 제출에는 보관된 필기 원본이 없습니다." />;
    }

    if (handwritingStatus === "error") {
        return <ErrorState title="필기 원본을 불러오지 못했습니다" onRetry={onRetry} />;
    }

    if (handwritingStatus === "idle" || handwritingStatus === "loading") {
        return <EmptyState title="필기 원본을 불러오는 중입니다" description="PDF와 제출 시점의 필기 데이터를 준비하고 있습니다." />;
    }

    const handwriting = attempt.handwriting;
    const questionSummaries = Object.values(handwriting?.questions || {});
    const hasStudentDrawings = hasDrawings(drawings);
    const mergedReviewDrawings = mergePdfDrawings(drawings, teacherMarkupDrawings);
    const activeReviewDrawings = feedbackViewMode === "student"
        ? drawings
        : feedbackViewMode === "markup"
            ? teacherMarkupDrawings
            : mergedReviewDrawings;
    const canEditFeedbackMarkup = feedbackEnabled && feedbackViewMode === "markup";
    const canShowReviewPdf = !!pdfFile;
    const feedbackReturned = feedback?.status === "returned";

    return (
        <div className={styles.handwritingLayout}>
            <aside className={styles.handwritingSidebar}>
                <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="handwriting-metadata-title">
                    <div className={styles.sectionHeading}>
                        <h2 id="handwriting-metadata-title"><PenLine size={17} aria-hidden="true" /> 필기 보관</h2>
                        <StatusPill tone="success" label="저장됨" size="sm" />
                    </div>
                    <div className={styles.metadataList}>
                        <div>플랜: <strong>{getPlanLabel(handwriting?.plan || attempt.handwritingPlan || "free")}</strong></div>
                        <div>페이지: <strong>{handwriting?.summary.pageCount ?? attempt.drawingPageCount ?? 0}</strong></div>
                        <div>획 수: <strong>{handwriting?.summary.strokeCount ?? attempt.drawingStrokeCount ?? 0}</strong></div>
                        <div>문항 연결: <strong>{handwriting?.summary.questionCount ?? questionSummaries.length}</strong></div>
                    </div>
                    {questionSummaries.length > 0 && (
                        <div className={styles.questionChips} aria-label="필기 연결 문항">
                            {questionSummaries.slice(0, 18).map(question => (
                                <StatusPill key={question.questionId} tone="primary" size="sm" label={`${question.questionNumber}번`} />
                            ))}
                        </div>
                    )}
                    {hasStudentDrawings && (
                        <button type="button" onClick={onDownloadHandwriting} className="btn btn-secondary" style={{ width: "100%", marginTop: "0.9rem", justifyContent: "center" }}>
                            <Download size={14} aria-hidden="true" /> 필기 원본 파일 저장
                        </button>
                    )}
                </section>

                <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="teacher-feedback-title">
                    <div className={styles.sectionHeading}>
                        <h2 id="teacher-feedback-title"><Send size={17} aria-hidden="true" /> 교사 피드백</h2>
                        <StatusPill
                            tone={feedbackReturned ? "success" : feedbackEnabled ? "warning" : "muted"}
                            label={feedbackReturned ? "반환됨" : feedbackEnabled ? "초안" : "Pro"}
                            size="sm"
                        />
                    </div>
                    {!feedbackEnabled ? (
                        <div className={styles.panelStack}>
                            <p className={styles.emptyText}>교사 첨삭, 학생 반환, 열람 확인은 Pro 이상에서 사용할 수 있습니다.</p>
                            <Link href="/teacher/billing" className="btn btn-primary" style={{ justifyContent: "center" }}>플랜 보기</Link>
                        </div>
                    ) : (
                        <div className={styles.feedbackForm}>
                            <label>
                                전체 피드백
                                <textarea
                                    value={feedbackSummary}
                                    onChange={event => onFeedbackSummaryChange(event.target.value)}
                                    placeholder="학생에게 전달할 핵심 피드백을 적어주세요."
                                    rows={4}
                                />
                            </label>
                            <label className={styles.checkboxLabel}>
                                <input
                                    type="checkbox"
                                    checked={feedbackPolicy.allowStudentDownload}
                                    onChange={event => onFeedbackPolicyChange({ allowStudentDownload: event.target.checked })}
                                />
                                학생 다운로드 허용
                            </label>
                            <label className={styles.checkboxLabel}>
                                <input
                                    type="checkbox"
                                    checked={feedbackPolicy.allowAnnotatedPdfDownload}
                                    onChange={event => onFeedbackPolicyChange({ allowAnnotatedPdfDownload: event.target.checked })}
                                />
                                첨삭/필기 파일 다운로드 허용
                            </label>
                            <label>
                                다운로드 만료일
                                <input
                                    type="datetime-local"
                                    value={dateTimeLocalValue(feedbackPolicy.expiresAt)}
                                    onChange={event => onFeedbackPolicyChange({ expiresAt: dateTimeLocalToIso(event.target.value) })}
                                />
                            </label>
                            <div className={styles.feedbackActions}>
                                <button type="button" className="btn btn-secondary" disabled={feedbackSaving} onClick={() => void onSaveFeedback(false)}>초안 저장</button>
                                <button type="button" className="btn btn-primary" disabled={feedbackSaving} onClick={() => void onSaveFeedback(true)}>학생에게 반환</button>
                            </div>
                            {feedbackNotice && <div className={styles.feedbackNotice} role="status">{feedbackNotice}</div>}
                            <div className={styles.feedbackReceipt}>
                                <div>알림: <strong>{feedback?.delivery.notificationStatus === "queued" ? "대기" : feedback?.delivery.notificationStatus === "sent" ? "노출됨" : "-"}</strong></div>
                                <div>최초 열람: <strong>{formatFeedbackDate(feedback?.delivery.firstOpenedAt)}</strong></div>
                                <div>마지막 열람: <strong>{formatFeedbackDate(feedback?.delivery.lastOpenedAt)}</strong></div>
                                <div>열람 횟수: <strong>{feedback?.delivery.openCount ?? 0}</strong></div>
                            </div>
                        </div>
                    )}
                </section>
            </aside>

            <section className={`bento-card ${styles.handwritingViewer}`} aria-labelledby="handwriting-viewer-title">
                <div className={styles.viewerHeader}>
                    <div>
                        <h2 id="handwriting-viewer-title">학생 풀이 필기</h2>
                        <p>제출 시점의 PDF 필기 레이어를 읽고 교사 첨삭을 더할 수 있습니다.</p>
                    </div>
                    <div className={styles.viewModeGroup} role="group" aria-label="필기 표시 방식">
                        {([
                            ["student", "학생 필기"],
                            ["markup", "교사 첨삭"],
                            ["combined", "합쳐 보기"],
                        ] as const).map(([mode, label]) => (
                            <button
                                key={mode}
                                type="button"
                                className={`btn ${feedbackViewMode === mode ? "btn-primary" : "btn-secondary"}`}
                                onClick={() => onFeedbackViewModeChange(mode)}
                                aria-pressed={feedbackViewMode === mode}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className={styles.viewerBody}>
                    {canShowReviewPdf ? (
                        <PDFViewer
                            file={pdfFile}
                            onLoadSuccess={() => { }}
                            enableDrawing={canEditFeedbackMarkup}
                            readOnlyDrawings={!canEditFeedbackMarkup}
                            drawings={activeReviewDrawings}
                            onDrawingsChange={canEditFeedbackMarkup ? onTeacherMarkupChange : undefined}
                        />
                    ) : (
                        <ErrorState title="필기 원본을 표시할 수 없습니다" onRetry={onRetry} />
                    )}
                </div>
            </section>
        </div>
    );
}
