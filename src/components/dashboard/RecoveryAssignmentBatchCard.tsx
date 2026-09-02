"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ClipboardCopy, Clock3, RotateCcw, Users } from "lucide-react";
import type { RecoveryAssignmentBatch, RecoveryAssignmentProposal } from "@/lib/recoveryAssignments";
import { formatRecoveryAssignmentBundle } from "@/lib/recoveryAssignments";
import { DEFAULT_RECOVERY_POLICY } from "@/lib/serviceRoadmap";
import { toast } from "@/components/Toast";
import styles from "./RecoveryAssignmentBatchCard.module.css";

interface RecoveryAssignmentBatchCardProps {
    batch: RecoveryAssignmentBatch;
    enabled: boolean;
}

function proposalNote(proposal: RecoveryAssignmentProposal): string | null {
    const notes: string[] = [];
    if (proposal.overflowCount > 0) notes.push(`나머지 ${proposal.overflowCount}문항 제외`);
    if (proposal.ungradedCount > 0) notes.push(`미채점 ${proposal.ungradedCount}문항`);
    if (proposal.needsIdentityReview) notes.push("명단 연결 확인");
    return notes.length > 0 ? notes.join(" · ") : null;
}

async function copyText(value: string): Promise<void> {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(value);
}

export default function RecoveryAssignmentBatchCard({ batch, enabled }: RecoveryAssignmentBatchCardProps) {
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
        () => new Set(batch.proposals.map(proposal => proposal.key)),
    );
    const selectedProposals = useMemo(
        () => batch.proposals.filter(proposal => selectedKeys.has(proposal.key)),
        [batch.proposals, selectedKeys],
    );
    const selectedQuestionCount = selectedProposals.reduce(
        (sum, proposal) => sum + proposal.questionIds.length,
        0,
    );

    const toggleProposal = (key: string) => {
        setSelectedKeys(current => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const selectAll = () => {
        setSelectedKeys(new Set(batch.proposals.map(proposal => proposal.key)));
    };

    const clearAll = () => setSelectedKeys(new Set());

    const copyBundle = async () => {
        const bundle = formatRecoveryAssignmentBundle(batch, selectedKeys, window.location.origin);
        if (!bundle) {
            toast.info("학생을 선택해주세요", "복사할 오답 회복 과제가 없습니다.");
            return;
        }
        try {
            await copyText(bundle);
            toast.success(
                "회복 링크 묶음 복사됨",
                `${selectedProposals.length}명 · ${selectedQuestionCount}문항을 복사했습니다.`,
            );
        } catch {
            toast.error("복사 실패", "브라우저 클립보드 권한을 확인해주세요.");
        }
    };

    const copyProposal = async (proposal: RecoveryAssignmentProposal) => {
        try {
            await copyText(`${proposal.studentName} · 오답 회복 ${proposal.questionIds.length}문항\n${window.location.origin}${proposal.href}`);
            toast.success("학생 링크 복사됨", `${proposal.studentName} · ${proposal.questionIds.length}문항`);
        } catch {
            toast.error("복사 실패", "브라우저 클립보드 권한을 확인해주세요.");
        }
    };

    return (
        <section className={styles.card} aria-labelledby="recovery-assignment-title">
            <div className={styles.headingRow}>
                <div>
                    <div className={styles.eyebrow}>프리미엄 핵심</div>
                    <h3 id="recovery-assignment-title">
                        <RotateCcw size={18} aria-hidden="true" />
                        오늘의 오답 회복 과제
                    </h3>
                    <p>
                        최신 원시험에서 오답·미응답이 {DEFAULT_RECOVERY_POLICY.minMissedQuestionsForAutoCandidate}개 이상인 학생만 골라 최대 {DEFAULT_RECOVERY_POLICY.maxQuestionsPerAssignment}문항으로 준비했습니다.
                    </p>
                </div>
                <span className={styles.statusBadge}>강사 승인 필요</span>
            </div>

            <div className={styles.summaryGrid} aria-label="오답 회복 과제 요약">
                <div>
                    <Users size={16} aria-hidden="true" />
                    <span>과제 후보</span>
                    <strong>{batch.candidateStudentCount}명</strong>
                </div>
                <div>
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <span>자동 제외</span>
                    <strong>{batch.noActionStudentCount}명</strong>
                </div>
                <div>
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>확인 표시</span>
                    <strong>{batch.exceptionStudentCount}명</strong>
                </div>
                <div>
                    <Clock3 size={16} aria-hidden="true" />
                    <span>권장 마감</span>
                    <strong>{DEFAULT_RECOVERY_POLICY.defaultDueInHours}시간</strong>
                </div>
            </div>

            {batch.proposals.length > 0 ? (
                <>
                    <div className={styles.reviewHeader}>
                        <div>
                            <strong>예외만 확인</strong>
                            <span>기본 선택 {batch.proposals.length}명 · 체크를 끄면 복사 대상에서 제외됩니다.</span>
                        </div>
                        {enabled && (
                            <div className={styles.selectionActions}>
                                <button type="button" onClick={selectAll}>전체 선택</button>
                                <button type="button" onClick={clearAll}>전체 해제</button>
                            </div>
                        )}
                    </div>

                    <div className={styles.proposalList}>
                        {batch.proposals.map(proposal => {
                            const note = proposalNote(proposal);
                            const selected = selectedKeys.has(proposal.key);
                            return (
                                <article key={proposal.key} className={`${styles.proposalRow} ${selected ? styles.proposalSelected : ""}`}>
                                    <label className={styles.proposalMain}>
                                        <input
                                            type="checkbox"
                                            checked={selected}
                                            disabled={!enabled}
                                            onChange={() => toggleProposal(proposal.key)}
                                            aria-label={`${proposal.studentName} 오답 회복 과제 선택`}
                                        />
                                        <span className={styles.studentCopy}>
                                            <strong>{proposal.studentName}</strong>
                                            <small>
                                                {[proposal.regionName, proposal.groupName].filter(Boolean).join(" · ") || "반 미지정"}
                                            </small>
                                        </span>
                                    </label>
                                    <div className={styles.assignmentMeta}>
                                        <strong>{proposal.questionIds.length}문항 · 약 {proposal.estimatedMinutes}분</strong>
                                        <small>
                                            {proposal.questionNumbers.join(", ")}번
                                            {proposal.unansweredCount > 0 ? ` · 미응답 ${proposal.unansweredCount}` : ""}
                                        </small>
                                    </div>
                                    <div className={styles.rowAction}>
                                        {note && <span className={styles.exceptionNote}>{note}</span>}
                                        {enabled && (
                                            <button type="button" onClick={() => void copyProposal(proposal)} aria-label={`${proposal.studentName} 링크 복사`}>
                                                <ClipboardCopy size={15} aria-hidden="true" />
                                                개별 복사
                                            </button>
                                        )}
                                    </div>
                                </article>
                            );
                        })}
                    </div>

                    <div className={styles.footer}>
                        <p>
                            선택 {selectedProposals.length}명 · {selectedQuestionCount}문항
                            <span>학생별 링크가 이름과 함께 복사됩니다.</span>
                        </p>
                        {enabled ? (
                            <button
                                type="button"
                                className={styles.primaryAction}
                                disabled={selectedProposals.length === 0}
                                onClick={() => void copyBundle()}
                            >
                                <ClipboardCopy size={16} aria-hidden="true" />
                                {selectedProposals.length}명 링크 묶음 복사
                            </button>
                        ) : (
                            <Link href="/teacher/billing" className={styles.primaryAction}>
                                Pro에서 일괄 준비
                            </Link>
                        )}
                    </div>
                </>
            ) : (
                <div className={styles.emptyState}>
                    <CheckCircle2 size={20} aria-hidden="true" />
                    <div>
                        <strong>자동으로 준비할 오답 과제가 없습니다.</strong>
                        <p>완료된 원시험이 없거나, 학생별 오답·미응답이 2문항 미만입니다.</p>
                    </div>
                </div>
            )}
        </section>
    );
}
