"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Attempt, AttemptFeedback, Exam, FeedbackDownloadPolicy, PdfDrawings } from "@/types/omr";
import { loadJsonRecord, storedDataUrlToFile } from "@/utils/blobStore";
import { getTeacherRemoteAssetUrl } from "@/app/actions/remoteAssets";
import { hasPlanEntitlement } from "@/utils/plans";
import { useServerPlan } from "@/lib/useServerPlan";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import { readActiveWorkspaceContext } from "@/lib/workspaceContext";
import {
    loadTeacherAttempt as loadTeacherAttemptRecord,
    loadTeacherAttempts,
    saveTeacherAttempt,
} from "@/lib/teacherAttemptClient";
import { loadTeacherExam, loadTeacherExams } from "@/lib/teacherExamClient";
import { loadTeacherRosterSnapshot } from "@/lib/teacherRosterClient";
import type { RosterStudent } from "@/lib/rosterStorage";
import { buildStudentProfileInsight } from "@/lib/studentProfileAnalytics";
import { answerStudentQuestion } from "@/lib/studentQuestions";
import { toast } from "@/components/Toast";
import {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    getAttemptQuestionResults,
    summarizeAttemptBehavior,
    summarizeAttemptScore,
} from "@/lib/premiumAnalytics";
import { hasTeacherSession, readTeacherSession } from "@/lib/teacherSession";
import ThemeToggle from "@/components/ThemeToggle";
import {
    DEFAULT_FEEDBACK_DOWNLOAD_POLICY,
    createAttemptFeedbackDraft,
    loadFeedbackMarkupDrawings,
} from "@/lib/feedbackPersistence";
import {
    loadTeacherAttemptFeedback,
    returnTeacherAttemptFeedback,
    saveTeacherAttemptFeedbackDraft,
} from "@/lib/teacherFeedbackClient";
import {
    buildStudentAttemptSeries,
    filterCumulativeAttemptsForStudent,
    matchRosterStudentForAttempt,
    parseStudentResultView,
} from "@/lib/studentResultHub";
import StudentResultHeader from "@/components/teacher/student-results/StudentResultHeader";
import StudentResultTabs from "@/components/teacher/student-results/StudentResultTabs";
import AnswersPanel from "@/components/teacher/student-results/AnswersPanel";
import AnalyticsPanel from "@/components/teacher/student-results/AnalyticsPanel";
import HandwritingPanel from "@/components/teacher/student-results/HandwritingPanel";
import ReportPanel from "@/components/teacher/student-results/ReportPanel";
import type { CumulativeLoadStatus } from "@/components/teacher/student-results/CumulativeGrowthPanel";
import styles from "@/components/teacher/student-results/StudentResultHub.module.css";

function hasTeacherAccess(): boolean {
    return hasTeacherSession();
}

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
}

async function loadTeacherPdfFile(exam: Exam): Promise<File | null> {
    const pdfData = exam.pdfDataRef?.store === "remote"
        ? await getTeacherRemoteAssetUrl(exam.pdfDataRef)
            .then(result => result.status === "signed" ? result.signedUrl : undefined)
        : exam.pdfData;
    return storedDataUrlToFile("problem.pdf", pdfData, exam.pdfDataRef);
}

async function loadAttemptDrawings(attempt: Attempt): Promise<PdfDrawings | undefined> {
    if (hasDrawings(attempt.drawings)) return attempt.drawings;
    const ref = attempt.handwriting?.strokesRef || attempt.drawingsRef;
    if (!ref) return undefined;
    if (ref.store !== "remote") return (await loadJsonRecord<PdfDrawings>(ref)) || undefined;
    const signed = await getTeacherRemoteAssetUrl(ref);
    if (signed.status !== "signed") return undefined;
    const response = await fetch(signed.signedUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("handwriting_download_failed");
    return response.json() as Promise<PdfDrawings>;
}

export default function TeacherAttemptPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const id = params?.attemptId as string;
    const activeView = parseStudentResultView(searchParams.get("view"));
    const activeAttemptIdRef = useRef(id);
    const handwritingLoadingAttemptRef = useRef<string | null>(null);
    const handwritingReadyAttemptIdRef = useRef<string | null>(null);
    const cumulativeLoadingAttemptRef = useRef<string | null>(null);
    const cumulativeSettledAttemptIdRef = useRef<string | null>(null);
    useLayoutEffect(() => {
        activeAttemptIdRef.current = id;
    }, [id]);

    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [peerAttempts, setPeerAttempts] = useState<Attempt[]>([]);
    const [exam, setExam] = useState<Exam | null>(null);
    const [drawings, setDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [handwritingStatus, setHandwritingStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
    const [accessDenied, setAccessDenied] = useState(false);
    const { plan: currentPlan } = useServerPlan();
    const [feedback, setFeedback] = useState<AttemptFeedback | null>(null);
    const [feedbackSummary, setFeedbackSummary] = useState("");
    const [feedbackPolicy, setFeedbackPolicy] = useState<FeedbackDownloadPolicy>(DEFAULT_FEEDBACK_DOWNLOAD_POLICY);
    const [teacherMarkupDrawings, setTeacherMarkupDrawings] = useState<PdfDrawings>({});
    const [feedbackViewMode, setFeedbackViewMode] = useState<"student" | "markup" | "combined">("student");
    const [feedbackNotice, setFeedbackNotice] = useState("");
    const [feedbackSaving, setFeedbackSaving] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [answerDrafts, setAnswerDrafts] = useState<Record<number, string>>({});
    const [savingAnswerFor, setSavingAnswerFor] = useState<number | null>(null);
    const [cumulativeAttempts, setCumulativeAttempts] = useState<Attempt[]>([]);
    const [cumulativeExams, setCumulativeExams] = useState<Exam[]>([]);
    const [rosterStudent, setRosterStudent] = useState<RosterStudent | null>(null);
    const [cumulativeStatus, setCumulativeStatus] = useState<CumulativeLoadStatus>("idle");
    const [cumulativeError, setCumulativeError] = useState("");
    const [cumulativeAttemptId, setCumulativeAttemptId] = useState<string | null>(null);
    const [cumulativeLoadRequest, setCumulativeLoadRequest] = useState(0);
    const [subQuestionFilter, setSubQuestionFilter] = useState<'needs_review' | 'all'>('needs_review');
    const [savingSubQuestionKey, setSavingSubQuestionKey] = useState<string | null>(null);
    const pdfExportEnabled = hasPlanEntitlement(currentPlan, "pdfExport");
    const handwritingArchiveEnabled = hasPlanEntitlement(currentPlan, "handwritingArchive");
    const feedbackEnabled = hasPlanEntitlement(currentPlan, "feedbackMarkup");
    const studentGrowthReportsEnabled = hasPlanEntitlement(currentPlan, "studentGrowthReports");

    useEffect(() => {
        let cancelled = false;
        const loadTeacherAttempt = async () => {
            setLoaded(false);
            setAccessDenied(false);
            setAttempt(null);
            setExam(null);
            setDrawings(undefined);
            setPdfFile(null);
            setHandwritingStatus("idle");
            handwritingLoadingAttemptRef.current = null;
            handwritingReadyAttemptIdRef.current = null;
            setFeedback(null);
            setFeedbackSummary("");
            setFeedbackPolicy(DEFAULT_FEEDBACK_DOWNLOAD_POLICY);
            setTeacherMarkupDrawings({});
            setFeedbackViewMode("student");
            setFeedbackNotice("");
            setFeedbackSaving(false);
            setAnswerDrafts({});
            setSavingAnswerFor(null);
            setCumulativeAttempts([]);
            setCumulativeExams([]);
            setRosterStudent(null);
            setCumulativeStatus("idle");
            setCumulativeError("");
            setCumulativeAttemptId(null);
            setCumulativeLoadRequest(0);
            cumulativeLoadingAttemptRef.current = null;
            cumulativeSettledAttemptIdRef.current = null;
            setSubQuestionFilter('needs_review');
            setSavingSubQuestionKey(null);

            if (!hasTeacherAccess()) {
                setAccessDenied(true);
                setLoaded(true);
                return;
            }

            try {
                const found = await loadTeacherAttemptRecord(id);
                if (cancelled) return;
                if (!found) {
                    setLoaded(true);
                    return;
                }

                // Keep a client-side defense in depth on top of the canonical,
                // organization-scoped teacher gateway. Legacy rows without an
                // organizationId remain readable during migration.
                const activeOrganizationId = readActiveWorkspaceContext().organizationId?.trim();
                const attemptOrganizationId = found.organizationId?.trim();
                if (attemptOrganizationId && activeOrganizationId && attemptOrganizationId !== activeOrganizationId) {
                    setAccessDenied(true);
                    setLoaded(true);
                    return;
                }

                setAttempt(found);
                void loadTeacherAttempts(found.examId)
                    .then(result => {
                        if (!cancelled) setPeerAttempts(result.items);
                    })
                    .catch(() => undefined);

                const existingFeedback = await loadTeacherAttemptFeedback(found.id);
                if (!cancelled) {
                    const nextFeedback = existingFeedback || createAttemptFeedbackDraft(found);
                    setFeedback(nextFeedback);
                    setFeedbackSummary(nextFeedback.summary || "");
                    setFeedbackPolicy(nextFeedback.downloadPolicy);
                }
                if (cancelled) return;

                const parsedExam = await loadTeacherExam(found.examId);
                if (cancelled) return;
                if (parsedExam) setExam(parsedExam);
                setLoaded(true);
            } catch {
                if (!cancelled) setLoaded(true);
            }
        };

        void loadTeacherAttempt();

        return () => { cancelled = true; };
    }, [id]);

    const loadHandwritingResources = useCallback(async () => {
        if (!attempt || handwritingStatus === "loading" || handwritingStatus === "ready") return;
        const targetAttemptId = attempt.id;
        if (activeAttemptIdRef.current !== targetAttemptId) return;
        if (handwritingLoadingAttemptRef.current === targetAttemptId) return;
        handwritingLoadingAttemptRef.current = targetAttemptId;
        handwritingReadyAttemptIdRef.current = null;
        setHandwritingStatus("loading");
        try {
            const loadedExam = exam || await loadTeacherExam(attempt.examId);
            if (activeAttemptIdRef.current !== targetAttemptId) return;
            if (loadedExam && !exam) setExam(loadedExam);

            const [file, restored, markupDrawings] = await Promise.all([
                loadedExam ? loadTeacherPdfFile(loadedExam) : Promise.resolve(null),
                loadAttemptDrawings(attempt),
                feedback ? loadFeedbackMarkupDrawings(feedback) : Promise.resolve(null),
            ]);
            if (activeAttemptIdRef.current !== targetAttemptId) return;

            setPdfFile(file);
            setDrawings(restored);
            if (markupDrawings) setTeacherMarkupDrawings(markupDrawings);
            const drawingsReady = restored !== undefined;
            if (file && drawingsReady) {
                handwritingReadyAttemptIdRef.current = targetAttemptId;
                setHandwritingStatus("ready");
            } else {
                handwritingReadyAttemptIdRef.current = null;
                setHandwritingStatus("error");
            }
        } catch {
            if (activeAttemptIdRef.current === targetAttemptId) {
                handwritingReadyAttemptIdRef.current = null;
                setHandwritingStatus("error");
            }
        } finally {
            if (handwritingLoadingAttemptRef.current === targetAttemptId) {
                handwritingLoadingAttemptRef.current = null;
            }
        }
    }, [attempt, exam, feedback, handwritingStatus]);

    useEffect(() => {
        if (activeView === "handwriting" && handwritingArchiveEnabled && attempt?.handwritingArchived) {
            if (!loaded || handwritingStatus !== "idle") return;
            const timeoutId = window.setTimeout(() => {
                void loadHandwritingResources();
            }, 0);
            return () => window.clearTimeout(timeoutId);
        }
    }, [activeView, attempt, handwritingArchiveEnabled, handwritingStatus, loadHandwritingResources, loaded]);

    const retryCumulativeLoad = useCallback(() => {
        const targetAttemptId = attempt?.id;
        if (!targetAttemptId || activeAttemptIdRef.current !== targetAttemptId) return;
        cumulativeSettledAttemptIdRef.current = null;
        setCumulativeStatus("idle");
        setCumulativeError("");
        setCumulativeLoadRequest(value => value + 1);
    }, [attempt]);

    useEffect(() => {
        if (!studentGrowthReportsEnabled) return;
        if (activeView !== "report" && activeView !== "analytics") return;
        if (!loaded || !attempt) return;
        const targetAttemptId = attempt.id;
        if (activeAttemptIdRef.current !== targetAttemptId) return;
        if (cumulativeLoadingAttemptRef.current === targetAttemptId) return;
        if (cumulativeSettledAttemptIdRef.current === targetAttemptId) return;

        cumulativeLoadingAttemptRef.current = targetAttemptId;
        setCumulativeAttemptId(targetAttemptId);
        setCumulativeStatus("loading");
        setCumulativeError("");

        void (async () => {
            try {
                const [attemptResult, examResult, rosterResult] = await Promise.all([
                    loadTeacherAttempts(),
                    loadTeacherExams(),
                    loadTeacherRosterSnapshot(window.localStorage),
                ]);
                if (activeAttemptIdRef.current !== targetAttemptId) return;
                const matchedStudent = matchRosterStudentForAttempt(attempt, rosterResult.students);
                const filteredAttempts = filterCumulativeAttemptsForStudent(attempt, attemptResult.items);
                const warnings = [attemptResult.remoteError, examResult.remoteError, rosterResult.remoteError]
                    .filter((message): message is string => Boolean(message));
                setCumulativeAttempts(filteredAttempts);
                setCumulativeExams(examResult.items);
                setRosterStudent(matchedStudent || null);
                cumulativeSettledAttemptIdRef.current = targetAttemptId;
                setCumulativeError(warnings.join(" "));
                if (warnings.length > 0) {
                    setCumulativeStatus("stale");
                } else {
                    setCumulativeStatus("ready");
                }
            } catch {
                if (activeAttemptIdRef.current !== targetAttemptId) return;
                setCumulativeError("잠시 후 다시 시도해 주세요.");
                setCumulativeStatus("error");
            } finally {
                if (cumulativeLoadingAttemptRef.current === targetAttemptId) {
                    cumulativeLoadingAttemptRef.current = null;
                }
            }
        })();
    }, [activeView, attempt, cumulativeLoadRequest, loaded, studentGrowthReportsEnabled]);

    const analytics = useMemo(() => {
        if (!attempt || !exam) return null;
        const questionResults = getAttemptQuestionResults(exam, attempt);
        const score = summarizeAttemptScore(exam, attempt);
        const counts = questionResults.reduce((acc, result) => {
            if (result.status === "correct") acc.correctCount += 1;
            if (result.status === "wrong") acc.incorrectCount += 1;
            if (result.status === "unanswered") acc.unansweredCount += 1;
            if (result.status === "ungraded") acc.ungradedCount += 1;
            return acc;
        }, { correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 });
        const wrongResults = questionResults.filter(result => result.status === "wrong" || result.status === "unanswered");
        const retakeQuestionIds = buildRetakeQuestionIds(exam, attempt);
        const weaknessGroups = buildStudentWeaknessGroups(exam, attempt).slice(0, 3);
        const recommendations = buildLearningRecommendations(exam, [attempt], {
            scope: "attempt",
            attempt,
            limit: 3,
        });
        const behavior = summarizeAttemptBehavior(attempt);

        return {
            questionResults,
            score,
            counts,
            wrongResults,
            retakeQuestionIds,
            weaknessGroups,
            recommendations,
            behavior,
        };
    }, [attempt, exam]);

    const attemptSeries = useMemo(() => {
        if (!attempt) return [];
        const series = buildStudentAttemptSeries(attempt, peerAttempts.length ? peerAttempts : [attempt]);
        return series.length > 0 ? series : buildStudentAttemptSeries(attempt, [attempt]);
    }, [attempt, peerAttempts]);

    const cumulativeInsight = useMemo(() => {
        if (!attempt || cumulativeAttemptId !== attempt.id || !rosterStudent) return null;
        return buildStudentProfileInsight(
            rosterStudent,
            cumulativeAttempts,
            new Map(cumulativeExams.map(item => [item.id, item])),
            { recentLimit: 8, weaknessLimit: 6 },
        );
    }, [attempt, cumulativeAttemptId, cumulativeAttempts, cumulativeExams, rosterStudent]);

    const selectedAttemptLabel = useMemo(() => {
        const selected = attemptSeries.find(item => item.attempt.id === attempt?.id);
        if (!selected) return attempt?.retake ? "재시험" : "원시험";
        return `${selected.kind === "retake" ? "재시험" : "원시험"} ${selected.ordinal}회`;
    }, [attempt, attemptSeries]);

    const retakeScoreDelta = useMemo(() => {
        if (!attempt?.retake) return null;
        const sourceAttempt = [
            ...attemptSeries.map(item => item.attempt),
            ...cumulativeAttempts,
        ].find(item => item.id === attempt.retake?.sourceAttemptId && item.id !== attempt.id);
        if (!sourceAttempt) return null;
        const sourceExam = sourceAttempt.examId === exam?.id
            ? exam
            : cumulativeExams.find(item => item.id === sourceAttempt.examId);
        const sourceScorePercent = sourceExam
            ? summarizeAttemptScore(sourceExam, sourceAttempt).scorePercent
            : safeScorePercent(sourceAttempt.score, sourceAttempt.totalScore);
        const currentScorePercent = analytics?.score.scorePercent
            ?? safeScorePercent(attempt.score, attempt.totalScore);
        return {
            sourceScorePercent,
            currentScorePercent,
            delta: currentScorePercent - sourceScorePercent,
        };
    }, [analytics, attempt, attemptSeries, cumulativeAttempts, cumulativeExams, exam]);

    const handleTeacherMarkupChange = (page: number, newPaths: string[]) => {
        setTeacherMarkupDrawings(prev => ({ ...prev, [page]: newPaths }));
    };

    const updateFeedbackPolicy = (patch: Partial<FeedbackDownloadPolicy>) => {
        setFeedbackPolicy(prev => ({ ...prev, ...patch }));
    };

    const saveFeedback = async (returnAfterSave = false) => {
        if (!attempt || !feedbackEnabled) return;
        const targetAttemptId = attempt.id;
        if (activeAttemptIdRef.current !== targetAttemptId) return;
        setFeedbackSaving(true);
        setFeedbackNotice("");
        const base = feedback || createAttemptFeedbackDraft(attempt);
        const nextFeedback: AttemptFeedback = {
            ...base,
            summary: feedbackSummary.trim() || undefined,
            downloadPolicy: feedbackPolicy,
        };
        const markupDrawingsForSave = handwritingStatus === "ready"
            && handwritingReadyAttemptIdRef.current === targetAttemptId
            && activeAttemptIdRef.current === targetAttemptId
            ? teacherMarkupDrawings
            : undefined;

        try {
            const saveResult = await saveTeacherAttemptFeedbackDraft(nextFeedback, markupDrawingsForSave);
            if (activeAttemptIdRef.current !== targetAttemptId) return;
            if (!saveResult.localSaved && !saveResult.remoteSaved) {
                setFeedbackNotice(saveResult.remoteError || "피드백을 저장하지 못했습니다.");
                return;
            }

            let latest = await loadTeacherAttemptFeedback(targetAttemptId);
            if (activeAttemptIdRef.current !== targetAttemptId) return;
            if (returnAfterSave && latest) {
                const returnResult = await returnTeacherAttemptFeedback(latest.id);
                if (activeAttemptIdRef.current !== targetAttemptId) return;
                if (!returnResult.localSaved && !returnResult.remoteSaved) {
                    setFeedbackNotice(returnResult.remoteError || "초안은 저장됐지만 학생에게 반환하지 못했습니다.");
                    return;
                }
                latest = await loadTeacherAttemptFeedback(targetAttemptId);
                if (activeAttemptIdRef.current !== targetAttemptId) return;
            }

            if (latest) {
                setFeedback(latest);
                setFeedbackSummary(latest.summary || "");
                setFeedbackPolicy(latest.downloadPolicy);
            }
            setFeedbackNotice(returnAfterSave ? "학생에게 피드백을 반환했습니다." : "피드백 초안을 저장했습니다.");
        } catch {
            if (activeAttemptIdRef.current === targetAttemptId) {
                setFeedbackNotice("피드백 저장 중 오류가 발생했습니다.");
            }
        } finally {
            if (activeAttemptIdRef.current === targetAttemptId) setFeedbackSaving(false);
        }
    };

    if (accessDenied) {
        return (
            <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}>
                <div>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.5rem' }}>선생님 로그인이 필요합니다.</h1>
                    <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>학생 풀이 필기는 교사 권한에서만 열람할 수 있습니다.</p>
                    <Link href="/" className="btn btn-primary">로그인으로 이동</Link>
                </div>
            </div>
        );
    }

    if (!loaded || (attempt !== null && attempt.id !== id)) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>;
    }

    if (!attempt) {
        // F3: loaded but no attempt (deleted, never synced, or wrong id) previously
        // spun forever. Show a real "not found" screen instead.
        return (
            <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}>
                <div>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.5rem' }}>응시 기록을 찾을 수 없습니다.</h1>
                    <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>삭제되었거나 접근할 수 없는 기록일 수 있습니다.</p>
                    <Link href="/teacher/dashboard" className="btn btn-primary">대시보드로 이동</Link>
                </div>
            </div>
        );
    }

    const cumulativeStateMatchesAttempt = cumulativeAttemptId === attempt.id;

    // F2: when the exam payload can't be loaded, analytics is null. Fall back to
    // the score stored on the attempt so the header percent matches the score
    // line below instead of contradicting it with a hard 0%.
    const answerQuestionResults = analytics?.questionResults ?? attempt.questionResults ?? [];
    const answerCounts = analytics?.counts ?? answerQuestionResults.reduce((acc, result) => {
        if (result.status === "correct") acc.correctCount += 1;
        if (result.status === "wrong") acc.incorrectCount += 1;
        if (result.status === "unanswered") acc.unansweredCount += 1;
        if (result.status === "ungraded") acc.ungradedCount += 1;
        return acc;
    }, { correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 });
    const setSubQuestionReviewed = async (questionId: number, subQuestionId: string, reviewed: boolean) => {
        const currentAnswer = attempt.subQuestionAnswers?.[questionId]?.[subQuestionId];
        if (!currentAnswer) return;
        const targetAttemptId = attempt.id;
        if (activeAttemptIdRef.current !== targetAttemptId) return;
        const key = `${questionId}:${subQuestionId}`;
        setSavingSubQuestionKey(key);
        const next: Attempt = {
            ...attempt,
            subQuestionAnswers: {
                ...(attempt.subQuestionAnswers || {}),
                [questionId]: {
                    ...(attempt.subQuestionAnswers?.[questionId] || {}),
                    [subQuestionId]: {
                        ...currentAnswer,
                        reviewStatus: reviewed ? 'reviewed' : 'needs_review',
                        reviewedAt: reviewed ? new Date().toISOString() : undefined,
                        reviewedBy: reviewed ? readTeacherSession()?.displayName : undefined,
                    },
                },
            },
        };
        try {
            const result = await saveTeacherAttempt(next);
            if (activeAttemptIdRef.current !== targetAttemptId) return;
            if (!result.localSaved && !result.remoteSaved) {
                throw new Error(result.remoteError || '심화 응답 검토 상태를 저장하지 못했습니다.');
            }
            setAttempt(next);
            if (!result.remoteSaved) toast.info('로컬 저장됨', '개발 모드에서 이 기기에 검토 상태를 저장했습니다.');
        } catch {
            if (activeAttemptIdRef.current === targetAttemptId) {
                toast.error('검토 상태 저장 실패', '네트워크 상태를 확인하고 다시 시도해 주세요.');
            }
        } finally {
            if (activeAttemptIdRef.current === targetAttemptId) setSavingSubQuestionKey(null);
        }
    };
    const handleAnswerQuestion = async (questionId: number) => {
        const body = (answerDrafts[questionId] || "").trim();
        if (!body) return;
        const targetAttemptId = attempt.id;
        if (activeAttemptIdRef.current !== targetAttemptId) return;
        const teacherName = readTeacherSession()?.displayName;
        setSavingAnswerFor(questionId);
        // Merge the reply onto the freshest server row, not the local-first cache
        // this page loaded. The canonical mutation writes the full payload last-writer-wins,
        // so replying against a stale snapshot would silently drop any question the
        // student asked after this device cached the attempt.
        const nowIso = new Date().toISOString();
        let base = attempt;
        try {
            // The server gateway scopes this fresh fetch to the signed-in teacher's workspace.
            const fresh = await loadTeacherAttemptRecord(targetAttemptId);
            if (activeAttemptIdRef.current !== targetAttemptId) return;
            if (fresh) base = fresh;
        } catch {
            // Offline or Supabase unavailable — fall back to the cached attempt.
            if (activeAttemptIdRef.current !== targetAttemptId) return;
        }
        if (activeAttemptIdRef.current !== targetAttemptId) return;
        let updated = answerStudentQuestion(base, questionId, body, nowIso, teacherName);
        if (!updated && base !== attempt) {
            // F5: the fresh remote row can be missing this question note (the
            // student asked it after this device cached, or the remote copy
            // predates it). Union the locally-loaded note onto the fresh row so
            // the reply attaches without dropping the fresh copy's other notes.
            const localNote = (attempt.studentQuestions || []).find(note => note.questionId === questionId);
            if (localNote) {
                const mergedBase: Attempt = {
                    ...base,
                    studentQuestions: [
                        ...(base.studentQuestions || []).filter(note => note.questionId !== questionId),
                        localNote,
                    ],
                };
                updated = answerStudentQuestion(mergedBase, questionId, body, nowIso, teacherName);
            }
        }
        if (!updated) {
            // Never silent: tell the teacher why the reply couldn't attach.
            setSavingAnswerFor(null);
            toast.error("답변 전송 실패", "질문을 찾지 못했습니다. 화면을 새로고침한 뒤 다시 시도해주세요.");
            return;
        }
        try {
            const result = await saveTeacherAttempt(updated);
            if (activeAttemptIdRef.current !== targetAttemptId) return;
            if (!result.localSaved && !result.remoteSaved) {
                throw new Error(result.remoteError || "attempt save failed");
            }
            setAttempt(updated);
            setAnswerDrafts(prev => ({ ...prev, [questionId]: "" }));
            if (result.remoteSaved) {
                toast.success("답변 전송됨", "학생 리뷰 화면에서 답변을 볼 수 있습니다.");
            } else {
                toast.info("답변 저장됨", "서버 동기화는 다음 접속 때 재시도됩니다.");
            }
        } catch {
            if (activeAttemptIdRef.current === targetAttemptId) {
                toast.error("답변 저장 실패", "브라우저 저장소를 확인한 뒤 다시 시도해주세요.");
            }
        } finally {
            if (activeAttemptIdRef.current === targetAttemptId) setSavingAnswerFor(null);
        }
    };
    const handleDownloadHandwriting = () => {
        if (!drawings) return;
        const payload = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            attemptId: attempt.id,
            examId: attempt.examId,
            examTitle: attempt.examTitle,
            studentName: attempt.studentName,
            finishedAt: attempt.finishedAt,
            handwriting: attempt.handwriting,
            questionDrawings: attempt.questionDrawings || [],
            drawings,
        };
        const safeTitle = attempt.examTitle.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 48) || "exam";
        const safeStudent = attempt.studentName.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 32) || "student";
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeTitle}_${safeStudent}_handwriting.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="layout-main teacher-attempt-page" style={{ minHeight: '100vh', background: 'var(--background)' }}>
            <header className={`header teacher-attempt-print-hide ${styles.screenOnly}`}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                        <button
                            type="button"
                            onClick={() => router.back()}
                            aria-label="이전 화면으로"
                            title="이전 화면으로"
                            style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}
                        >
                            ←
                        </button>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{attempt.studentName} · {formatKoreanDateTime(attempt.finishedAt)}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <Link href={`/teacher/exam/${attempt.examId}`} className="btn btn-secondary" style={{ fontSize: '0.85rem' }}>
                            시험 결과로
                        </Link>
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            <main className="container teacher-attempt-main" style={{ padding: '1.5rem 1rem 2.5rem' }}>
                <div className={styles.shell}>
                    <StudentResultHeader
                        attempt={attempt}
                        examTitle={exam?.title}
                        series={attemptSeries}
                        activeView={activeView}
                    />
                    <StudentResultTabs attemptId={attempt.id} activeView={activeView} />
                    <section
                        id={`student-result-panel-${activeView}`}
                        role="tabpanel"
                        aria-labelledby={`student-result-tab-${activeView}`}
                        className={styles.panel}
                    >
                        {activeView === "answers" ? (
                            <AnswersPanel
                                attempt={attempt}
                                exam={exam ?? undefined}
                                questionResults={answerQuestionResults}
                                counts={answerCounts}
                                score={analytics?.score}
                                subQuestionFilter={subQuestionFilter}
                                onSubQuestionFilterChange={setSubQuestionFilter}
                                onReviewSubQuestion={setSubQuestionReviewed}
                                savingSubQuestionKey={savingSubQuestionKey}
                                answerDrafts={answerDrafts}
                                onAnswerDraftChange={(questionId, value) => setAnswerDrafts(prev => ({ ...prev, [questionId]: value }))}
                                onAnswerStudentQuestion={handleAnswerQuestion}
                                savingQuestionId={savingAnswerFor}
                            />
                        ) : activeView === "analytics" ? (
                            <AnalyticsPanel
                                attempt={attempt}
                                exam={exam ?? undefined}
                                data={analytics ? {
                                    wrongResults: analytics.wrongResults,
                                    weaknessGroups: analytics.weaknessGroups,
                                    recommendations: analytics.recommendations,
                                    retakeQuestionIds: analytics.retakeQuestionIds,
                                    behavior: analytics.behavior,
                                } : null}
                                cumulativeInsight={cumulativeStateMatchesAttempt ? cumulativeInsight : null}
                                cumulativeStatus={cumulativeStateMatchesAttempt ? cumulativeStatus : "idle"}
                                cumulativeError={cumulativeStateMatchesAttempt ? cumulativeError : ""}
                                rosterMatched={cumulativeStateMatchesAttempt && !!rosterStudent}
                                studentGrowthReportsEnabled={studentGrowthReportsEnabled}
                                onRetryCumulative={retryCumulativeLoad}
                            />
                        ) : activeView === "handwriting" ? (
                            <HandwritingPanel
                                attempt={attempt}
                                handwritingArchiveEnabled={handwritingArchiveEnabled}
                                feedbackEnabled={feedbackEnabled}
                                handwritingStatus={handwritingStatus}
                                pdfFile={pdfFile}
                                drawings={drawings}
                                teacherMarkupDrawings={teacherMarkupDrawings}
                                feedbackViewMode={feedbackViewMode}
                                onFeedbackViewModeChange={setFeedbackViewMode}
                                onTeacherMarkupChange={handleTeacherMarkupChange}
                                feedback={feedback}
                                feedbackSummary={feedbackSummary}
                                onFeedbackSummaryChange={setFeedbackSummary}
                                feedbackPolicy={feedbackPolicy}
                                onFeedbackPolicyChange={updateFeedbackPolicy}
                                feedbackNotice={feedbackNotice}
                                feedbackSaving={feedbackSaving}
                                onSaveFeedback={saveFeedback}
                                onDownloadHandwriting={handleDownloadHandwriting}
                                onRetry={() => void loadHandwritingResources()}
                            />
                        ) : activeView === "report" ? (
                            <ReportPanel
                                attempt={attempt}
                                exam={exam ?? undefined}
                                analytics={analytics ? {
                                    score: analytics.score,
                                    counts: analytics.counts,
                                    wrongResults: analytics.wrongResults,
                                    weaknessGroups: analytics.weaknessGroups,
                                } : null}
                                selectedAttemptLabel={selectedAttemptLabel}
                                feedbackSummary={feedbackSummary}
                                retakeScoreDelta={retakeScoreDelta}
                                cumulativeInsight={cumulativeStateMatchesAttempt ? cumulativeInsight : null}
                                cumulativeStatus={cumulativeStateMatchesAttempt ? cumulativeStatus : "idle"}
                                cumulativeError={cumulativeStateMatchesAttempt ? cumulativeError : ""}
                                rosterMatched={cumulativeStateMatchesAttempt && !!rosterStudent}
                                studentGrowthReportsEnabled={studentGrowthReportsEnabled}
                                pdfExportEnabled={pdfExportEnabled}
                                onRetryCumulative={retryCumulativeLoad}
                            />
                        ) : null}
                    </section>
                </div>
            </main>
        </div>
    );
}
