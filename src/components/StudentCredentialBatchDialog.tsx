"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, Download, KeyRound, LoaderCircle, X } from "lucide-react";
import { serializeStudentCredentialCsv, type StudentCredentialCsvRow } from "@/lib/studentCredentialCsv";

export type FrozenCredentialStudent = Readonly<{
    studentId: string;
    name: string;
    group: string;
}>;

type IssuedCredential = Readonly<{ studentId: string; startCode: string }>;

type BatchActionResult =
    | { status: "issued"; credentials: IssuedCredential[]; idempotencyKey: string }
    | { status: "already_applied"; error: "replayed_without_credentials"; idempotencyKey: string }
    | { status: "outcome_unknown"; error: "outcome_unknown"; idempotencyKey: string }
    | { status: "rejected"; error: "invalid_input" | "forbidden" | "capacity_exceeded" | "conflict" }
    | { status: "unavailable"; error: "dependency_unavailable" };

export type StudentCredentialBatchDialogPhase =
    | "confirm"
    | "issuing"
    | "ready_once"
    | "confirm_discard"
    | "confirm_fresh_rotation"
    | "replayed_without_codes"
    | "outcome_unknown"
    | "rejected"
    | "download_dispatched"
    | "cleared";

export type StudentCredentialBatchDialogState = Readonly<{
    phase: StudentCredentialBatchDialogPhase;
    idempotencyKey: string | null;
    frozenStudents: readonly FrozenCredentialStudent[];
    credentials: readonly IssuedCredential[];
    csv: string | null;
    retryable: boolean;
    message: string | null;
}>;

type DialogEvent =
    | { type: "OPENED" }
    | { type: "ISSUE_STARTED"; idempotencyKey: string; frozenStudents: readonly FrozenCredentialStudent[] }
    | { type: "ISSUE_SUCCEEDED"; requestKey: string; credentials: readonly IssuedCredential[]; csv: string | null }
    | { type: "OUTCOME_UNKNOWN"; requestKey: string }
    | { type: "REPLAYED_WITHOUT_CODES"; requestKey: string }
    | { type: "ISSUE_REJECTED"; requestKey: string; message?: string }
    | { type: "DEPENDENCY_UNAVAILABLE"; requestKey: string }
    | { type: "STATUS_RETRY_STARTED" }
    | { type: "CLOSE_REQUESTED" }
    | { type: "DISCARD_CANCELLED" }
    | { type: "DISCARD_CONFIRMED" }
    | { type: "FRESH_ROTATION_REQUESTED" }
    | { type: "FRESH_ROTATION_CANCELLED" }
    | { type: "DOWNLOAD_FAILED" }
    | { type: "DOWNLOAD_DISPATCHED" }
    | { type: "FORCE_CLEARED" };

const EMPTY_SECRETS = {
    idempotencyKey: null,
    frozenStudents: [] as readonly FrozenCredentialStudent[],
    credentials: [] as readonly IssuedCredential[],
    csv: null,
};

export const initialStudentCredentialBatchDialogState: StudentCredentialBatchDialogState = {
    phase: "confirm",
    ...EMPTY_SECRETS,
    retryable: false,
    message: null,
};

export function studentCredentialBatchDialogReducer(
    state: StudentCredentialBatchDialogState,
    event: DialogEvent,
): StudentCredentialBatchDialogState {
    switch (event.type) {
        case "OPENED":
            return state.phase === "cleared" || state.phase === "download_dispatched"
                ? initialStudentCredentialBatchDialogState
                : state;
        case "ISSUE_STARTED":
            if (state.phase !== "confirm" && state.phase !== "outcome_unknown" && !state.retryable
                && state.phase !== "confirm_fresh_rotation") return state;
            return {
                phase: "issuing",
                idempotencyKey: event.idempotencyKey,
                frozenStudents: event.frozenStudents,
                credentials: [],
                csv: null,
                retryable: false,
                message: null,
            };
        case "ISSUE_SUCCEEDED":
            if (state.phase !== "issuing" || state.idempotencyKey !== event.requestKey) return state;
            return { ...state, phase: "ready_once", credentials: event.credentials, csv: event.csv, message: null };
        case "OUTCOME_UNKNOWN":
            if (state.phase !== "issuing" || state.idempotencyKey !== event.requestKey) return state;
            return {
                ...state,
                phase: "outcome_unknown",
                credentials: [],
                csv: null,
                retryable: true,
                message: "발급 결과를 확인할 수 없습니다. 같은 요청으로 상태를 다시 확인하세요.",
            };
        case "REPLAYED_WITHOUT_CODES":
            if (state.phase !== "issuing" || state.idempotencyKey !== event.requestKey) return state;
            return {
                ...state,
                phase: "replayed_without_codes",
                idempotencyKey: null,
                credentials: [],
                csv: null,
                retryable: false,
                message: "발급은 완료됐지만 시작 코드는 보안상 다시 표시할 수 없습니다.",
            };
        case "ISSUE_REJECTED":
            if (state.phase !== "issuing" || state.idempotencyKey !== event.requestKey) return state;
            return {
                ...state,
                phase: "rejected",
                idempotencyKey: null,
                credentials: [],
                csv: null,
                retryable: false,
                message: event.message || "발급 요청이 거부되었습니다.",
            };
        case "DEPENDENCY_UNAVAILABLE":
            if (state.phase !== "issuing" || state.idempotencyKey !== event.requestKey) return state;
            return {
                ...state,
                phase: "rejected",
                credentials: [],
                csv: null,
                retryable: true,
                message: "발급을 시작하지 못했습니다. 같은 요청으로 다시 확인할 수 있습니다.",
            };
        case "STATUS_RETRY_STARTED":
            if ((state.phase !== "outcome_unknown" && state.phase !== "rejected")
                || !state.retryable || !state.idempotencyKey || state.frozenStudents.length === 0) return state;
            return { ...state, phase: "issuing", retryable: false, message: null };
        case "CLOSE_REQUESTED":
            if (state.phase === "issuing" || state.phase === "outcome_unknown"
                || (state.phase === "rejected" && state.retryable)) return state;
            if (state.phase === "ready_once") return { ...state, phase: "confirm_discard" };
            return { ...initialStudentCredentialBatchDialogState, phase: "cleared" };
        case "DISCARD_CANCELLED":
            return state.phase === "confirm_discard" ? { ...state, phase: "ready_once" } : state;
        case "DISCARD_CONFIRMED":
        case "FORCE_CLEARED":
            return { ...initialStudentCredentialBatchDialogState, phase: "cleared" };
        case "FRESH_ROTATION_REQUESTED":
            if (state.phase !== "replayed_without_codes") return state;
            return { ...state, phase: "confirm_fresh_rotation" };
        case "FRESH_ROTATION_CANCELLED":
            return state.phase === "confirm_fresh_rotation"
                ? { ...state, phase: "replayed_without_codes" }
                : state;
        case "DOWNLOAD_FAILED":
            return state.phase === "ready_once"
                ? { ...state, message: "발급은 완료되었습니다. 로컬 CSV 다운로드만 다시 시도하세요." }
                : state;
        case "DOWNLOAD_DISPATCHED":
            return state.phase === "ready_once"
                ? { ...initialStudentCredentialBatchDialogState, phase: "download_dispatched" }
                : state;
        default:
            return state;
    }
}

export function freezeStudentCredentialSelection(
    expectedStudents: readonly FrozenCredentialStudent[],
    students: readonly FrozenCredentialStudent[],
): readonly FrozenCredentialStudent[] {
    if (!Array.isArray(expectedStudents) || !Array.isArray(students)
        || expectedStudents.length < 1 || expectedStudents.length > 100
        || students.length !== expectedStudents.length) {
        throw new Error("invalid credential selection");
    }
    const seen = new Set<string>();
    const frozen = expectedStudents.map((expected, index) => {
        const current = students[index];
        if (!expected || !current
            || expected.studentId !== current.studentId
            || expected.name !== current.name
            || expected.group !== current.group
            || seen.has(expected.studentId)) {
            throw new Error("stale credential selection");
        }
        seen.add(expected.studentId);
        return Object.freeze({
            studentId: current.studentId,
            name: current.name,
            group: current.group,
        });
    });
    serializeStudentCredentialCsv(frozen.map(student => ({
        ...student,
        startCode: "AB2CD3",
    })));
    return Object.freeze(frozen);
}

type DownloadEffects = {
    createBlob(csv: string): Blob;
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
    dispatchDownload(url: string): void;
};

export function createStudentCredentialDownloadController(effects: DownloadEffects): {
    download(csv: string): boolean;
    cleanup(): void;
} {
    let activeBlob: Blob | null = null;
    let activeUrl: string | null = null;
    let dispatched = false;
    const cleanup = () => {
        if (activeUrl) effects.revokeObjectURL(activeUrl);
        activeUrl = null;
        activeBlob = null;
    };
    return {
        download(csv) {
            if (dispatched) return false;
            cleanup();
            try {
                activeBlob = effects.createBlob(csv);
                activeUrl = effects.createObjectURL(activeBlob);
                effects.dispatchDownload(activeUrl);
                dispatched = true;
                return true;
            } catch {
                cleanup();
                return false;
            }
        },
        cleanup,
    };
}

export function createStudentCredentialRequestGuard(): {
    begin(): number | null;
    isCurrent(token: number): boolean;
    finish(token: number): void;
    invalidate(): void;
} {
    let epoch = 0;
    let activeToken: number | null = null;
    return {
        begin() {
            if (activeToken !== null) return null;
            epoch += 1;
            activeToken = epoch;
            return activeToken;
        },
        isCurrent(token) {
            return activeToken === token;
        },
        finish(token) {
            if (activeToken === token) activeToken = null;
        },
        invalidate() {
            epoch += 1;
            activeToken = null;
        },
    };
}

function secureIdempotencyKey(): string {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
        throw new Error("secure random unavailable");
    }
    const bytes = new Uint8Array(24);
    cryptoApi.getRandomValues(bytes);
    let suffix = "";
    for (const byte of bytes) suffix += byte.toString(16).padStart(2, "0");
    return `batch_${suffix}`;
}

function exactCredentialRows(
    frozenStudents: readonly FrozenCredentialStudent[],
    credentials: readonly IssuedCredential[],
): StudentCredentialCsvRow[] {
    if (credentials.length !== frozenStudents.length) throw new Error("credential response mismatch");
    const metadata = new Map(frozenStudents.map(student => [student.studentId, student]));
    const seen = new Set<string>();
    return credentials.map(credential => {
        const student = metadata.get(credential.studentId);
        if (!student || seen.has(credential.studentId)) throw new Error("credential response mismatch");
        seen.add(credential.studentId);
        return { ...student, startCode: credential.startCode };
    });
}

export type StudentCredentialBatchDialogProps = {
    open: boolean;
    expectedStudents: readonly FrozenCredentialStudent[];
    students: readonly FrozenCredentialStudent[];
    issueStudentCredentialBatch(
        studentIds: readonly string[],
        idempotencyKey: string,
    ): Promise<BatchActionResult>;
    onIssued?(studentIds: readonly string[]): void;
    onClose(): void;
};

export default function StudentCredentialBatchDialog({
    open,
    expectedStudents,
    students,
    issueStudentCredentialBatch,
    onIssued,
    onClose,
}: StudentCredentialBatchDialogProps) {
    const pathname = usePathname();
    const [state, setState] = useState(initialStudentCredentialBatchDialogState);
    const [downloadPending, setDownloadPending] = useState(false);
    const stateRef = useRef(state);
    const pathnameRef = useRef(pathname);
    const previousOpenRef = useRef(false);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const dialogRef = useRef<HTMLElement | null>(null);
    const downloadLockRef = useRef(false);
    const activeRequestRef = useRef<number | null>(null);
    const requestCloseRef = useRef<() => void>(() => {});
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const requestGuardRef = useRef<ReturnType<typeof createStudentCredentialRequestGuard> | null>(null);
    if (!requestGuardRef.current) requestGuardRef.current = createStudentCredentialRequestGuard();
    const expectedStudentIds = useMemo(
        () => expectedStudents.map(student => student.studentId),
        [expectedStudents],
    );
    const controllerRef = useRef<ReturnType<typeof createStudentCredentialDownloadController> | null>(null);
    if (!controllerRef.current && typeof window !== "undefined") {
        controllerRef.current = createStudentCredentialDownloadController({
            createBlob: csv => new Blob([csv], { type: "text/csv;charset=utf-8" }),
            createObjectURL: blob => URL.createObjectURL(blob),
            revokeObjectURL: url => URL.revokeObjectURL(url),
            dispatchDownload: url => {
                const link = document.createElement("a");
                try {
                    link.href = url;
                    link.download = "student-start-codes.csv";
                    link.rel = "noopener";
                    document.body.appendChild(link);
                    link.click();
                } finally {
                    link.remove();
                    link.removeAttribute("href");
                }
            },
        });
    }
    useEffect(() => { stateRef.current = state; }, [state]);

    const clearSecrets = useCallback(() => {
        requestGuardRef.current?.invalidate();
        activeRequestRef.current = null;
        controllerRef.current?.cleanup();
        downloadLockRef.current = false;
        setDownloadPending(false);
        setState(current => studentCredentialBatchDialogReducer(current, { type: "FORCE_CLEARED" }));
    }, []);

    useEffect(() => {
        const handlePageHide = () => clearSecrets();
        const handlePageShow = (event: PageTransitionEvent) => {
            if (!event.persisted) return;
            clearSecrets();
            onCloseRef.current();
        };
        window.addEventListener("pagehide", handlePageHide);
        window.addEventListener("pageshow", handlePageShow);
        return () => {
            window.removeEventListener("pagehide", handlePageHide);
            window.removeEventListener("pageshow", handlePageShow);
            requestGuardRef.current?.invalidate();
            controllerRef.current?.cleanup();
            previousFocusRef.current?.focus({ preventScroll: true });
        };
    }, [clearSecrets]);

    useEffect(() => {
        if (pathnameRef.current !== pathname) {
            pathnameRef.current = pathname;
            clearSecrets();
            onCloseRef.current();
        }
    }, [clearSecrets, pathname]);

    useEffect(() => {
        const wasOpen = previousOpenRef.current;
        previousOpenRef.current = open;
        if (open && !wasOpen) {
            previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setState(current => studentCredentialBatchDialogReducer(current, { type: "OPENED" }));
            requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
            return;
        }
        if (!open && wasOpen) clearSecrets();
    }, [clearSecrets, open]);

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                if (stateRef.current.phase !== "issuing") requestCloseRef.current();
                return;
            }
            if (event.key !== "Tab" || !dialogRef.current) return;
            const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            )];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [open]);

    useEffect(() => {
        const unresolved = state.phase === "outcome_unknown" || (state.phase === "rejected" && state.retryable);
        if (state.phase !== "issuing" && !unresolved) return;
        const preventNavigation = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", preventNavigation);
        return () => window.removeEventListener("beforeunload", preventNavigation);
    }, [state.phase, state.retryable]);

    useEffect(() => {
        if (state.phase === "issuing" || activeRequestRef.current === null) return;
        requestGuardRef.current?.finish(activeRequestRef.current);
        activeRequestRef.current = null;
    }, [state.phase]);

    const runIssue = useCallback(async (
        frozenStudents: readonly FrozenCredentialStudent[],
        idempotencyKey: string,
        retry: boolean,
        requestToken: number,
    ) => {
        setState(current => studentCredentialBatchDialogReducer(current, retry
            ? { type: "STATUS_RETRY_STARTED" }
            : { type: "ISSUE_STARTED", idempotencyKey, frozenStudents }));
        try {
            const result = await issueStudentCredentialBatch(
                frozenStudents.map(student => student.studentId),
                idempotencyKey,
            );
            if (!requestGuardRef.current?.isCurrent(requestToken)) return;
            if ((result.status === "issued" || result.status === "already_applied" || result.status === "outcome_unknown")
                && result.idempotencyKey !== idempotencyKey) {
                setState(current => studentCredentialBatchDialogReducer(current, {
                    type: "OUTCOME_UNKNOWN", requestKey: idempotencyKey,
                }));
                return;
            }
            if (result.status === "issued") {
                let csv: string;
                try {
                    csv = serializeStudentCredentialCsv(exactCredentialRows(frozenStudents, result.credentials));
                } catch {
                    setState(current => studentCredentialBatchDialogReducer(current, {
                        type: "OUTCOME_UNKNOWN", requestKey: idempotencyKey,
                    }));
                    return;
                }
                setState(current => studentCredentialBatchDialogReducer(current, {
                    type: "ISSUE_SUCCEEDED",
                    requestKey: idempotencyKey,
                    credentials: result.credentials,
                    csv,
                }));
                onIssued?.(result.credentials.map(credential => credential.studentId));
                return;
            }
            if (result.status === "already_applied") {
                setState(current => studentCredentialBatchDialogReducer(current, {
                    type: "REPLAYED_WITHOUT_CODES", requestKey: idempotencyKey,
                }));
                return;
            }
            if (result.status === "outcome_unknown") {
                setState(current => studentCredentialBatchDialogReducer(current, {
                    type: "OUTCOME_UNKNOWN", requestKey: idempotencyKey,
                }));
                return;
            }
            if (result.status === "unavailable") {
                setState(current => studentCredentialBatchDialogReducer(current, {
                    type: "DEPENDENCY_UNAVAILABLE", requestKey: idempotencyKey,
                }));
                return;
            }
            setState(current => studentCredentialBatchDialogReducer(current, {
                type: "ISSUE_REJECTED",
                requestKey: idempotencyKey,
                message: result.error === "conflict"
                    ? "같은 요청 키가 다른 학생 목록에 사용되어 발급이 거부되었습니다."
                    : "학생 목록을 확인한 뒤 다시 시도하세요.",
            }));
        } catch {
            if (!requestGuardRef.current?.isCurrent(requestToken)) return;
            setState(current => studentCredentialBatchDialogReducer(current, {
                type: "OUTCOME_UNKNOWN", requestKey: idempotencyKey,
            }));
        }
    }, [issueStudentCredentialBatch, onIssued]);

    const handleConfirm = useCallback(() => {
        const requestToken = requestGuardRef.current?.begin();
        if (requestToken === null || requestToken === undefined) return;
        activeRequestRef.current = requestToken;
        try {
            const frozenStudents = freezeStudentCredentialSelection(expectedStudents, students);
            const idempotencyKey = secureIdempotencyKey();
            void runIssue(frozenStudents, idempotencyKey, false, requestToken);
        } catch {
            requestGuardRef.current?.finish(requestToken);
            activeRequestRef.current = null;
            setState(current => current.phase === "confirm"
                ? { ...current, phase: "rejected", retryable: false, message: "선택 학생 정보가 변경되었거나 CSV 한도를 초과했습니다." }
                : current);
        }
    }, [expectedStudents, runIssue, students]);

    const handleStatusRetry = useCallback(() => {
        if (!state.idempotencyKey || state.frozenStudents.length === 0) return;
        const requestToken = requestGuardRef.current?.begin();
        if (requestToken === null || requestToken === undefined) return;
        activeRequestRef.current = requestToken;
        void runIssue(state.frozenStudents, state.idempotencyKey, true, requestToken);
    }, [runIssue, state.frozenStudents, state.idempotencyKey]);

    const handleFreshRotation = useCallback(() => {
        const requestToken = requestGuardRef.current?.begin();
        if (requestToken === null || requestToken === undefined) return;
        activeRequestRef.current = requestToken;
        try {
            const frozenStudents = freezeStudentCredentialSelection(expectedStudents, students);
            const idempotencyKey = secureIdempotencyKey();
            void runIssue(frozenStudents, idempotencyKey, false, requestToken);
        } catch {
            requestGuardRef.current?.finish(requestToken);
            activeRequestRef.current = null;
            setState(current => ({ ...current, phase: "rejected", idempotencyKey: null, retryable: false,
                message: "학생 정보가 변경되어 새 발급을 시작하지 않았습니다." }));
        }
    }, [expectedStudents, runIssue, students]);

    const handleDownload = useCallback(() => {
        if (downloadLockRef.current || state.phase !== "ready_once" || state.credentials.length === 0) return;
        downloadLockRef.current = true;
        setDownloadPending(true);
        let csv = state.csv;
        try {
            csv ||= serializeStudentCredentialCsv(exactCredentialRows(state.frozenStudents, state.credentials));
        } catch {
            setDownloadPending(false);
            downloadLockRef.current = false;
            setState(current => studentCredentialBatchDialogReducer(current, { type: "DOWNLOAD_FAILED" }));
            return;
        }
        if (!controllerRef.current?.download(csv)) {
            setDownloadPending(false);
            downloadLockRef.current = false;
            setState(current => studentCredentialBatchDialogReducer(current, { type: "DOWNLOAD_FAILED" }));
            return;
        }
        controllerRef.current.cleanup();
        setState(current => studentCredentialBatchDialogReducer(current, { type: "DOWNLOAD_DISPATCHED" }));
        setDownloadPending(false);
        downloadLockRef.current = false;
        onClose();
    }, [onClose, state]);

    const requestClose = useCallback(() => {
        if (state.phase === "issuing" || state.phase === "outcome_unknown"
            || (state.phase === "rejected" && state.retryable)
            || activeRequestRef.current !== null) return;
        if (state.phase === "ready_once") {
            setState(current => studentCredentialBatchDialogReducer(current, { type: "CLOSE_REQUESTED" }));
            return;
        }
        clearSecrets();
        onClose();
    }, [clearSecrets, onClose, state.phase, state.retryable]);
    requestCloseRef.current = requestClose;

    const confirmDiscard = useCallback(() => {
        clearSecrets();
        onClose();
    }, [clearSecrets, onClose]);

    if (!open) return null;

    const count = expectedStudentIds.length;
    const ready = state.phase === "ready_once";
    const confirmDiscardOpen = state.phase === "confirm_discard";
    const confirmFreshOpen = state.phase === "confirm_fresh_rotation";

    return (
        <div
            className="modal-overlay"
            role="presentation"
            onMouseDown={event => {
                if (event.target === event.currentTarget) requestClose();
            }}
            style={{ position: "fixed", inset: 0, zIndex: 1700, display: "grid", placeItems: "center",
                padding: "1rem", background: "rgba(15, 23, 42, 0.58)" }}
        >
            <section
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="student-credential-batch-title"
                style={{ width: "min(560px, 100%)", borderRadius: "1rem", background: "var(--surface)",
                    border: "1px solid var(--border)", boxShadow: "0 24px 70px rgba(15,23,42,.28)", padding: "1.25rem" }}
                onMouseDown={event => event.stopPropagation()}
            >
                <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: ".5rem", color: "var(--primary)" }}>
                            <KeyRound size={20} aria-hidden="true" />
                            <h2 id="student-credential-batch-title" style={{ margin: 0, fontSize: "1.1rem" }}>
                                학생 시작 코드 일괄 발급
                            </h2>
                        </div>
                        <p style={{ margin: ".5rem 0 0", color: "var(--text-secondary)", lineHeight: 1.55 }}>
                            선택한 {count}명의 코드를 한 번만 CSV로 내려받습니다.
                        </p>
                    </div>
                    <button type="button" aria-label="닫기" onClick={requestClose}
                        disabled={state.phase === "issuing" || state.phase === "outcome_unknown" || (state.phase === "rejected" && state.retryable)}
                        className="btn btn-ghost" style={{ padding: ".4rem" }}><X size={18} /></button>
                </header>

                {(state.phase === "confirm" || confirmFreshOpen) && (
                    <div style={{ marginTop: "1rem" }}>
                        <div style={{ display: "flex", gap: ".6rem", padding: ".85rem", borderRadius: ".75rem",
                            color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", lineHeight: 1.55 }}>
                            <AlertTriangle size={20} style={{ flex: "0 0 auto", marginTop: 2 }} aria-hidden="true" />
                            <span>발급 즉시 선택한 모든 학생의 기존 코드와 기존 로그인 세션도 즉시 종료됩니다.</span>
                        </div>
                        {confirmFreshOpen && <p style={{ color: "var(--danger)", fontWeight: 700 }}>
                            새 요청으로 발급하면 방금 적용된 코드도 다시 폐기됩니다. 계속할까요?
                        </p>}
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem", marginTop: "1rem" }}>
                            <button type="button" className="btn btn-secondary" onClick={confirmFreshOpen
                                ? () => setState(current => studentCredentialBatchDialogReducer(current, { type: "FRESH_ROTATION_CANCELLED" }))
                                : requestClose}>취소</button>
                            <button type="button" className="btn btn-primary" onClick={confirmFreshOpen ? handleFreshRotation : handleConfirm}>
                                {confirmFreshOpen ? "새 코드로 다시 발급" : `${count}명 발급`}
                            </button>
                        </div>
                    </div>
                )}

                {state.phase === "issuing" && (
                    <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: ".65rem", padding: "1.5rem 0" }}>
                        <LoaderCircle className="spin" size={22} aria-hidden="true" />
                        <span>코드를 안전하게 발급하고 있습니다. 창을 닫거나 이동하지 마세요.</span>
                    </div>
                )}

                {ready && (
                    <div style={{ marginTop: "1rem" }}>
                        <p style={{ lineHeight: 1.6 }}>발급이 완료되었습니다. 이 CSV는 지금 한 번만 내려받을 수 있습니다.</p>
                        {state.message && <p role="alert" style={{ color: "var(--danger)" }}>{state.message}</p>}
                        <button type="button" className="btn btn-primary" onClick={handleDownload} disabled={downloadPending}
                            style={{ width: "100%", justifyContent: "center" }}>
                            <Download size={18} aria-hidden="true" /> CSV 다운로드
                        </button>
                    </div>
                )}

                {confirmDiscardOpen && (
                    <div style={{ marginTop: "1rem" }}>
                        <p style={{ color: "var(--danger)", fontWeight: 700, lineHeight: 1.6 }}>
                            내려받지 않고 닫으면 시작 코드를 다시 볼 수 없습니다. 발급 자체는 취소되거나 롤백되지 않습니다.
                        </p>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem" }}>
                            <button type="button" className="btn btn-secondary"
                                onClick={() => setState(current => studentCredentialBatchDialogReducer(current, { type: "DISCARD_CANCELLED" }))}>
                                다운로드로 돌아가기
                            </button>
                            <button type="button" className="btn btn-danger" onClick={confirmDiscard}>코드 폐기하고 닫기</button>
                        </div>
                    </div>
                )}

                {(state.phase === "outcome_unknown" || state.phase === "replayed_without_codes" || state.phase === "rejected") && (
                    <div style={{ marginTop: "1rem" }}>
                        <p role="alert" style={{ lineHeight: 1.6 }}>{state.message}</p>
                        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: ".5rem" }}>
                            {state.retryable && <button type="button" className="btn btn-primary" onClick={handleStatusRetry}>
                                같은 요청 상태 다시 확인
                            </button>}
                            {state.phase === "replayed_without_codes" && (
                                <button type="button" className="btn btn-secondary"
                                    onClick={() => setState(current => studentCredentialBatchDialogReducer(current, { type: "FRESH_ROTATION_REQUESTED" }))}>
                                    새 코드 발급
                                </button>
                            )}
                            {!state.retryable && <button type="button" className="btn btn-ghost" onClick={requestClose}>닫기</button>}
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}
