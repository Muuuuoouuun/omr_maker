"use client";

import BrandLogo from "@/components/BrandLogo";
import OMRCardView from "@/components/OMRCardView";
import OMRPreview from "@/components/OMRPreview";
import dynamic from "next/dynamic";
import AnswerImportModal from "@/components/AnswerImportModal";
import DistributeModal from "@/components/DistributeModal";
import TeacherLogoutButton from "@/components/TeacherLogoutButton";
import TeacherSessionChip from "@/components/TeacherSessionChip";
import ThemeToggle from "@/components/ThemeToggle";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "@/components/Toast";
import { ArrowUpToLine, BrainCircuit, ChevronDown, Crosshair, FileText, FolderOpen, Loader2, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, RefreshCw, Redo2, Unlink, Undo2, ZoomIn, ZoomOut } from "lucide-react";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { Suspense, useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from "react";
import { DEFAULT_CHOICE_COUNT, questionChoiceCount, type Exam, type Question } from "@/types/omr";
import type { ParsedAnswer } from "@/services/answerParser";
import { saveFileDataUrl, storedDataUrlToFile } from "@/utils/blobStore";
import { secureRandomId } from "@/utils/ids";
import { validateExamDraft } from "@/lib/examValidation";
import { buildExamServiceReadiness, type ExamServiceReadinessLevel } from "@/lib/examServiceReadiness";
import { readStoredExamDefaults } from "@/lib/appSettings";
import { loadExam, loadExams, saveExam } from "@/lib/omrPersistence";
import { attachInferredQuestionPdfRegions } from "@/lib/handwritingAnalytics";
import {
    detectQuestionLocationsFromText,
    isBetterDetectedQuestionPlacement,
    type DetectedQuestionPlacement,
    type PdfTextLocatorItem,
} from "@/lib/pdfQuestionDetection";
import {
    attachInferredPassageSources,
    detectPassageGroupsFromPdfText,
    selectPassageGroupsForQuestions,
    type PdfPageTextItems,
} from "@/lib/pdfPassageGrouping";
import { summarizePersistenceWrite } from "@/lib/persistenceFeedback";
import { buildBillingUsageSummary } from "@/lib/billingUsage";
import { evaluatePlanLimit, getCurrentPlan, getPlanLabel, PLAN_BY_KEY } from "@/utils/plans";

// ─── Autosave + history constants ────────────────────────────────────
const DRAFT_KEY = "omr_exam_draft";
const AUTOSAVE_INTERVAL_MS = 2000;
const HISTORY_LIMIT = 20;
const PDF_PANE_MIN_WIDTH = 200;
const PDF_PANE_DEFAULT_WIDTH = 600;
const SETTINGS_SIDEBAR_MIN_WIDTH = 250;
const SETTINGS_SIDEBAR_DEFAULT_WIDTH = 320;
const SETTINGS_SIDEBAR_COMFORT_WIDTH = 500;
const PREVIEW_PANE_MIN_WIDTH = 260;
const PREVIEW_RAIL_WIDTH = 64;
const DESKTOP_RESIZER_TOTAL_WIDTH = 12;
const PDF_PANE_EXPANDED_MIN_WIDTH = 300;
const SETTINGS_ZOOM_MIN = 0.9;
const SETTINGS_ZOOM_MAX = 1.18;
const SETTINGS_ZOOM_STEP = 0.08;
type QuestionDifficulty = NonNullable<NonNullable<Question["tags"]>["difficulty"]>;

function clampLayoutWidth(value: number, min: number, max: number): number {
    const safeMax = Math.max(min, max);
    return Math.max(min, Math.min(value, safeMax));
}

const DIFFICULTY_OPTIONS: Array<{ value: QuestionDifficulty; label: string; tone: string }> = [
    { value: "easy", label: "기초", tone: "#10b981" },
    { value: "medium", label: "표준", tone: "#6366f1" },
    { value: "hard", label: "심화", tone: "#f59e0b" },
    { value: "killer", label: "킬러", tone: "#ef4444" },
];

const COGNITIVE_LEVEL_OPTIONS: Array<{ value: NonNullable<Question["tags"]>["cognitiveLevel"]; label: string }> = [
    { value: "recall", label: "암기" },
    { value: "understanding", label: "이해" },
    { value: "application", label: "적용" },
    { value: "reasoning", label: "추론" },
];

const DEFAULT_LABEL_PRESETS = ["문법", "독해", "어휘", "듣기", "추론"];
const DEFAULT_MISTAKE_TYPES = ["개념 부족", "계산 실수", "시간 부족", "지문 오독", "선택지 함정"];
const DURATION_PRESETS = [20, 30, 45, 50, 60, 90];
const PDF_ACCEPT = "application/pdf,.pdf";
const SCHEDULE_PRESETS = [
    { key: "now", label: "지금" },
    { key: "today-19", label: "오늘 19:00" },
    { key: "tomorrow-09", label: "내일 09:00" },
    { key: "tomorrow-19", label: "내일 19:00" },
] as const;

interface EditorDraft {
    title: string;
    questionsCount: number;
    columns: number;
    questions: Question[];
    defaultChoices: 4 | 5;
    durationMin: number | "";
    startAt: string;
    endAt: string;
    savedAt: string;
}

interface HistorySnapshot {
    title: string;
    questionsCount: number;
    columns: number;
    questions: Question[];
    defaultChoices: 4 | 5;
    durationMin: number | "";
    startAt: string;
    endAt: string;
}

interface LabelBatchState {
    start: number;
    end: number;
    label: string;
    unit: string;
    concept: string;
    difficulty: QuestionDifficulty | "";
}

type CreateConfirmState =
    | { kind: "restoreDraft"; draft: EditorDraft }
    | { kind: "shrinkQuestions"; nextCount: number; losing: number }
    | { kind: "fourChoices"; losing: number }
    | { kind: "expandImportedAnswers"; maxQuestion: number; answers: ParsedAnswer[] };

function isPdfUploadFile(file: File): boolean {
    return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function CreateConfirmDialog({
    state,
    onCancel,
    onConfirm,
}: {
    state: CreateConfirmState;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const copy = (() => {
        if (state.kind === "restoreDraft") {
            return {
                title: "임시 초안 복원",
                body: "저장된 임시 초안이 있습니다. 복원하면 이전에 작업하던 문항과 설정을 이어서 편집합니다.",
                cancel: "초안 삭제",
                confirm: "복원",
                tone: "var(--primary)",
            };
        }
        if (state.kind === "shrinkQuestions") {
            return {
                title: "문항 수 줄이기",
                body: `${state.losing}개 문항의 정답이 함께 삭제됩니다. 문항 수를 ${state.nextCount}개로 줄일까요?`,
                cancel: "유지",
                confirm: "줄이기",
                tone: "var(--error)",
            };
        }
        if (state.kind === "fourChoices") {
            return {
                title: "4지선다로 변경",
                body: `5번으로 지정된 정답 ${state.losing}개가 비워집니다. 4지선다로 바꿀까요?`,
                cancel: "유지",
                confirm: "변경",
                tone: "var(--error)",
            };
        }
        return {
            title: "문항 수 늘리기",
            body: `가져온 정답이 ${state.maxQuestion}번까지 있습니다. 문항 수를 ${state.maxQuestion}개로 늘리고 모두 적용할까요?`,
            cancel: "현재 문항까지만",
            confirm: "늘리고 적용",
            tone: "var(--primary)",
        };
    })();

    return (
        <div
            role="presentation"
            onClick={onCancel}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1200,
                background: 'rgba(15,23,42,0.58)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={copy.title}
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: '100%',
                    maxWidth: 430,
                    background: 'var(--surface)',
                    color: 'var(--foreground)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
                    padding: '1.5rem',
                }}
            >
                <h2 style={{ fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.65rem' }}>
                    {copy.title}
                </h2>
                <p style={{ color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.95rem', wordBreak: 'keep-all', marginBottom: '1.25rem' }}>
                    {copy.body}
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        onClick={onCancel}
                        style={{ padding: '0.7rem 1rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                        {copy.cancel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        style={{ padding: '0.7rem 1rem', background: copy.tone, color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 800, fontSize: '0.9rem' }}
                    >
                        {copy.confirm}
                    </button>
                </div>
            </div>
        </div>
    );
}

function safeSetLocal(key: string, value: string): boolean {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        toast.error("저장 공간 부족", "오래된 시험을 정리하거나 용량을 확인하세요.");
        return false;
    }
}

function splitTagInput(value: string): string[] {
    return value
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
}

function toLocalDateTimeInput(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function addMinutesToLocalInput(value: string, minutes: number): string {
    if (!value || !Number.isFinite(minutes)) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return toLocalDateTimeInput(new Date(date.getTime() + minutes * 60 * 1000));
}

function joinTagInput(value?: string[]): string {
    return value?.join(", ") || "";
}

function formatRegionPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function readinessTone(level: ExamServiceReadinessLevel): { color: string; background: string; border: string } {
    if (level === "ready") return { color: "var(--success)", background: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.22)" };
    if (level === "warning") return { color: "var(--warning)", background: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.24)" };
    return { color: "var(--error)", background: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.22)" };
}

export default function CreateOMRPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: 'var(--app-viewport-height, 100dvh)', background: 'var(--background)' }} />}>
            <CreateOMRPageInner />
        </Suspense>
    );
}

function CreateOMRPageInner() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const editId = searchParams?.get('edit') || null;
    // UI State
    const [isSaving, setIsSaving] = useState(false);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isDistributeModalOpen, setIsDistributeModalOpen] = useState(false);
    const [confirmState, setConfirmState] = useState<CreateConfirmState | null>(null);
    const [isAdvancedDesignOpen, setIsAdvancedDesignOpen] = useState(false);

    // OMR Data State
    const [title, setTitle] = useState("기말고사 OMR");
    const [questionsCount, setQuestionsCount] = useState(20);
    const [columns, setColumns] = useState(2);
    const [questions, setQuestions] = useState<Question[]>([]);
    const [initialDefaultsReady, setInitialDefaultsReady] = useState(!!editId);

    // Interaction State
    const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
    const [customLabel, setCustomLabel] = useState("");
    const [labelBatch, setLabelBatch] = useState<LabelBatchState>({
        start: 1,
        end: 20,
        label: "",
        unit: "",
        concept: "",
        difficulty: "",
    });

    // Validation
    const [fastAnswer, setFastAnswer] = useState("");

    // Layout Sizing
    const [pdfWidth, setPdfWidth] = useState(PDF_PANE_DEFAULT_WIDTH);
    const [sidebarWidth, setSidebarWidth] = useState(SETTINGS_SIDEBAR_DEFAULT_WIDTH);
    const [settingsZoom, setSettingsZoom] = useState(1);
    const [isPreviewCollapsed, setIsPreviewCollapsed] = useState(false);
    const [activeResizer, setActiveResizer] = useState<'pdf' | 'sidebar' | null>(null);
    const createWorkspaceRef = useRef<HTMLDivElement>(null);
    const settingsSidebarRef = useRef<HTMLElement>(null);

    const getWorkspaceLayoutWidth = useCallback(() => {
        if (createWorkspaceRef.current) {
            return createWorkspaceRef.current.getBoundingClientRect().width;
        }
        return typeof window === "undefined" ? 0 : window.innerWidth;
    }, []);

    const fitSidebarWidth = useCallback((targetWidth: number, reclaimPdfSpace = false, workspaceWidthOverride?: number) => {
        const previewWidth = isPreviewCollapsed ? PREVIEW_RAIL_WIDTH : PREVIEW_PANE_MIN_WIDTH;
        const workspaceWidth = workspaceWidthOverride ?? getWorkspaceLayoutWidth();
        const minPdfWidth = isPreviewCollapsed ? PDF_PANE_MIN_WIDTH : PDF_PANE_EXPANDED_MIN_WIDTH;
        const sharedPaneWidth = Math.max(
            minPdfWidth + SETTINGS_SIDEBAR_MIN_WIDTH,
            workspaceWidth - previewWidth - DESKTOP_RESIZER_TOTAL_WIDTH
        );
        const maxSidebarWidth = Math.max(
            SETTINGS_SIDEBAR_MIN_WIDTH,
            reclaimPdfSpace
                ? sharedPaneWidth - minPdfWidth
                : isPreviewCollapsed
                    ? sharedPaneWidth - PDF_PANE_MIN_WIDTH
                    : workspaceWidth - pdfWidth - previewWidth - DESKTOP_RESIZER_TOTAL_WIDTH
        );
        const nextSidebarWidth = clampLayoutWidth(targetWidth, SETTINGS_SIDEBAR_MIN_WIDTH, maxSidebarWidth);
        setSidebarWidth(nextSidebarWidth);
        if (reclaimPdfSpace || isPreviewCollapsed) {
            const nextPdfWidth = clampLayoutWidth(
                sharedPaneWidth - nextSidebarWidth,
                minPdfWidth,
                Math.max(minPdfWidth, sharedPaneWidth - SETTINGS_SIDEBAR_MIN_WIDTH)
            );
            setPdfWidth(nextPdfWidth);
        }
    }, [getWorkspaceLayoutWidth, isPreviewCollapsed, pdfWidth]);

    const applyPdfWidth = useCallback((targetWidth: number, workspaceWidthOverride?: number) => {
        const previewWidth = isPreviewCollapsed ? PREVIEW_RAIL_WIDTH : PREVIEW_PANE_MIN_WIDTH;
        const workspaceWidth = workspaceWidthOverride ?? getWorkspaceLayoutWidth();
        const sharedPaneWidth = Math.max(
            PDF_PANE_MIN_WIDTH + SETTINGS_SIDEBAR_MIN_WIDTH,
            workspaceWidth - previewWidth - DESKTOP_RESIZER_TOTAL_WIDTH
        );
        const minPdfWidth = isPreviewCollapsed ? PDF_PANE_MIN_WIDTH : PDF_PANE_EXPANDED_MIN_WIDTH;
        const maxPdfWidth = Math.max(
            minPdfWidth,
            isPreviewCollapsed
                ? sharedPaneWidth - SETTINGS_SIDEBAR_MIN_WIDTH
                : workspaceWidth - sidebarWidth - previewWidth - DESKTOP_RESIZER_TOTAL_WIDTH
        );
        const nextPdfWidth = clampLayoutWidth(targetWidth, minPdfWidth, maxPdfWidth);
        setPdfWidth(nextPdfWidth);
        if (isPreviewCollapsed) {
            setSidebarWidth(sharedPaneWidth - nextPdfWidth);
        }
    }, [getWorkspaceLayoutWidth, isPreviewCollapsed, sidebarWidth]);

    // Shared pointer-drag lifecycle for the two panel resizers: caches the workspace
    // width once (avoids a layout read per pointermove) and coalesces updates to one
    // per animation frame so panel edges track the cursor smoothly instead of
    // fighting the panels' own width/flex-basis CSS transition.
    const beginPanelDrag = useCallback((
        e: React.PointerEvent<HTMLDivElement>,
        resizerId: 'pdf' | 'sidebar',
        startWidth: number,
        onDrag: (nextWidth: number, workspaceWidth: number) => void,
    ) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const target = e.currentTarget;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const workspaceWidth = getWorkspaceLayoutWidth();
        try {
            // Best-effort: keeps the drag tracking correctly even if the
            // pointer momentarily leaves the 6px hit area or the browser
            // window. Listeners below are on `document`, so the drag still
            // works fine if capture isn't available.
            target.setPointerCapture(pointerId);
        } catch {
            // no-op
        }
        setActiveResizer(resizerId);

        let rafId = 0;
        let latestClientX = startX;
        const applyPending = () => {
            rafId = 0;
            onDrag(startWidth + (latestClientX - startX), workspaceWidth);
        };
        const onPointerMove = (moveEvent: PointerEvent) => {
            latestClientX = moveEvent.clientX;
            if (!rafId) rafId = requestAnimationFrame(applyPending);
        };
        const stopDragging = () => {
            if (rafId) {
                // A pending frame means the last pointermove hasn't been applied
                // yet; flush it now so release doesn't drop the final position.
                cancelAnimationFrame(rafId);
                applyPending();
            }
            if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', stopDragging);
            document.removeEventListener('pointercancel', stopDragging);
            setActiveResizer(null);
        };
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', stopDragging);
        document.addEventListener('pointercancel', stopDragging);
    }, [getWorkspaceLayoutWidth]);

    const adjustSettingsZoom = useCallback((delta: number) => {
        setSettingsZoom(prev => {
            const next = Math.round((prev + delta) * 100) / 100;
            return Math.max(SETTINGS_ZOOM_MIN, Math.min(SETTINGS_ZOOM_MAX, next));
        });
    }, []);

    const scrollSettingsToTop = useCallback(() => {
        settingsSidebarRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }, []);

    const toggleComfortSidebarWidth = useCallback(() => {
        const nextWidth = sidebarWidth >= SETTINGS_SIDEBAR_COMFORT_WIDTH - 24
            ? SETTINGS_SIDEBAR_DEFAULT_WIDTH
            : SETTINGS_SIDEBAR_COMFORT_WIDTH;
        fitSidebarWidth(nextWidth, true);
    }, [fitSidebarWidth, sidebarWidth]);

    // PDF State
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [answerKeyPdf, setAnswerKeyPdf] = useState<File | null>(null); // Teacher reference answer key
    const [activeViewTab, setActiveViewTab] = useState<'problem' | 'answer'>('problem');
    const [isDetectingLocation, setIsDetectingLocation] = useState(false);

    // Schedule fields
    const [durationMin, setDurationMin] = useState<number | "">(50);
    const [startAt, setStartAt] = useState<string>(""); // datetime-local string
    const [endAt, setEndAt] = useState<string>(""); // datetime-local string

    // Exam-level default choice count (4 or 5)
    const [defaultChoices, setDefaultChoices] = useState<4 | 5>(DEFAULT_CHOICE_COUNT);
    const [defaultScorePerQuestion, setDefaultScorePerQuestion] = useState(5);
    const [autosaveIntervalMs, setAutosaveIntervalMs] = useState(AUTOSAVE_INTERVAL_MS);

    // Edit mode: load existing exam snapshot + carry through on save.
    const [loadedExam, setLoadedExam] = useState<Exam | null>(null);

    const selectedQuestion = useMemo(
        () => questions.find(q => q.id === selectedQuestionId) || null,
        [questions, selectedQuestionId],
    );
    const hasSelectedAdvancedDesign = Boolean(
        selectedQuestion?.tags?.unit ||
        selectedQuestion?.tags?.concept ||
        selectedQuestion?.tags?.difficulty ||
        selectedQuestion?.tags?.cognitiveLevel ||
        selectedQuestion?.tags?.expectedTimeSec ||
        selectedQuestion?.tags?.source ||
        selectedQuestion?.tags?.mistakeTypes?.length ||
        selectedQuestion?.explanation,
    );
    const knownLabels = useMemo(() => {
        const labels = new Set<string>(DEFAULT_LABEL_PRESETS);
        questions.forEach(q => {
            if (q.label) labels.add(q.label);
            if (q.tags?.concept) labels.add(q.tags.concept);
        });
        return Array.from(labels).slice(0, 12);
    }, [questions]);
    const hasProblemPdfForValidation = !!pdfFile || !!loadedExam?.pdfData || !!loadedExam?.pdfDataRef;
    const hasAnswerKeyPdfForValidation = !!answerKeyPdf || !!loadedExam?.answerKeyPdf || !!loadedExam?.answerKeyPdfRef;

    const designSummary = useMemo(() => {
        const answered = questions.filter(q => typeof q.answer === "number").length;
        const conceptTagged = questions.filter(q => q.tags?.concept || q.label).length;
        const highDifficulty = questions.filter(q => q.tags?.difficulty === "hard" || q.tags?.difficulty === "killer").length;
        const pdfLinked = questions.filter(q => q.pdfLocation || q.pdfRegion).length;
        const pdfRegionLinked = questions.filter(q => q.pdfRegion).length;
        const totalExpectedSec = questions.reduce((sum, q) => sum + (q.tags?.expectedTimeSec || 0), 0);
        const conceptCount = new Set(
            questions
                .map(q => q.tags?.concept || q.label)
                .filter(Boolean)
        ).size;

        return {
            answered,
            conceptTagged,
            highDifficulty,
            pdfLinked,
            pdfRegionLinked,
            totalExpectedMin: totalExpectedSec > 0 ? Math.round(totalExpectedSec / 60) : 0,
            conceptCount,
        };
    }, [questions]);

    const validationSummary = useMemo(() => validateExamDraft({
        title,
        questions,
        durationMin,
        startAt,
        endAt,
        hasProblemPdf: hasProblemPdfForValidation,
    }), [title, questions, durationMin, startAt, endAt, hasProblemPdfForValidation]);
    const serviceReadiness = useMemo(() => buildExamServiceReadiness({
        title,
        validation: validationSummary,
        hasProblemPdf: hasProblemPdfForValidation,
        hasAnswerKeyPdf: hasAnswerKeyPdfForValidation,
        accessConfig: loadedExam?.accessConfig,
    }), [title, validationSummary, hasProblemPdfForValidation, hasAnswerKeyPdfForValidation, loadedExam?.accessConfig]);
    const serviceReadinessTone = useMemo(() => readinessTone(serviceReadiness.level), [serviceReadiness.level]);
    const compactReadinessItems = serviceReadiness.items.map(item => item).filter(item =>
        item.key === "answers" || item.key === "problem_pdf" || item.key === "distribution"
    );
    const validationTooltip = [...validationSummary.errors, ...validationSummary.warnings]
        .slice(0, 3)
        .map(item => item.message)
        .join("\n");
    const answeredPercent = questionsCount > 0
        ? Math.min(100, Math.round((designSummary.answered / questionsCount) * 100))
        : 0;
    const selectedQuestionStatus = selectedQuestion
        ? `${selectedQuestion.number}번`
        : "미선택";
    const selectedAnswerStatus = selectedQuestion
        ? (typeof selectedQuestion.answer === "number" ? `${selectedQuestion.answer}번` : "미입력")
        : "미선택";
    const selectedPdfStatus = selectedQuestion?.pdfRegion
        ? "영역 저장"
        : selectedQuestion?.pdfLocation
            ? "위치 저장"
            : "미연결";
    const selectedQuestionChoiceCount = selectedQuestion
        ? questionChoiceCount(selectedQuestion, defaultChoices)
        : defaultChoices;

    // Undo/Redo + autosave refs
    const historyRef = useRef<HistorySnapshot[]>([]);
    const redoRef = useRef<HistorySnapshot[]>([]);
    const suppressHistoryRef = useRef(false);
    const hasHydratedRef = useRef(false);
    const draftPromptedRef = useRef(false);
    const lastSnapshotRef = useRef<HistorySnapshot | null>(null);

    // Helpers to convert ISO <-> datetime-local ("YYYY-MM-DDTHH:mm")
    const isoToLocalInput = (iso?: string): string => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const localInputToIso = (v: string): string | undefined => {
        if (!v) return undefined;
        const d = new Date(v);
        if (isNaN(d.getTime())) return undefined;
        return d.toISOString();
    };
    const durationValue = typeof durationMin === 'number' && durationMin > 0 ? durationMin : 50;
    const setDurationAndSyncEnd = (minutes: number) => {
        const safeMinutes = Math.max(1, Math.floor(minutes));
        setDurationMin(safeMinutes);
        if (startAt) setEndAt(addMinutesToLocalInput(startAt, safeMinutes));
    };
    const setStartAndSyncEnd = (value: string) => {
        setStartAt(value);
        if (value) {
            setEndAt(addMinutesToLocalInput(value, durationValue));
        }
    };
    const applySchedulePreset = (preset: typeof SCHEDULE_PRESETS[number]["key"]) => {
        const date = new Date();
        if (preset === "today-19") {
            date.setHours(19, 0, 0, 0);
        } else if (preset === "tomorrow-09") {
            date.setDate(date.getDate() + 1);
            date.setHours(9, 0, 0, 0);
        } else if (preset === "tomorrow-19") {
            date.setDate(date.getDate() + 1);
            date.setHours(19, 0, 0, 0);
        } else {
            date.setSeconds(0, 0);
        }
        setStartAndSyncEnd(toLocalDateTimeInput(date));
    };
    const clearSchedule = () => {
        setStartAt("");
        setEndAt("");
    };

    useEffect(() => {
        if (editId) {
            setInitialDefaultsReady(true);
            return;
        }
        const defaults = readStoredExamDefaults();
        setQuestionsCount(defaults.questions);
        setDurationMin(defaults.duration);
        setDefaultChoices(defaults.choices);
        setDefaultScorePerQuestion(defaults.scorePerQ);
        setAutosaveIntervalMs(defaults.autosaveSec > 0 ? defaults.autosaveSec * 1000 : 0);
        setInitialDefaultsReady(true);
    }, [editId]);

    const createDefaultQuestion = useCallback((index: number): Question => ({
        id: index + 1,
        number: index + 1,
        choices: defaultChoices,
        score: defaultScorePerQuestion,
    }), [defaultChoices, defaultScorePerQuestion]);

    // Load exam from localStorage when ?edit=<id> is present.
    useEffect(() => {
        if (!editId) return;
        if (typeof window === 'undefined') return;
        let cancelled = false;
        const loadExistingExam = async () => {
            try {
                const parsed = await loadExam(editId);
                if (cancelled) return;
                if (!parsed) {
                    toast.error('시험을 찾을 수 없습니다', editId);
                    return;
                }
                setLoadedExam(parsed);
                if (parsed.title) setTitle(parsed.title);
                if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
                    setQuestionsCount(parsed.questions.length);
                    setQuestions(parsed.questions);
                }
                if (typeof parsed.durationMin === 'number') setDurationMin(parsed.durationMin);
                if (parsed.startAt) setStartAt(isoToLocalInput(parsed.startAt));
                if (parsed.endAt) setEndAt(isoToLocalInput(parsed.endAt));
                storedDataUrlToFile("problem.pdf", parsed.pdfData, parsed.pdfDataRef)
                    .then(file => {
                        if (!cancelled && file) setPdfFile(file);
                    })
                    .catch(() => {
                        if (!cancelled) toast.error('문제지 PDF 불러오기 실패');
                    });
                storedDataUrlToFile("answer_key.pdf", parsed.answerKeyPdf, parsed.answerKeyPdfRef)
                    .then(file => {
                        if (!cancelled && file) setAnswerKeyPdf(file);
                    })
                    .catch(() => {
                        if (!cancelled) toast.error('답지 PDF 불러오기 실패');
                    });
                toast.info('편집 모드', `"${parsed.title}"을(를) 불러왔습니다.`);
            } catch {
                toast.error('시험을 찾을 수 없습니다', editId);
            }
        };
        void loadExistingExam();
        return () => { cancelled = true; };
    }, [editId]);

    // Initialize questions when count changes
    useEffect(() => {
        if (!initialDefaultsReady) return;
        // Reuse existing questions if possible to keep data
        setQuestions(prev => {
            const newQuestions: Question[] = [];
            for (let i = 0; i < questionsCount; i++) {
                if (i < prev.length) {
                    newQuestions.push(prev[i]);
                } else {
                    newQuestions.push(createDefaultQuestion(i));
                }
            }
            return newQuestions;
        });
    }, [createDefaultQuestion, initialDefaultsReady, questionsCount]);

    useEffect(() => {
        setLabelBatch(prev => ({
            ...prev,
            start: Math.min(Math.max(prev.start, 1), Math.max(questionsCount, 1)),
            end: Math.min(Math.max(prev.end, 1), Math.max(questionsCount, 1)),
        }));
    }, [questionsCount]);

    // ─── Draft restore on mount (non-edit mode only) ─────────────────
    useEffect(() => {
        if (draftPromptedRef.current) return;
        if (typeof window === "undefined") return;
        if (editId) return; // Skip draft prompt while editing an existing exam
        draftPromptedRef.current = true;

        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        let draft: EditorDraft | null = null;
        try { draft = JSON.parse(raw) as EditorDraft; } catch { return; }
        if (!draft || !Array.isArray(draft.questions)) return;

        toast.info("이전 작업 복원 가능", "저장된 임시 초안이 있습니다.");
        setConfirmState({ kind: "restoreDraft", draft });
    }, [editId]);

    // Mark hydration so autosave doesn't fire with defaults before restore runs
    useEffect(() => {
        hasHydratedRef.current = true;
    }, []);

    // ─── Autosave draft every 2s when editor state changes ───────────
    useEffect(() => {
        if (!hasHydratedRef.current) return;
        if (editId) return; // editing flow uses its own save path
        if (confirmState?.kind === "restoreDraft") return;
        if (!initialDefaultsReady || autosaveIntervalMs <= 0) return;
        const handle = setTimeout(() => {
            const draft: EditorDraft = {
                title, questionsCount, columns, questions,
                defaultChoices, durationMin, startAt, endAt,
                savedAt: new Date().toISOString(),
            };
            safeSetLocal(DRAFT_KEY, JSON.stringify(draft));
        }, autosaveIntervalMs);
        return () => clearTimeout(handle);
    }, [autosaveIntervalMs, editId, confirmState, initialDefaultsReady, title, questionsCount, columns, questions, defaultChoices, durationMin, startAt, endAt]);

    // ─── History snapshotting (push PREVIOUS state onto undo stack) ──
    const snapshotCurrent = useCallback((): HistorySnapshot => ({
        title, questionsCount, columns, questions,
        defaultChoices, durationMin, startAt, endAt,
    }), [title, questionsCount, columns, questions, defaultChoices, durationMin, startAt, endAt]);

    useEffect(() => {
        if (!hasHydratedRef.current) return;
        if (suppressHistoryRef.current) {
            suppressHistoryRef.current = false;
            lastSnapshotRef.current = snapshotCurrent();
            return;
        }
        if (lastSnapshotRef.current) {
            historyRef.current.push(lastSnapshotRef.current);
            if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
            redoRef.current = []; // new edit clears redo stack
        }
        lastSnapshotRef.current = snapshotCurrent();
    }, [title, questionsCount, columns, questions, defaultChoices, durationMin, startAt, endAt, snapshotCurrent]);

    const applySnapshot = useCallback((snap: HistorySnapshot) => {
        suppressHistoryRef.current = true;
        setTitle(snap.title);
        setQuestionsCount(snap.questionsCount);
        setColumns(snap.columns);
        setQuestions(snap.questions);
        setDefaultChoices(snap.defaultChoices);
        setDurationMin(snap.durationMin);
        setStartAt(snap.startAt);
        setEndAt(snap.endAt);
    }, []);

    const undo = useCallback(() => {
        const prev = historyRef.current.pop();
        if (!prev) { toast.info("되돌릴 내용이 없습니다"); return; }
        redoRef.current.push(snapshotCurrent());
        if (redoRef.current.length > HISTORY_LIMIT) redoRef.current.shift();
        applySnapshot(prev);
    }, [applySnapshot, snapshotCurrent]);

    const redo = useCallback(() => {
        const next = redoRef.current.pop();
        if (!next) { toast.info("다시 실행할 내용이 없습니다"); return; }
        historyRef.current.push(snapshotCurrent());
        if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
        applySnapshot(next);
    }, [applySnapshot, snapshotCurrent]);

    // Ctrl+Z / Cmd+Z to undo, Ctrl+Shift+Z / Cmd+Shift+Z (or Ctrl+Y) to redo
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const isMod = e.ctrlKey || e.metaKey;
            if (!isMod) return;
            const tgt = e.target as HTMLElement | null;
            const tag = tgt?.tagName;
            const inText = tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable;
            const key = e.key.toLowerCase();
            if (key === 'z' && !e.shiftKey) {
                if (inText) return;
                e.preventDefault();
                undo();
            } else if ((key === 'z' && e.shiftKey) || key === 'y') {
                if (inText) return;
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo]);

    const handleProblemPdfFile = (file: File | null | undefined) => {
        if (!file) return false;
        if (!isPdfUploadFile(file)) {
            toast.error("PDF 업로드 실패", "문제지는 PDF 파일만 등록할 수 있습니다.");
            return false;
        }
        setPdfFile(file);
        setActiveViewTab('problem');
        toast.success("문제지 PDF 업로드됨", file.name);
        return true;
    };

    const handleAnswerKeyPdfFile = (file: File | null | undefined) => {
        if (!file) return false;
        if (!isPdfUploadFile(file)) {
            toast.error("PDF 업로드 실패", "답지는 PDF 파일만 등록할 수 있습니다.");
            return false;
        }
        setAnswerKeyPdf(file);
        setActiveViewTab('answer');
        toast.success("답지 PDF 업로드됨", file.name);
        return true;
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        handleProblemPdfFile(e.currentTarget.files?.[0]);
        e.currentTarget.value = "";
    };

    const handleFileDrop = (file: File) => {
        handleProblemPdfFile(file);
    };

    const handlePdfPageClick = (page: number, x: number, y: number) => {
        if (selectedQuestionId === null) {
            toast.info("문항 먼저 선택", "연결할 문항을 OMR에서 선택해주세요.");
            return;
        }

        setQuestions(prev => attachInferredQuestionPdfRegions(
            prev.map(q =>
                q.id === selectedQuestionId
                    ? { ...q, pdfLocation: { page, x, y } }
                    : q
            ),
            { overwriteExisting: true },
        ));
    };

    const handleReinferQuestionRegions = () => {
        const linkedCount = questions.filter(q => q.pdfLocation).length;
        if (linkedCount === 0) {
            toast.info("문항 위치 필요", "PDF에서 문항 번호를 먼저 찍거나 자동 매칭을 실행하세요.");
            return;
        }

        setQuestions(prev => attachInferredQuestionPdfRegions(prev, { overwriteExisting: true }));
        toast.success("문항 영역 재계산", `${linkedCount}개 문항 위치를 기준으로 필기 수집 영역을 다시 잡았습니다.`);
    };

    const handleAutoMatchMissingRegions = () => {
        const next = attachInferredQuestionPdfRegions(questions, { overwriteExisting: false });
        const filled = next.filter(q => q.pdfRegion).length - questions.filter(q => q.pdfRegion).length;
        if (filled <= 0) {
            toast.info("자동 매칭 대상 없음", "PDF 위치가 찍힌 미연결 문항이 없습니다. PDF에서 문항 위치를 먼저 지정하세요.");
            return;
        }
        setQuestions(next);
        toast.success("문항 영역 자동 매칭", `${filled}개 문항의 필기 수집 영역을 새로 잡았습니다.`);
    };

    const handleClearSelectedPdfLink = () => {
        if (selectedQuestionId === null) {
            toast.info("문항 먼저 선택", "PDF 연결을 해제할 문항을 선택하세요.");
            return;
        }

        const target = questions.find(q => q.id === selectedQuestionId);
        if (!target?.pdfLocation && !target?.pdfRegion) {
            toast.info("해제할 PDF 연결 없음", "선택한 문항에 저장된 PDF 위치나 영역이 없습니다.");
            return;
        }

        setQuestions(prev => prev.map(q =>
            q.id === selectedQuestionId
                ? { ...q, pdfLocation: undefined, pdfRegion: undefined }
                : q
        ));
        toast.info("PDF 연결 해제", `${target.number}번 문항의 PDF 위치와 영역을 지웠습니다.`);
    };

    const handleClearAllPdfRegions = () => {
        const regionCount = questions.filter(q => q.pdfRegion).length;
        if (regionCount === 0) {
            toast.info("초기화할 영역 없음", "저장된 문항 영역이 없습니다.");
            return;
        }

        setQuestions(prev => prev.map(q => q.pdfRegion ? { ...q, pdfRegion: undefined } : q));
        toast.info("문항 영역 초기화", `${regionCount}개 영역을 지웠습니다. 문항 위치는 유지됩니다.`);
    };

    const updateSelectedQuestion = (updater: (question: Question) => Question) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q => q.id === selectedQuestionId ? updater(q) : q));
    };

    const setQuestionTag = <K extends keyof NonNullable<Question["tags"]>>(
        key: K,
        value: NonNullable<Question["tags"]>[K] | undefined,
    ) => {
        updateSelectedQuestion(q => {
            const nextTags = { ...(q.tags || {}) };
            if (
                value === undefined ||
                value === "" ||
                (Array.isArray(value) && value.length === 0)
            ) {
                delete nextTags[key];
            } else {
                nextTags[key] = value;
            }
            return {
                ...q,
                tags: Object.keys(nextTags).length > 0 ? nextTags : undefined,
            };
        });
    };

    const setExplanation = (explanation: string) => {
        updateSelectedQuestion(q => ({
            ...q,
            explanation: explanation.trim() ? explanation : undefined,
        }));
    };

    const toggleLabel = (label: string) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q => {
            if (q.id !== selectedQuestionId) return q;
            return { ...q, label: label === q.label ? undefined : label };
        }));
    };

    const setLabelBatchRange = (start: number, end: number) => {
        const safeStart = Math.min(Math.max(Math.floor(start) || 1, 1), Math.max(questionsCount, 1));
        const safeEnd = Math.min(Math.max(Math.floor(end) || safeStart, 1), Math.max(questionsCount, 1));
        setLabelBatch(prev => ({
            ...prev,
            start: safeStart,
            end: safeEnd,
        }));
    };

    const setSelectedQuestionAsLabelRange = () => {
        if (!selectedQuestion) {
            toast.info("문항 먼저 선택", "일괄 적용 기준으로 쓸 문항을 먼저 선택하세요.");
            return;
        }
        setLabelBatchRange(selectedQuestion.number, selectedQuestion.number);
    };

    const applyBatchLabels = (onlyEmpty = false) => {
        const start = Math.max(1, Math.min(labelBatch.start, labelBatch.end));
        const end = Math.min(questionsCount, Math.max(labelBatch.start, labelBatch.end));
        const label = labelBatch.label.trim();
        const unit = labelBatch.unit.trim();
        const concept = labelBatch.concept.trim();
        const difficulty = labelBatch.difficulty || undefined;

        if (!label && !unit && !concept && !difficulty) {
            toast.info("적용할 라벨 없음", "유형/단원/개념/난이도 중 하나를 입력하세요.");
            return;
        }

        let applied = 0;
        const nextQuestions = questions.map(q => {
            if (q.number < start || q.number > end) return q;
            if (onlyEmpty && (q.label || q.tags?.concept)) return q;

            const nextTags = { ...(q.tags || {}) };
            if (unit) nextTags.unit = unit;
            if (concept) nextTags.concept = concept;
            if (difficulty) nextTags.difficulty = difficulty;

            applied += 1;
            return {
                ...q,
                label: label || q.label,
                tags: Object.keys(nextTags).length > 0 ? nextTags : undefined,
            };
        });

        if (applied === 0) {
            toast.info("적용된 문항 없음", "선택한 범위에 빈 라벨 문항이 없습니다.");
            return;
        }

        setQuestions(nextQuestions);
        toast.success("문항 라벨 적용됨", `${start}~${end}번 ${applied}개 문항을 업데이트했습니다.`);
    };

    const setAnswer = (answer: number) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q =>
            q.id === selectedQuestionId
                ? { ...q, answer: answer }
                : q
        ));
    };

    const setScore = (score: number) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q =>
            q.id === selectedQuestionId
                ? { ...q, score: score }
                : q
        ));
    };

    const handleOMRAnswerClick = (qId: number, answer: number) => {
        setSelectedQuestionId(qId);
        setQuestions(prev => prev.map(q =>
            q.id === qId ? { ...q, answer: answer } : q
        ));
    };

    // Guard: reducing question count may destroy answered questions.
    const handleQuestionCountChange = (newCount: number) => {
        if (newCount < questionsCount) {
            const losing = questions.slice(newCount).filter(q => typeof q.answer === 'number').length;
            if (losing > 0) {
                setConfirmState({ kind: "shrinkQuestions", nextCount: newCount, losing });
                return;
            }
        }
        setQuestionsCount(newCount);
    };

    // Guard: switching 5→4 may invalidate answers of 5.
    const handleDefaultChoicesChange = (next: 4 | 5) => {
        if (next === 4 && defaultChoices === 5) {
            const losing = questions.filter(q => q.answer === 5).length;
            if (losing > 0) {
                setConfirmState({ kind: "fourChoices", losing });
                return;
            }
        }
        setDefaultChoices(next);
        setQuestions(prev => prev.map(q => ({ ...q, choices: next })));
    };

    const handleAutoDetectLocations = async () => {
        if (!pdfFile) {
            toast.info("문제지 필요", "먼저 문제지 PDF를 왼쪽 상단에서 업로드해주세요.");
            return;
        }
        setIsDetectingLocation(true);
        try {
            const pdfjsLib = await import('pdfjs-dist');
            if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
            }
            const arrayBuffer = await pdfFile.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            const newQuestions = [...questions];
            let mappedCount = 0;
            let updatedCount = 0;
            const expectedQuestionNumbers = new Set(newQuestions.map(q => q.number));
            const bestLocations = new Map<number, DetectedQuestionPlacement>();
            const pdfTextPages: PdfPageTextItems[] = [];

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 1.0 });
                const textContent = await page.getTextContent();

                const items: PdfTextLocatorItem[] = textContent.items
                    .map((rawItem): PdfTextLocatorItem | null => {
                        const item = rawItem as {
                            str?: unknown;
                            transform?: unknown;
                            width?: unknown;
                            height?: unknown;
                        };
                        const transform = Array.isArray(item.transform) ? item.transform : [];
                        const x = typeof transform[4] === "number" ? transform[4] / viewport.width : NaN;
                        const y = typeof transform[5] === "number" ? (viewport.height - transform[5]) / viewport.height : NaN;
                        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

                        return {
                            str: typeof item.str === "string" ? item.str : "",
                            x,
                            y,
                            width: typeof item.width === "number" ? item.width / viewport.width : undefined,
                            height: typeof item.height === "number" ? item.height / viewport.height : undefined,
                        };
                    })
                    .filter((item): item is PdfTextLocatorItem => !!item);
                pdfTextPages.push({ page: i, items });

                const locations = detectQuestionLocationsFromText(items, expectedQuestionNumbers);

                for (const [qNum, location] of locations.entries()) {
                    const current = bestLocations.get(qNum);
                    if (isBetterDetectedQuestionPlacement({ page: i, location }, current)) {
                        bestLocations.set(qNum, { page: i, location });
                    }
                }
            }

            for (const [qNum, best] of bestLocations.entries()) {
                const qIndex = newQuestions.findIndex(q => q.number === qNum);
                if (qIndex === -1) continue;

                const hadLocation = !!newQuestions[qIndex].pdfLocation;
                newQuestions[qIndex] = {
                    ...newQuestions[qIndex],
                    pdfLocation: { page: best.page, x: best.location.x, y: best.location.y },
                };
                if (hadLocation) {
                    updatedCount++;
                } else {
                    mappedCount++;
                }
            }

            const passageGroups = selectPassageGroupsForQuestions(
                detectPassageGroupsFromPdfText(pdfTextPages, expectedQuestionNumbers),
                newQuestions,
            );
            const questionsWithPassages = attachInferredPassageSources(newQuestions, passageGroups);
            setQuestions(attachInferredQuestionPdfRegions(questionsWithPassages, {
                overwriteExisting: true,
                textPages: pdfTextPages,
                passageGroups,
            }));
            const passageMessage = passageGroups.length > 0 ? `, 지문 묶음 ${passageGroups.length}개` : "";
            toast.success("위치 자동 매칭 완료", `총 ${pdf.numPages}페이지에서 새로 ${mappedCount}개, 갱신 ${updatedCount}개 문항의 위치와 영역${passageMessage}를 찾았습니다.`);
        } catch (e) {
            console.error(e);
            toast.error("자동 매칭 실패", "위치 자동 매칭 중 오류가 발생했습니다.");
        } finally {
            setIsDetectingLocation(false);
        }
    };

    const handleShareConfig = async (accessConfig: NonNullable<Exam["accessConfig"]>) => {
        try {
            const validation = validateExamDraft({
                title,
                questions,
                durationMin,
                startAt,
                endAt,
                hasProblemPdf: hasProblemPdfForValidation,
                accessConfig,
            });
            if (!validation.isPublishable) {
                toast.error("배포 전 확인 필요", validation.errors[0]?.message || "시험 설정을 확인해주세요.");
                return "";
            }

            if (editId && !loadedExam) {
                toast.info("시험 불러오는 중", "기존 시험 정보를 불러온 뒤 다시 배포해주세요.");
                return "";
            }

            if (!editId) {
                const plan = getCurrentPlan();
                const examResult = await loadExams();
                const usage = buildBillingUsageSummary({
                    exams: examResult.items,
                    attempts: [],
                    students: [],
                    aiRecognition: 0,
                });
                const limit = evaluatePlanLimit(plan, "exams", usage.examsThisMonth, 1);
                if (!limit.allowed) {
                    const upgradeName = limit.upgradeTarget ? PLAN_BY_KEY[limit.upgradeTarget].name : "상위";
                    toast.error(
                        "월 시험 생성 한도 도달",
                        `${getPlanLabel(plan)} 플랜은 이번 달 시험 ${limit.limit}개까지 생성할 수 있습니다. ${upgradeName} 플랜에서 계속 생성할 수 있습니다.`
                    );
                    return "";
                }
            }

            // Editing? Reuse the existing ID and preserve createdAt; otherwise mint a new one.
            // Unguessable id so shareable /solve/[id] links can't be enumerated.
            const id = loadedExam?.id || secureRandomId();
            const createdAt = loadedExam?.createdAt || new Date().toISOString();
            let pdfData = loadedExam?.pdfData || "";
            let pdfDataRef = loadedExam?.pdfDataRef;
            let answerKeyData = loadedExam?.answerKeyPdf || "";
            let answerKeyPdfRef = loadedExam?.answerKeyPdfRef;

            if (pdfFile) {
                const stored = await saveFileDataUrl(`exam:${id}:problemPdf`, pdfFile);
                pdfData = stored.inlineDataUrl || "";
                pdfDataRef = stored.ref;
            }

            if (answerKeyPdf) {
                const stored = await saveFileDataUrl(`exam:${id}:answerKeyPdf`, answerKeyPdf);
                answerKeyData = stored.inlineDataUrl || "";
                answerKeyPdfRef = stored.ref;
            }

            // Fill only missing regions so teacher-tuned regions survive every re-share.
            const questionsWithRegions = attachInferredQuestionPdfRegions(questions, { overwriteExisting: false });

            const examData: Exam = {
                ...(loadedExam || {}),
                id,
                title,
                questions: questionsWithRegions,
                accessConfig,
                pdfData,
                pdfDataRef,
                answerKeyPdf: answerKeyData,
                answerKeyPdfRef,
                createdAt,
                updatedAt: new Date().toISOString(),
                durationMin: typeof durationMin === 'number' ? durationMin : undefined,
                startAt: localInputToIso(startAt),
                endAt: localInputToIso(endAt),
                archived: loadedExam?.archived || false,
            };

            const result = await saveExam(examData);
            const feedback = summarizePersistenceWrite(result, {
                target: "시험",
                action: "저장",
                failureTitle: "배포 저장 실패",
            });
            if (!feedback.ok) {
                toast.error(feedback.title, feedback.detail);
                return "";
            }
            if (feedback.level === "info") {
                toast.info(feedback.title, feedback.detail);
            }
            setLoadedExam(examData);
            setQuestions(questionsWithRegions);
            if (!editId) {
                router.replace(`/create?edit=${id}`, { scroll: false });
            }
            // Clear the autosave draft now that the exam is published.
            try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
            const shareUrl = `${window.location.origin}/solve/${id}`;
            toast.success("배포 준비 완료", "공유 링크가 생성되었습니다.");
            return shareUrl;
        } catch (e) {
            console.error(e);
            toast.error("배포 저장 실패", "파일 저장 공간 또는 브라우저 권한을 확인해주세요.");
            return "";
        }
    };

    const applyImportedAnswers = (importedAnswers: ParsedAnswer[], targetCount = questionsCount) => {
        const answerByNumber = new Map(importedAnswers.map(answer => [answer.questionNum, answer]));
        setQuestions(prev => {
            const base: Question[] = [];
            for (let i = 0; i < targetCount; i++) {
                base.push(prev[i] || createDefaultQuestion(i));
            }

            return base.map(q => {
                const match = answerByNumber.get(q.number);
                if (match) {
                    return {
                        ...q,
                        answer: match.answer,
                        ...(match.score ? { score: match.score } : {})
                    };
                }
                return q;
            });
        });
        toast.success("정답 적용됨", "정답 및 배점(있는 경우)이 적용되었습니다.");
    };

    const handleAnswerImport = (importedAnswers: ParsedAnswer[]) => {
        // Find max question number to auto-resize exam if needed
        const maxQ = Math.max(...importedAnswers.map(ans => ans.questionNum));
        if (maxQ > questionsCount) {
            setConfirmState({ kind: "expandImportedAnswers", maxQuestion: maxQ, answers: importedAnswers });
            return;
        }

        applyImportedAnswers(importedAnswers);
    };

    const handleConfirmCancel = () => {
        if (!confirmState) return;
        if (confirmState.kind === "restoreDraft") {
            try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
            toast.info("초안 삭제", "임시 저장된 초안을 삭제했습니다.");
        } else if (confirmState.kind === "expandImportedAnswers") {
            applyImportedAnswers(confirmState.answers);
            toast.info("현재 문항까지만 적용", `${questionsCount}번까지의 정답만 반영했습니다.`);
        }
        setConfirmState(null);
    };

    const handleConfirmAccept = () => {
        if (!confirmState) return;
        if (confirmState.kind === "restoreDraft") {
            const snap = confirmState.draft;
            suppressHistoryRef.current = true;
            setTitle(snap.title ?? "기말고사 OMR");
            setQuestionsCount(snap.questionsCount ?? 20);
            setColumns(snap.columns ?? 2);
            setQuestions(snap.questions ?? []);
            setDefaultChoices(snap.defaultChoices === 4 ? 4 : 5);
            setDurationMin(snap.durationMin === "" ? "" : (snap.durationMin ?? 50));
            setStartAt(snap.startAt ?? "");
            setEndAt(snap.endAt ?? "");
            toast.success("초안 복원 완료");
        } else if (confirmState.kind === "shrinkQuestions") {
            setQuestionsCount(confirmState.nextCount);
            toast.info("문항 수 변경됨", `${confirmState.losing}개 문항이 제거되었습니다.`);
        } else if (confirmState.kind === "fourChoices") {
            setDefaultChoices(4);
            setQuestions(prev => prev.map(q => ({
                ...q,
                choices: 4,
                answer: q.answer === 5 ? undefined : q.answer,
            })));
            toast.info("4지선다 적용됨", "5번 정답 문항은 비워졌습니다.");
        } else {
            setQuestionsCount(confirmState.maxQuestion);
            applyImportedAnswers(confirmState.answers, confirmState.maxQuestion);
        }
        setConfirmState(null);
    };

    const handleFastAnswerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Accept 1-4 when defaultChoices is 4, else 1-5.
        const maxDigit = defaultChoices;
        const digitRegex = new RegExp(`[^1-${maxDigit}]`, 'g');
        const val = e.target.value.replace(digitRegex, '');
        const previousLength = fastAnswer.length;
        const shouldClearTrimmedAnswers = val.length < previousLength;
        setFastAnswer(val);

        setQuestions(prev => prev.map((q, i) => {
            if (i < val.length) {
                return { ...q, answer: parseInt(val[i]) };
            }
            if (shouldClearTrimmedAnswers && i < previousLength && q.answer !== undefined) {
                return { ...q, answer: undefined };
            }
            return q;
        }));
    };

    const handleSaveImage = async () => {
        const element = document.getElementById("omr-preview") || document.querySelector<HTMLElement>(".create-card-stage");
        if (!element) {
            toast.error("저장할 미리보기를 찾을 수 없습니다.");
            return;
        }

        setIsSaving(true);
        try {
            const { default: html2canvas } = await import("html2canvas");
            const canvas = await html2canvas(element, { scale: 2 });
            const dataUrl = canvas.toDataURL("image/png");

            const link = document.createElement("a");
            link.href = dataUrl;
            link.download = "omr_sheet.png";
            link.click();
            toast.success("이미지 저장 완료");
        } catch (err) {
            console.error("Save failed:", err);
            toast.error("이미지 저장 실패");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="layout-main" style={{ background: 'var(--background)', height: 'var(--app-viewport-height, 100dvh)', overflow: 'hidden' }}>
            <header className="header" style={{ flexShrink: 0 }}>
                <div className="container header-content create-editor-header" style={{ maxWidth: '100%', padding: '0 2rem' }}>
                    <div className="create-editor-brand" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BrandLogo compact />
                        <span className="badge badge-primary" style={{ fontSize: '0.68rem' }}>
                            Smart Editor
                        </span>
                    </div>
                    <div className="create-editor-actions scroll-custom" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                            type="button"
                            onClick={undo}
                            aria-label="되돌리기 (Ctrl+Z)"
                            title="되돌리기 (Ctrl+Z)"
                            className="btn btn-secondary"
                            style={{ padding: '0.55rem 0.65rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center' }}
                        >
                            <Undo2 size={16} />
                        </button>
                        <button
                            type="button"
                            onClick={redo}
                            aria-label="다시 실행 (Ctrl+Shift+Z)"
                            title="다시 실행 (Ctrl+Shift+Z)"
                            className="btn btn-secondary"
                            style={{ padding: '0.55rem 0.65rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center' }}
                        >
                            <Redo2 size={16} />
                        </button>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', padding: '0.55rem 1rem', fontSize: '0.85rem' }}>
                            문제지 업로드
                            <input id="pdf-upload-input" type="file" accept={PDF_ACCEPT} onChange={handleFileChange} style={{ display: 'none' }} />
                        </label>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', padding: '0.55rem 1rem', fontSize: '0.85rem' }}>
                            답지 업로드
                            <input type="file" accept={PDF_ACCEPT} onChange={(e) => {
                                handleAnswerKeyPdfFile(e.currentTarget.files?.[0]);
                                e.currentTarget.value = "";
                            }} style={{ display: 'none' }} />
                        </label>
                        <button
                            className="btn btn-secondary"
                            style={{ padding: '0.55rem 1rem', fontSize: '0.85rem' }}
                            onClick={handleSaveImage}
                            disabled={isSaving}
                        >
                            {isSaving ? "저장 중..." : "이미지 저장"}
                        </button>
                        <button
                            className="btn btn-primary"
                            style={{ padding: '0.55rem 1.1rem', fontSize: '0.85rem' }}
                            onClick={() => {
                                if (!serviceReadiness.canOpenDistribution) {
                                    toast.error("배포 전 확인 필요", serviceReadiness.detail || "시험 설정을 확인해주세요.");
                                    return;
                                }
                                setIsDistributeModalOpen(true);
                            }}
                        >
                            배포하기
                        </button>
                        <TeacherSessionChip compact />
                        <TeacherLogoutButton size="small" />
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            <AnswerImportModal
                isOpen={isImportModalOpen}
                onClose={() => setIsImportModalOpen(false)}
                onApply={handleAnswerImport}
                onUploadAnswerPdf={(file) => {
                    handleAnswerKeyPdfFile(file);
                }}
            />

            <DistributeModal
                isOpen={isDistributeModalOpen}
                onClose={() => setIsDistributeModalOpen(false)}
                onSaveAndShare={handleShareConfig}
                onAutoMatchRegions={handleAutoMatchMissingRegions}
                validationSummary={validationSummary}
                initialAccessConfig={loadedExam?.accessConfig}
                examId={loadedExam?.id}
            />

            {confirmState && (
                <CreateConfirmDialog
                    state={confirmState}
                    onCancel={handleConfirmCancel}
                    onConfirm={handleConfirmAccept}
                />
            )}

            <div ref={createWorkspaceRef} className={`create-workspace ${isPreviewCollapsed ? 'is-preview-collapsed' : ''} ${activeResizer ? 'is-resizing' : ''}`} style={{ display: 'flex', flex: 1, height: 'calc(var(--app-viewport-height, 100dvh) - 4rem)', overflow: 'hidden' }}>

                {/* 1. PDF Viewer Area */}
                <div className="create-pdf-pane" style={{
                    width: `${pdfWidth}px`,
                    minWidth: isPreviewCollapsed ? `${PDF_PANE_MIN_WIDTH}px` : `${PDF_PANE_EXPANDED_MIN_WIDTH}px`,
                    flex: `0 0 ${pdfWidth}px`,
                    borderRight: '1px solid var(--border)',
                    background: '#222',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden' // Force contain inside to avoid layout break
                }}>
                    {/* Tab Selection */}
                    {answerKeyPdf && (
                        <div style={{ display: 'flex', background: '#333', padding: '0.5rem', gap: '0.5rem', borderBottom: '1px solid #444', alignItems: 'center' }}>
                            <button
                                onClick={() => setActiveViewTab('problem')}
                                style={{
                                    flex: 1, padding: '0.5rem', borderRadius: '4px', border: 'none',
                                    background: activeViewTab === 'problem' ? '#6366f1' : '#444',
                                    color: 'white', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s',
                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem'
                                }}
                            >
                                <FileText size={15} />
                                문제지 (PDF)
                            </button>
                            <button
                                onClick={() => setActiveViewTab('answer')}
                                style={{
                                    flex: 1, padding: '0.5rem', borderRadius: '4px', border: 'none',
                                    background: activeViewTab === 'answer' ? '#10b981' : '#444',
                                    color: 'white', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s',
                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem'
                                }}
                            >
                                <FolderOpen size={15} />
                                참고용 답지
                            </button>
                            <button
                                onClick={() => {
                                    if (answerKeyPdf) window.open(URL.createObjectURL(answerKeyPdf), '_blank');
                                }}
                                style={{
                                    padding: '0.5rem', borderRadius: '4px', border: '1px solid #555',
                                    background: 'transparent', color: '#ccc', fontSize: '0.8rem', cursor: 'pointer',
                                    whiteSpace: 'nowrap'
                                }}
                                title="답지를 새 웹 브라우저 탭에서 엽니다"
                            >
                                새 탭 열기
                            </button>
                        </div>
                    )}

                    <div style={{ flex: 1, position: 'relative' }}>
                        <PDFViewer
                            file={activeViewTab === 'problem' ? pdfFile : answerKeyPdf}
                            onLoadSuccess={() => undefined}
                            onPageClick={activeViewTab === 'problem' ? handlePdfPageClick : undefined}
                            onFileDrop={activeViewTab === 'problem' ? handleFileDrop : setAnswerKeyPdf}
                            markers={activeViewTab === 'problem'
                                ? questions
                                    .filter(q => q.pdfLocation || q.pdfRegion)
                                    .map(q => {
                                        const region = q.pdfRegion;
                                        const anchor = q.pdfLocation || (region
                                            ? {
                                                page: region.page,
                                                x: region.x + region.width / 2,
                                                y: region.y + region.height / 2,
                                            }
                                            : undefined);
                                        if (!anchor) return null;
                                        return {
                                            page: anchor.page,
                                            x: anchor.x,
                                            y: anchor.y,
                                            label: q.number,
                                            color: selectedQuestionId === q.id ? '#6366f1' : '#ef4444',
                                            region: region
                                                ? { x: region.x, y: region.y, width: region.width, height: region.height }
                                                : undefined,
                                            onClick: () => setSelectedQuestionId(q.id)
                                        };
                                    })
                                    .filter((marker): marker is NonNullable<typeof marker> => !!marker)
                                : []}
                        />
                    </div>
                </div>

                {/* Resizer 1 */}
                <div
                    className={`create-resizer ${activeResizer === 'pdf' ? 'is-active' : ''}`}
                    style={{ width: '6px', background: 'var(--border)', cursor: 'col-resize', position: 'relative', zIndex: 10 }}
                    onPointerDown={(e) => beginPanelDrag(e, 'pdf', pdfWidth, applyPdfWidth)}
                    onDoubleClick={() => applyPdfWidth(PDF_PANE_DEFAULT_WIDTH)}
                    role="separator"
                    aria-orientation="vertical"
                    title="드래그해서 PDF 영역 크기 조절 · 더블클릭하면 기본 크기로"
                >
                    <div style={{ width: '2px', height: '20px', background: '#aaa', position: 'absolute', top: '50%', left: '2px', transform: 'translateY(-50%)', borderRadius: '2px' }} />
                </div>

                {/* 2. Settings Sidebar */}
                <aside ref={settingsSidebarRef} className="glass-panel scroll-custom create-settings-sidebar" style={{
                    width: `${sidebarWidth}px`,
                    minWidth: `${SETTINGS_SIDEBAR_MIN_WIDTH}px`,
                    padding: '1.5rem',
                    flex: isPreviewCollapsed ? `1 1 ${sidebarWidth}px` : `0 0 ${sidebarWidth}px`,
                    overflowY: 'auto',
                    background: 'var(--surface)',
                    borderRight: '1px solid var(--border)',
                    borderRadius: 0
                }}>
                    <div className="create-settings-sticky-summary">
                        <div style={{ minWidth: 0 }}>
                            <h2 style={{ fontSize: '1.08rem', marginBottom: '0.18rem', fontWeight: 900, lineHeight: 1.2 }}>
                                설정
                            </h2>
                            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700 }}>
                                {editId ? '시험 편집' : '새 시험'} · {questionsCount}문항 · {defaultChoices}지선다
                            </div>
                        </div>
                        <div className="create-settings-toolbar">
                            <button
                                type="button"
                                className="create-settings-tool-button"
                                onClick={() => adjustSettingsZoom(-SETTINGS_ZOOM_STEP)}
                                disabled={settingsZoom <= SETTINGS_ZOOM_MIN}
                                aria-label="설정 내용 축소"
                                title="설정 내용 축소"
                            >
                                <ZoomOut size={14} />
                            </button>
                            <span className="create-settings-zoom-value">{Math.round(settingsZoom * 100)}%</span>
                            <button
                                type="button"
                                className="create-settings-tool-button"
                                onClick={() => adjustSettingsZoom(SETTINGS_ZOOM_STEP)}
                                disabled={settingsZoom >= SETTINGS_ZOOM_MAX}
                                aria-label="설정 내용 확대"
                                title="설정 내용 확대"
                            >
                                <ZoomIn size={14} />
                            </button>
                            <button
                                type="button"
                                className="create-settings-tool-button"
                                onClick={scrollSettingsToTop}
                                aria-label="설정 맨 위로 이동"
                                title="설정 맨 위로 이동"
                            >
                                <ArrowUpToLine size={14} />
                            </button>
                            <button
                                type="button"
                                className="create-settings-tool-button"
                                onClick={toggleComfortSidebarWidth}
                                aria-label={sidebarWidth >= SETTINGS_SIDEBAR_COMFORT_WIDTH - 24 ? "설정 패널 기본 폭" : "설정 패널 넓게 보기"}
                                title={sidebarWidth >= SETTINGS_SIDEBAR_COMFORT_WIDTH - 24 ? "설정 패널 기본 폭" : "설정 패널 넓게 보기"}
                            >
                                {sidebarWidth >= SETTINGS_SIDEBAR_COMFORT_WIDTH - 24 ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                            </button>
                            <span
                                className={`create-publish-chip ${serviceReadiness.canOpenDistribution ? 'is-ready' : 'needs-work'}`}
                                title={serviceReadiness.detail}
                            >
                                {serviceReadiness.canOpenDistribution ? '배포 가능' : '확인 필요'}
                            </span>
                        </div>
                    </div>

                    <div className="create-settings-content" style={{ zoom: settingsZoom } as CSSProperties & { zoom: number }}>
                    <div style={{ marginBottom: '1.5rem' }}>
                        {answerKeyPdf && (
                            <div style={{ marginBottom: '1rem', padding: '0.8rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(16, 185, 129, 0.25)', fontSize: '0.85rem' }}>
                                <div style={{ color: 'var(--success)', fontWeight: 700, marginBottom: '0.2rem' }}>✓ 참고용 답지 등록됨</div>
                                <div style={{ color: 'var(--success)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>{answerKeyPdf.name}</div>
                                <button
                                    onClick={() => window.open(URL.createObjectURL(answerKeyPdf), '_blank')}
                                    style={{ marginTop: '0.4rem', color: 'var(--success)', textDecoration: 'underline', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.75rem' }}
                                >
                                    파일 보기
                                </button>
                            </div>
                        )}

                        <div className="create-design-check-compact">
                            <div className="create-design-check-top">
                                <div className="create-design-check-title">
                                    <span>설계 체크</span>
                                </div>
                                <span
                                    className={`create-design-check-pill ${designSummary.answered === questionsCount ? 'is-ready' : 'needs-work'}`}
                                >
                                    {designSummary.answered}/{questionsCount} 정답
                                </span>
                            </div>

                            <div className="create-design-metrics-mini">
                                {[
                                    { label: '개념', value: `${designSummary.conceptTagged}/${questionsCount}` },
                                    { label: 'PDF', value: `${designSummary.pdfLinked}/${questionsCount}` },
                                    { label: '필기', value: `${designSummary.pdfRegionLinked}/${questionsCount}` },
                                    { label: '심화', value: `${designSummary.highDifficulty}` },
                                ].map(item => (
                                    <div key={item.label} className="create-design-metric-mini">
                                        <span>{item.label}</span>
                                        <strong>{item.value}</strong>
                                    </div>
                                ))}
                            </div>

                            <div
                                className="create-readiness-line"
                                style={{
                                    '--readiness-color': serviceReadinessTone.color,
                                    '--readiness-bg': serviceReadinessTone.background,
                                    '--readiness-border': serviceReadinessTone.border,
                                } as CSSProperties}
                                title={serviceReadiness.detail}
                            >
                                <span className="create-readiness-dot" />
                                <strong>운영 점검</strong>
                                <span>{serviceReadiness.label}</span>
                                <em>{serviceReadiness.detail}</em>
                            </div>

                            <div className="create-readiness-mini-list">
                                {compactReadinessItems.map(item => {
                                    const tone = readinessTone(item.status);
                                    return (
                                        <div
                                            key={item.key}
                                            className="create-readiness-mini-item"
                                            title={item.message}
                                            style={{
                                                '--readiness-item-color': tone.color,
                                            } as CSSProperties}
                                        >
                                            <span>{item.label}</span>
                                            <strong>{item.value}</strong>
                                        </div>
                                    );
                                })}
                            </div>

                            {designSummary.totalExpectedMin > 0 && (
                                <div className="create-design-check-note">
                                    예상 풀이시간 약 {designSummary.totalExpectedMin}분
                                </div>
                            )}

                            <div
                                className={`create-validation-line ${validationSummary.isPublishable ? 'is-ready' : 'needs-work'}`}
                                title={validationTooltip}
                            >
                                <div>
                                    <strong>{validationSummary.isPublishable ? '배포 가능' : '수정 필요'}</strong>
                                    <span>{validationSummary.errors.length} 오류 · {validationSummary.warnings.length} 경고</span>
                                </div>
                            </div>
                        </div>

                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>시험 제목</label>
                        <input
                            type="text"
                            aria-label="시험 제목"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            className="input-field"
                            style={{ width: '100%', padding: '0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)' }}
                        />
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>문항 수: {questionsCount}</label>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {[20, 25, 30, 40, 50].map(count => (
                                <button
                                    key={count}
                                    className={`btn ${questionsCount === count ? 'btn-primary' : 'btn-secondary'}`}
                                    style={{ flex: 1, minWidth: '60px', padding: '0.5rem' }}
                                    onClick={() => handleQuestionCountChange(count)}
                                >
                                    {count}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>기본 선택지 수</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                                className={`btn ${defaultChoices === 5 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => handleDefaultChoicesChange(5)}
                            >
                                5지선다
                            </button>
                            <button
                                className={`btn ${defaultChoices === 4 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => handleDefaultChoicesChange(4)}
                            >
                                4지선다
                            </button>
                        </div>
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <button
                            className="btn btn-secondary"
                            style={{ width: '100%', marginBottom: '0.5rem', border: '1px dashed #6366f1', color: '#6366f1', background: 'rgba(99, 102, 241, 0.05)', display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}
                            onClick={() => setIsImportModalOpen(true)}
                        >
                            <BrainCircuit size={17} />
                            정답 인식 마법사 (답지 추출)
                        </button>

                        <button
                            className="btn btn-secondary"
                            style={{ width: '100%', marginBottom: '1rem', border: '1px solid #0f766e', color: '#0f766e', background: 'rgba(15, 118, 110, 0.06)', display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}
                            onClick={handleAutoDetectLocations}
                            disabled={isDetectingLocation || !pdfFile}
                        >
                            {isDetectingLocation ? <Loader2 size={17} className="animate-spin" /> : <Crosshair size={17} />}
                            {isDetectingLocation ? "위치 찾는 중..." : "PDF 문제 위치 자동 매칭"}
                        </button>

                        <div style={{ marginBottom: '1rem', padding: '0.85rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.65rem' }}>
                                <div>
                                    <div style={{ fontSize: '0.84rem', fontWeight: 900, color: 'var(--foreground)' }}>문항 영역 보정</div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '2px', lineHeight: 1.45 }}>
                                        필기 수집과 문항 DB용 PDF 영역입니다.
                                    </div>
                                </div>
                                <span style={{
                                    flexShrink: 0,
                                    fontSize: '0.7rem',
                                    fontWeight: 900,
                                    color: designSummary.pdfRegionLinked === questionsCount ? 'var(--success)' : 'var(--warning)',
                                    background: designSummary.pdfRegionLinked === questionsCount ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
                                    borderRadius: '999px',
                                    padding: '0.2rem 0.5rem',
                                }}>
                                    {designSummary.pdfRegionLinked}/{questionsCount}
                                </span>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleReinferQuestionRegions}
                                    disabled={designSummary.pdfLinked === 0}
                                    style={{ padding: '0.48rem 0.55rem', fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
                                    title="현재 찍힌 문항 위치를 기준으로 영역을 다시 계산합니다"
                                >
                                    <RefreshCw size={14} />
                                    다시 계산
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={handleClearAllPdfRegions}
                                    disabled={designSummary.pdfRegionLinked === 0}
                                    style={{ padding: '0.48rem 0.55rem', fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
                                    title="문항 위치는 유지하고 추론된 영역만 지웁니다"
                                >
                                    <Unlink size={14} />
                                    영역 초기화
                                </button>
                            </div>
                        </div>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)' }}>
                                빠른 정답 입력 (연속 입력)
                            </label>
                            <input
                                type="text"
                                aria-label="빠른 정답 입력"
                                placeholder={defaultChoices === 4 ? "예: 3124..." : "예: 31251..."}
                                value={fastAnswer}
                                onChange={handleFastAnswerChange}
                                className="input-field"
                                style={{ width: '100%', padding: '0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '1rem', letterSpacing: '2px' }}
                            />
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
                                {`1~${defaultChoices}의 숫자를 입력하면 문항 순서대로 정답이 즉시 반영됩니다.`}
                            </div>
                        </div>

                        <div className="create-question-quick-card">
                            <div className="create-question-quick-header">
                                <div>
                                    <div className="create-question-quick-title">문항 빠른 세팅</div>
                                    <div className="create-question-quick-subtitle">
                                        {selectedQuestion
                                            ? `${selectedQuestion.number}번 · ${selectedAnswerStatus} · ${selectedQuestion.label || selectedQuestion.tags?.concept || "라벨 없음"}`
                                            : "OMR에서 문항을 선택하면 바로 답안과 라벨을 조정합니다."}
                                    </div>
                                </div>
                                <span className="create-question-quick-badge">
                                    {selectedQuestion ? `${selectedQuestion.number}번` : "미선택"}
                                </span>
                            </div>

                            {selectedQuestion ? (
                                <div className="create-question-quick-body">
                                    <div className="create-question-quick-row" aria-label="선택 문항 정답">
                                        <span>답안</span>
                                        <div className="create-question-answer-buttons">
                                            {Array.from({ length: selectedQuestionChoiceCount }, (_, i) => i + 1).map(num => (
                                                <button
                                                    key={num}
                                                    type="button"
                                                    className={selectedQuestion.answer === num ? "is-active" : ""}
                                                    onClick={() => setAnswer(num)}
                                                    aria-pressed={selectedQuestion.answer === num}
                                                >
                                                    {num}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="create-question-quick-row" aria-label="선택 문항 배점">
                                        <span>배점</span>
                                        <div className="create-question-score-buttons">
                                            {[2, 3, 4, 5].map(pts => (
                                                <button
                                                    key={pts}
                                                    type="button"
                                                    className={selectedQuestion.score === pts ? "is-active" : ""}
                                                    onClick={() => setScore(pts)}
                                                    aria-pressed={selectedQuestion.score === pts}
                                                >
                                                    {pts}
                                                </button>
                                            ))}
                                            <input
                                                type="number"
                                                min="0"
                                                step="0.5"
                                                aria-label="선택 문항 직접 배점"
                                                value={selectedQuestion.score || ""}
                                                onChange={(e) => {
                                                    const val = parseFloat(e.target.value);
                                                    if (!Number.isNaN(val)) setScore(val);
                                                }}
                                            />
                                        </div>
                                    </div>

                                    <div className="create-question-quick-row" aria-label="선택 문항 라벨">
                                        <span>라벨</span>
                                        <div className="create-question-label-buttons">
                                            {knownLabels.slice(0, 8).map(label => (
                                                <button
                                                    key={label}
                                                    type="button"
                                                    className={selectedQuestion.label === label ? "is-active" : ""}
                                                    onClick={() => toggleLabel(label)}
                                                    aria-pressed={selectedQuestion.label === label}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="create-question-quick-empty">
                                    우측 OMR 문항을 누르면 답안·배점·라벨을 여기서 바로 바꿀 수 있습니다.
                                </div>
                            )}
                        </div>

                        <div className="create-label-batch-card">
                            <div className="create-label-batch-header">
                                <div>
                                    <div className="create-label-batch-title">문항 라벨 일괄 적용</div>
                                    <div className="create-label-batch-subtitle">
                                        {labelBatch.start}~{labelBatch.end}번 · {designSummary.conceptTagged}/{questionsCount} 라벨
                                    </div>
                                </div>
                                <span className="create-label-batch-count">{knownLabels.length}개 후보</span>
                            </div>

                            <div className="create-label-batch-range">
                                <label>
                                    시작
                                    <input
                                        type="number"
                                        min={1}
                                        max={questionsCount}
                                        value={labelBatch.start}
                                        onChange={(e) => setLabelBatchRange(parseInt(e.target.value, 10), labelBatch.end)}
                                    />
                                </label>
                                <label>
                                    끝
                                    <input
                                        type="number"
                                        min={1}
                                        max={questionsCount}
                                        value={labelBatch.end}
                                        onChange={(e) => setLabelBatchRange(labelBatch.start, parseInt(e.target.value, 10))}
                                    />
                                </label>
                            </div>

                            <input
                                type="text"
                                value={labelBatch.label}
                                onChange={(e) => setLabelBatch(prev => ({ ...prev, label: e.target.value }))}
                                placeholder="유형/라벨 예: 독해, 어법, 빈칸"
                                className="input-field create-label-batch-input"
                            />

                            <div className="create-label-batch-presets" aria-label="라벨 후보">
                                {knownLabels.map(label => (
                                    <button
                                        key={label}
                                        type="button"
                                        className={labelBatch.label === label ? "is-active" : ""}
                                        onClick={() => setLabelBatch(prev => ({ ...prev, label }))}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>

                            <div className="create-label-batch-grid">
                                <input
                                    type="text"
                                    value={labelBatch.unit}
                                    onChange={(e) => setLabelBatch(prev => ({ ...prev, unit: e.target.value }))}
                                    placeholder="단원"
                                    className="input-field"
                                />
                                <input
                                    type="text"
                                    value={labelBatch.concept}
                                    onChange={(e) => setLabelBatch(prev => ({ ...prev, concept: e.target.value }))}
                                    placeholder="세부 개념"
                                    className="input-field"
                                />
                            </div>

                            <div className="create-label-batch-difficulty" aria-label="난이도 일괄 설정">
                                {DIFFICULTY_OPTIONS.map(option => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        className={labelBatch.difficulty === option.value ? "is-active" : ""}
                                        onClick={() => setLabelBatch(prev => ({
                                            ...prev,
                                            difficulty: prev.difficulty === option.value ? "" : option.value,
                                        }))}
                                        style={{ '--label-tone': option.tone } as React.CSSProperties}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>

                            <div className="create-label-batch-actions">
                                <button type="button" className="btn btn-secondary" onClick={setSelectedQuestionAsLabelRange}>
                                    선택 기준
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={() => setLabelBatchRange(1, questionsCount)}>
                                    전체
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={() => applyBatchLabels(true)}>
                                    빈 라벨 채우기
                                </button>
                                <button type="button" className="btn btn-primary" onClick={() => applyBatchLabels(false)}>
                                    범위 적용
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Selected Question Detail Editor */}
                    <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>
                            {selectedQuestionId ? `문항 #${selectedQuestionId} 편집` : '문항을 선택하세요'}
                        </h3>

                        {selectedQuestionId ? (
                            <div className="animate-fade-in">
                                {/* Answer Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>정답 설정</label>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        {Array.from({ length: defaultChoices }, (_, i) => i + 1).map(num => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isSelected = currentQ?.answer === num;
                                            return (
                                                <button
                                                    key={num}
                                                    onClick={() => setAnswer(num)}
                                                    style={{
                                                        width: '30px', height: '30px',
                                                        borderRadius: '50%',
                                                        border: isSelected ? 'none' : '1px solid var(--border)',
                                                        background: isSelected ? 'var(--primary)' : 'var(--surface)',
                                                        color: isSelected ? 'white' : 'var(--foreground)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.85rem', fontWeight: 700,
                                                        transition: 'all 0.2s',
                                                        cursor: 'pointer',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {num}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Score Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>배점 (점수)</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                                        {[2, 3, 4, 5].map(pts => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isSelected = currentQ?.score === pts;
                                            return (
                                                <button
                                                    key={pts}
                                                    onClick={() => setScore(pts)}
                                                    style={{
                                                        padding: '4px 10px',
                                                        borderRadius: '12px',
                                                        border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                        background: isSelected ? 'rgba(99, 102, 241, 0.1)' : 'var(--surface)',
                                                        color: isSelected ? 'var(--primary)' : 'var(--muted)',
                                                        fontSize: '0.8rem', fontWeight: 700,
                                                        transition: 'all 0.2s',
                                                        cursor: 'pointer',
                                                        whiteSpace: 'nowrap',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {pts}점
                                                </button>
                                            );
                                        })}
                                        <input
                                            type="number"
                                            placeholder="직접"
                                            value={questions.find(q => q.id === selectedQuestionId)?.score || ''}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                if (!isNaN(val)) setScore(val);
                                            }}
                                            style={{ width: '60px', minWidth: '55px', padding: '4px 6px', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '12px', background: 'var(--surface)', color: 'var(--foreground)' }}
                                            min="0"
                                            step="0.5"
                                        />
                                    </div>
                                </div>

                                {/* Label Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>라벨 (클릭하여 선택)</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                        {knownLabels.map(tag => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isActive = currentQ?.label === tag;
                                            return (
                                                <button
                                                    key={tag}
                                                    onClick={() => toggleLabel(tag)}
                                                    style={{
                                                        fontSize: '0.8rem', padding: '4px 10px', borderRadius: '12px',
                                                        border: isActive ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                        background: isActive ? 'rgba(99, 102, 241, 0.1)' : 'var(--surface)',
                                                        color: isActive ? 'var(--primary)' : 'var(--muted)',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {tag}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                                        <input
                                            type="text"
                                            placeholder="+ 직접 입력"
                                            value={customLabel}
                                            onChange={(e) => setCustomLabel(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && customLabel.trim()) {
                                                    toggleLabel(customLabel.trim());
                                                    setCustomLabel("");
                                                }
                                            }}
                                            className="input-field"
                                            style={{ flex: 1, padding: '0.3rem 0.6rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                                        />
                                        <button
                                            className="btn btn-secondary"
                                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                                            onClick={() => {
                                                if (customLabel.trim()) {
                                                    toggleLabel(customLabel.trim());
                                                    setCustomLabel("");
                                                }
                                            }}
                                        >
                                            추가
                                        </button>
                                    </div>
                                </div>

                                {/* Advanced Design Metadata */}
                                <div style={{ marginBottom: '1rem', padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <button
                                        type="button"
                                        aria-expanded={isAdvancedDesignOpen}
                                        aria-controls="advanced-design-fields"
                                        onClick={() => setIsAdvancedDesignOpen(open => !open)}
                                        style={{
                                            width: '100%',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: '0.5rem',
                                            padding: 0,
                                            border: 0,
                                            background: 'transparent',
                                            color: 'inherit',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        <div>
                                            <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--foreground)' }}>전문가 설계</div>
                                            <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '2px' }}>
                                                분석 리포트와 보충 처방에 쓰입니다.
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                                            <span
                                                style={{
                                                    fontSize: '0.68rem',
                                                    color: hasSelectedAdvancedDesign ? 'var(--success)' : 'var(--primary)',
                                                    fontWeight: 800,
                                                    background: hasSelectedAdvancedDesign ? 'rgba(16,185,129,0.1)' : 'rgba(99,102,241,0.1)',
                                                    padding: '2px 7px',
                                                    borderRadius: 'var(--radius-full)',
                                                    whiteSpace: 'nowrap',
                                                }}
                                            >
                                                {hasSelectedAdvancedDesign ? '입력됨' : '선택사항'}
                                            </span>
                                            <ChevronDown
                                                size={16}
                                                aria-hidden="true"
                                                style={{
                                                    color: 'var(--muted)',
                                                    transform: isAdvancedDesignOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                                    transition: 'transform 0.18s ease',
                                                }}
                                            />
                                        </div>
                                    </button>

                                    {isAdvancedDesignOpen ? (
                                        <div id="advanced-design-fields" style={{ display: 'grid', gap: '0.65rem', marginTop: '0.75rem' }}>
                                        <div>
                                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>단원</label>
                                            <input
                                                type="text"
                                                value={selectedQuestion?.tags?.unit || ''}
                                                onChange={(e) => setQuestionTag('unit', e.target.value.trim() || undefined)}
                                                placeholder="예: 문법 > 시제"
                                                className="input-field"
                                                style={{ width: '100%', padding: '0.45rem 0.55rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' }}
                                            />
                                        </div>

                                        <div>
                                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>세부 개념</label>
                                            <input
                                                type="text"
                                                value={selectedQuestion?.tags?.concept || ''}
                                                onChange={(e) => setQuestionTag('concept', e.target.value.trim() || undefined)}
                                                placeholder="예: 현재완료와 과거시제 구분"
                                                className="input-field"
                                                style={{ width: '100%', padding: '0.45rem 0.55rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' }}
                                            />
                                        </div>

                                        <div>
                                            <label style={{ display: 'block', marginBottom: '0.35rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>난이도</label>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.35rem' }}>
                                                {DIFFICULTY_OPTIONS.map(option => {
                                                    const isActive = selectedQuestion?.tags?.difficulty === option.value;
                                                    return (
                                                        <button
                                                            key={option.value}
                                                            type="button"
                                                            onClick={() => setQuestionTag('difficulty', isActive ? undefined : option.value)}
                                                            style={{
                                                                padding: '0.4rem 0.25rem',
                                                                borderRadius: '8px',
                                                                border: isActive ? `1px solid ${option.tone}` : '1px solid var(--border)',
                                                                background: isActive ? `${option.tone}18` : 'var(--surface)',
                                                                color: isActive ? option.tone : 'var(--muted)',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 800,
                                                                cursor: 'pointer',
                                                            }}
                                                        >
                                                            {option.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        <div>
                                            <label style={{ display: 'block', marginBottom: '0.35rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>인지 수준</label>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.35rem' }}>
                                                {COGNITIVE_LEVEL_OPTIONS.map(option => {
                                                    const isActive = selectedQuestion?.tags?.cognitiveLevel === option.value;
                                                    return (
                                                        <button
                                                            key={option.value}
                                                            type="button"
                                                            onClick={() => setQuestionTag('cognitiveLevel', isActive ? undefined : option.value)}
                                                            style={{
                                                                padding: '0.38rem 0.25rem',
                                                                borderRadius: '8px',
                                                                border: isActive ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                                background: isActive ? 'rgba(99,102,241,0.1)' : 'var(--surface)',
                                                                color: isActive ? 'var(--primary)' : 'var(--muted)',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 800,
                                                                cursor: 'pointer',
                                                            }}
                                                        >
                                                            {option.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                                            <div>
                                                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>예상 시간(초)</label>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    value={selectedQuestion?.tags?.expectedTimeSec || ''}
                                                    onChange={(e) => {
                                                        const next = parseInt(e.target.value, 10);
                                                        setQuestionTag('expectedTimeSec', Number.isFinite(next) && next > 0 ? next : undefined);
                                                    }}
                                                    placeholder="90"
                                                    className="input-field"
                                                    style={{ width: '100%', padding: '0.45rem 0.55rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' }}
                                                />
                                            </div>
                                            <div>
                                                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>출처</label>
                                                <input
                                                    type="text"
                                                    value={selectedQuestion?.tags?.source || ''}
                                                    onChange={(e) => setQuestionTag('source', e.target.value.trim() || undefined)}
                                                    placeholder="내신/기출/자체"
                                                    className="input-field"
                                                    style={{ width: '100%', padding: '0.45rem 0.55rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' }}
                                                />
                                            </div>
                                        </div>

                                        <div>
                                            <label style={{ display: 'block', marginBottom: '0.35rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>주요 오답 원인</label>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.45rem' }}>
                                                {DEFAULT_MISTAKE_TYPES.map(type => {
                                                    const current = selectedQuestion?.tags?.mistakeTypes || [];
                                                    const isActive = current.includes(type);
                                                    return (
                                                        <button
                                                            key={type}
                                                            type="button"
                                                            onClick={() => {
                                                                const next = isActive
                                                                    ? current.filter(item => item !== type)
                                                                    : [...current, type];
                                                                setQuestionTag('mistakeTypes', next);
                                                            }}
                                                            style={{
                                                                padding: '0.3rem 0.5rem',
                                                                borderRadius: '999px',
                                                                border: isActive ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                                background: isActive ? 'rgba(99,102,241,0.1)' : 'var(--surface)',
                                                                color: isActive ? 'var(--primary)' : 'var(--muted)',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 800,
                                                                cursor: 'pointer',
                                                            }}
                                                        >
                                                            {type}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            <input
                                                type="text"
                                                value={joinTagInput(selectedQuestion?.tags?.mistakeTypes)}
                                                onChange={(e) => setQuestionTag('mistakeTypes', splitTagInput(e.target.value))}
                                                placeholder="쉼표로 직접 입력"
                                                className="input-field"
                                                style={{ width: '100%', padding: '0.45rem 0.55rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' }}
                                            />
                                        </div>

                                        <div>
                                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted)' }}>학생 공개 해설</label>
                                            <textarea
                                                value={selectedQuestion?.explanation || ''}
                                                onChange={(e) => setExplanation(e.target.value)}
                                                placeholder="시험 제출 후 학생 리뷰에 보여줄 핵심 해설"
                                                className="input-field"
                                                style={{ width: '100%', minHeight: '74px', resize: 'vertical', padding: '0.5rem 0.6rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)', lineHeight: 1.5 }}
                                            />
                                        </div>
                                        </div>
                                    ) : null}
                                </div>
                                <div style={{ marginBottom: '1rem', padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.65rem' }}>
                                        <div>
                                            <div style={{ fontSize: '0.85rem', fontWeight: 900, color: 'var(--foreground)' }}>PDF 문항 연결</div>
                                            <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '2px', lineHeight: 1.45 }}>
                                                위치는 문제 번호 마커, 영역은 필기 수집 범위입니다.
                                            </div>
                                        </div>
                                        <span style={{
                                            fontSize: '0.68rem',
                                            color: selectedQuestion?.pdfRegion ? 'var(--success)' : selectedQuestion?.pdfLocation ? 'var(--warning)' : 'var(--muted)',
                                            fontWeight: 900,
                                            background: 'var(--surface)',
                                            border: '1px solid var(--border)',
                                            padding: '2px 7px',
                                            borderRadius: 'var(--radius-full)',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {selectedQuestion?.pdfRegion ? '영역 저장됨' : selectedQuestion?.pdfLocation ? '위치 저장됨' : '미연결'}
                                        </span>
                                    </div>

                                    {selectedQuestion?.pdfLocation ? (
                                        <div style={{ display: 'grid', gap: '0.45rem', fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.65rem' }}>
                                            <div>
                                                위치: {selectedQuestion.pdfLocation.page}쪽 · x {formatRegionPercent(selectedQuestion.pdfLocation.x)} · y {formatRegionPercent(selectedQuestion.pdfLocation.y)}
                                            </div>
                                            {selectedQuestion.pdfRegion ? (
                                                <div>
                                                    영역: x {formatRegionPercent(selectedQuestion.pdfRegion.x)} · y {formatRegionPercent(selectedQuestion.pdfRegion.y)} · w {formatRegionPercent(selectedQuestion.pdfRegion.width)} · h {formatRegionPercent(selectedQuestion.pdfRegion.height)}
                                                </div>
                                            ) : (
                                                <div style={{ color: 'var(--warning)', fontWeight: 800 }}>
                                                    영역이 없으면 저장 시 자동 계산됩니다.
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '0.65rem' }}>
                                            왼쪽 문제지 PDF에서 이 문항의 번호 위치를 클릭하세요.
                                        </div>
                                    )}

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                                        <button
                                            type="button"
                                            className="btn btn-secondary"
                                            onClick={handleReinferQuestionRegions}
                                            disabled={designSummary.pdfLinked === 0}
                                            style={{ padding: '0.45rem 0.5rem', fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.32rem' }}
                                            title="전체 문항의 영역을 다시 계산합니다"
                                        >
                                            <RefreshCw size={13} />
                                            영역 갱신
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-secondary"
                                            onClick={handleClearSelectedPdfLink}
                                            disabled={!selectedQuestion?.pdfLocation && !selectedQuestion?.pdfRegion}
                                            style={{ padding: '0.45rem 0.5rem', fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.32rem' }}
                                            title="선택 문항의 PDF 위치와 영역을 해제합니다"
                                        >
                                            <Unlink size={13} />
                                            연결 해제
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                우측 미리보기에서 문항을 클릭하면 상세 편집 및 PDF 연결이 가능합니다.
                            </p>
                        )}
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>레이아웃</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                                className={`btn ${columns === 2 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => setColumns(2)}
                            >
                                2단
                            </button>
                            <button
                                className={`btn ${columns === 3 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => setColumns(3)}
                            >
                                3단
                            </button>
                        </div>
                    </div>

                    <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.04)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--foreground)' }}>
                            일정 설정
                            {loadedExam && (
                                <span style={{ marginLeft: 8, fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary)', background: 'rgba(99,102,241,0.1)', padding: '2px 8px', borderRadius: 'var(--radius-full)' }}>
                                    편집 중
                                </span>
                            )}
                        </h3>

                        <div style={{ marginBottom: '0.75rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>시험 시간(분)</label>
                            <input
                                type="number"
                                min={1}
                                value={durationMin}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === "") {
                                        setDurationMin("");
                                        return;
                                    }
                                    setDurationAndSyncEnd(parseInt(v, 10) || 1);
                                }}
                                className="input-field"
                                style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '0.9rem' }}
                            />
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.35rem', marginTop: '0.5rem' }}>
                                {DURATION_PRESETS.map(minutes => (
                                    <button
                                        key={minutes}
                                        type="button"
                                        onClick={() => setDurationAndSyncEnd(minutes)}
                                        className={`btn ${durationMin === minutes ? 'btn-primary' : 'btn-secondary'}`}
                                        style={{ padding: '0.38rem 0.35rem', fontSize: '0.74rem', borderRadius: 'var(--radius-md)' }}
                                    >
                                        {minutes}분
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div style={{ marginBottom: '0.75rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>시작 시각</label>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.35rem', marginBottom: '0.5rem' }}>
                                {SCHEDULE_PRESETS.map(preset => (
                                    <button
                                        key={preset.key}
                                        type="button"
                                        onClick={() => applySchedulePreset(preset.key)}
                                        className="btn btn-secondary"
                                        style={{ padding: '0.38rem 0.35rem', fontSize: '0.74rem', borderRadius: 'var(--radius-md)' }}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>
                            <input
                                type="datetime-local"
                                value={startAt}
                                onChange={(e) => setStartAndSyncEnd(e.target.value)}
                                className="input-field"
                                style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '0.85rem' }}
                            />
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>종료 시각</label>
                            <input
                                type="datetime-local"
                                value={endAt}
                                onChange={(e) => setEndAt(e.target.value)}
                                className="input-field"
                                style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '0.85rem' }}
                            />
                            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
                                <button
                                    type="button"
                                    onClick={() => startAt && setEndAt(addMinutesToLocalInput(startAt, durationValue))}
                                    className="btn btn-secondary"
                                    disabled={!startAt}
                                    style={{ flex: 1, padding: '0.4rem 0.5rem', fontSize: '0.75rem', borderRadius: 'var(--radius-md)' }}
                                >
                                    종료 자동 맞춤
                                </button>
                                <button
                                    type="button"
                                    onClick={clearSchedule}
                                    className="btn btn-secondary"
                                    style={{ flex: 1, padding: '0.4rem 0.5rem', fontSize: '0.75rem', borderRadius: 'var(--radius-md)' }}
                                >
                                    기간 비우기
                                </button>
                            </div>
                        </div>

                        <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--muted)' }}>
                            {startAt && endAt
                                ? `${durationValue}분 시험으로 저장됩니다.`
                                : '비워두면 제한 없이 응시할 수 있습니다.'}
                        </p>
                    </div>

                    <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => typeof window !== 'undefined' && window.print()}>
                        인쇄하기
                    </button>
                    </div>
                </aside>

                {/* Resizer 2 */}
                <div
                    className={`create-resizer ${activeResizer === 'sidebar' ? 'is-active' : ''}`}
                    style={{ width: '6px', background: 'var(--border)', cursor: 'col-resize', position: 'relative', zIndex: 10 }}
                    onPointerDown={(e) => beginPanelDrag(e, 'sidebar', sidebarWidth, (nextWidth, workspaceWidth) => fitSidebarWidth(nextWidth, false, workspaceWidth))}
                    onDoubleClick={() => fitSidebarWidth(SETTINGS_SIDEBAR_DEFAULT_WIDTH, true)}
                    role="separator"
                    aria-orientation="vertical"
                    title="드래그해서 설정 패널 크기 조절 · 더블클릭하면 기본 크기로"
                >
                    <div style={{ width: '2px', height: '20px', background: '#aaa', position: 'absolute', top: '50%', left: '2px', transform: 'translateY(-50%)', borderRadius: '2px' }} />
                </div>

                {/* 3. OMR Preview */}
                <main className={`create-preview-main ${isPreviewCollapsed ? 'is-collapsed' : ''}`} style={{
                    flex: isPreviewCollapsed ? `0 0 ${PREVIEW_RAIL_WIDTH}px` : 1,
                    width: isPreviewCollapsed ? `${PREVIEW_RAIL_WIDTH}px` : undefined,
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: isPreviewCollapsed ? `${PREVIEW_RAIL_WIDTH}px` : `${PREVIEW_PANE_MIN_WIDTH}px`,
                    overflow: 'hidden',
                    background: 'var(--background)',
                }}>
                    {isPreviewCollapsed ? (
                        <div className="create-preview-collapsed-rail">
                            <button
                                type="button"
                                onClick={() => setIsPreviewCollapsed(false)}
                                aria-label="OMR 미리보기 펼치기"
                                title="OMR 미리보기 펼치기"
                            >
                                <PanelRightOpen size={18} />
                                <span>OMR</span>
                                <strong>{designSummary.answered}/{questionsCount}</strong>
                            </button>
                        </div>
                    ) : (
                        <>
                    <div className="create-preview-toolbar" style={{
                        padding: '0.75rem 1.25rem',
                        borderBottom: '1px solid var(--border)',
                        background: 'var(--surface)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexShrink: 0,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--foreground)', letterSpacing: 0, whiteSpace: 'nowrap' }}>
                                OMR 미리보기
                            </span>
                            <span className="create-preview-status">
                                {designSummary.answered}/{questionsCount} 정답 입력
                            </span>
                        </div>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            flexWrap: 'wrap',
                            justifyContent: 'flex-end',
                        }}>
                            <button
                                type="button"
                                className="create-preview-icon-button"
                                onClick={() => setIsPreviewCollapsed(true)}
                                aria-label="OMR 미리보기 접기"
                                title="OMR 미리보기 접기"
                            >
                                <PanelRightClose size={16} />
                            </button>
                    </div>
                    </div>

                    <div className="create-preview-context-strip" aria-label="미리보기 작업 상태">
                        <div className="create-preview-context-meter" aria-label={`정답 입력률 ${answeredPercent}%`}>
                            <span style={{ width: `${answeredPercent}%` }} />
                        </div>
                        <div className="create-preview-context-grid">
                            {[
                                { label: "선택 문항", value: selectedQuestionStatus },
                                { label: "정답", value: selectedAnswerStatus },
                                { label: "PDF 영역", value: selectedPdfStatus },
                                { label: "운영", value: serviceReadiness.label },
                            ].map(item => (
                                <div key={item.label} className="create-preview-context-item">
                                    <span>{item.label}</span>
                                    <strong>{item.value}</strong>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="scroll-custom create-preview-scroll card-mode" style={{
                        flex: 1,
                        overflowY: 'auto',
                        overflowX: 'auto',
                        padding: '0',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'stretch',
                        background: 'transparent',
                    }}>
                        <div className="create-card-stage">
                            <OMRCardView
                                title={title}
                                questions={questions}
                                optionsCount={defaultChoices}
                                mode="editor"
                                selectedQuestionId={selectedQuestionId}
                                onQuestionClick={setSelectedQuestionId}
                                onAnswerClick={handleOMRAnswerClick}
                                columns={columns}
                                numberingLayout="vertical"
                                showMeta={true}
                            />
                        </div>
                    </div>
                    <div className="create-print-only-sheet" aria-hidden="true">
                        <OMRPreview
                            sheetId="omr-print-sheet"
                            title={title}
                            questions={questions}
                            optionsCount={defaultChoices}
                            columns={columns}
                            mode="view"
                            showAnswerKey={false}
                        />
                    </div>
                        </>
                    )}
                </main>

            </div >
        </div >
    );
}
