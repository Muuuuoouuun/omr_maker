import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type DialogState = {
    phase: string;
    idempotencyKey?: string | null;
    credentials?: unknown[];
    csv?: string | null;
    retryable?: boolean;
};

type FrozenStudent = { studentId: string; name: string; group: string };

type DialogModule = {
    initialStudentCredentialBatchDialogState: DialogState;
    studentCredentialBatchDialogReducer(state: DialogState, event: Record<string, unknown>): DialogState;
    freezeStudentCredentialSelection(
        expectedStudents: readonly FrozenStudent[],
        students: readonly FrozenStudent[],
    ): readonly FrozenStudent[];
    createStudentCredentialDownloadController(effects: {
        createBlob(csv: string): Blob;
        createObjectURL(blob: Blob): string;
        revokeObjectURL(url: string): void;
        dispatchDownload(url: string): void;
    }): { download(csv: string): boolean; cleanup(): void };
    createStudentCredentialRequestGuard(): {
        begin(): number | null;
        isCurrent(token: number): boolean;
        finish(token: number): void;
        invalidate(): void;
    };
};

function source(path: string): string {
    try {
        return readFileSync(resolve(process.cwd(), path), "utf8");
    } catch {
        return "";
    }
}

let dialogModule: DialogModule | null = null;

beforeAll(async () => {
    const modulePath = "../components/StudentCredentialBatchDialog";
    dialogModule = await import(/* @vite-ignore */ modulePath).catch(() => null) as DialogModule | null;
});

describe("student credential batch dialog surface", () => {
    it("declares the explicit secret lifecycle and destructive close states", () => {
        expect(dialogModule, "student credential batch dialog must exist").not.toBeNull();
        const reducer = dialogModule!.studentCredentialBatchDialogReducer;
        const initial = dialogModule!.initialStudentCredentialBatchDialogState;
        const issuing = reducer(initial, {
            type: "ISSUE_STARTED",
            idempotencyKey: `batch_${"A".repeat(32)}`,
            frozenStudents: [{ studentId: "student-1", name: "학생", group: "1반" }],
        });
        expect(issuing.phase).toBe("issuing");
        expect(reducer(issuing, { type: "CLOSE_REQUESTED" })).toEqual(issuing);

        const ready = reducer(issuing, {
            type: "ISSUE_SUCCEEDED",
            requestKey: `batch_${"A".repeat(32)}`,
            credentials: [{ studentId: "student-1", startCode: "AB2CD3" }],
            csv: "\uFEFFstudent_id,name,group,start_code\r\nstudent-1,학생,1반,AB2CD3\r\n",
        });
        expect(ready.phase).toBe("ready_once");
        const destructive = reducer(ready, { type: "CLOSE_REQUESTED" });
        expect(destructive.phase).toBe("confirm_discard");
        expect(destructive.credentials).toHaveLength(1);
        const cleared = reducer(destructive, { type: "DISCARD_CONFIRMED" });
        expect(cleared.phase).toBe("cleared");
        expect(cleared.credentials ?? []).toHaveLength(0);
        expect(cleared.csv ?? null).toBeNull();
        expect(cleared.idempotencyKey ?? null).toBeNull();
        expect(reducer(cleared, { type: "OPENED" }).phase).toBe("confirm");
    });

    it("retains the same key only for an explicit outcome-unknown status retry", () => {
        expect(dialogModule).not.toBeNull();
        const reducer = dialogModule!.studentCredentialBatchDialogReducer;
        const key = `batch_${"B".repeat(32)}`;
        const issuing = reducer(dialogModule!.initialStudentCredentialBatchDialogState, {
            type: "ISSUE_STARTED",
            idempotencyKey: key,
            frozenStudents: [{ studentId: "student-1", name: "학생", group: "1반" }],
        });
        const unknown = reducer(issuing, { type: "OUTCOME_UNKNOWN", requestKey: key });
        expect(unknown).toMatchObject({ phase: "outcome_unknown", idempotencyKey: key });
        expect(reducer(unknown, { type: "CLOSE_REQUESTED" })).toEqual(unknown);
        expect(reducer(unknown, { type: "FRESH_ROTATION_REQUESTED" })).toEqual(unknown);
        const retry = reducer(unknown, { type: "STATUS_RETRY_STARTED" });
        expect(retry).toMatchObject({ phase: "issuing", idempotencyKey: key });
    });

    it("keeps only ambiguous or pre-RPC unavailable requests retryable with the same key", () => {
        expect(dialogModule).not.toBeNull();
        const reducer = dialogModule!.studentCredentialBatchDialogReducer;
        const key = `batch_${"C".repeat(32)}`;
        const issuing = reducer(dialogModule!.initialStudentCredentialBatchDialogState, {
            type: "ISSUE_STARTED",
            idempotencyKey: key,
            frozenStudents: [{ studentId: "student-1", name: "학생", group: "1반" }],
        });
        const replay = reducer(issuing, { type: "REPLAYED_WITHOUT_CODES", requestKey: key });
        expect(replay).toMatchObject({ phase: "replayed_without_codes", idempotencyKey: null });
        expect(reducer(replay, { type: "STATUS_RETRY_STARTED" })).toEqual(replay);

        const rejected = reducer(issuing, { type: "ISSUE_REJECTED", requestKey: key });
        expect(rejected).toMatchObject({ phase: "rejected", idempotencyKey: null, retryable: false });
        expect(reducer(rejected, { type: "STATUS_RETRY_STARTED" })).toEqual(rejected);

        const unavailable = reducer(issuing, { type: "DEPENDENCY_UNAVAILABLE", requestKey: key });
        expect(unavailable).toMatchObject({ phase: "rejected", idempotencyKey: key, retryable: true });
        expect(reducer(unavailable, { type: "CLOSE_REQUESTED" })).toEqual(unavailable);
        expect(reducer(unavailable, { type: "FRESH_ROTATION_REQUESTED" })).toEqual(unavailable);
        expect(reducer(unavailable, { type: "STATUS_RETRY_STARTED" })).toMatchObject({
            phase: "issuing",
            idempotencyKey: key,
        });

        expect(reducer(replay, { type: "FRESH_ROTATION_REQUESTED" })).toMatchObject({
            phase: "confirm_fresh_rotation",
            idempotencyKey: null,
        });
    });

    it("ignores duplicate, stale, and wrong-key async completions without restoring secrets", () => {
        expect(dialogModule).not.toBeNull();
        const reducer = dialogModule!.studentCredentialBatchDialogReducer;
        const key = `batch_${"D".repeat(32)}`;
        const wrongKey = `batch_${"E".repeat(32)}`;
        const issuing = reducer(dialogModule!.initialStudentCredentialBatchDialogState, {
            type: "ISSUE_STARTED",
            idempotencyKey: key,
            frozenStudents: [{ studentId: "student-1", name: "학생", group: "1반" }],
        });
        const completionEvents = [
            { type: "ISSUE_SUCCEEDED", requestKey: wrongKey, credentials: [{ studentId: "student-1", startCode: "AB2CD3" }], csv: "secret" },
            { type: "REPLAYED_WITHOUT_CODES", requestKey: wrongKey },
            { type: "OUTCOME_UNKNOWN", requestKey: wrongKey },
            { type: "ISSUE_REJECTED", requestKey: wrongKey },
            { type: "DEPENDENCY_UNAVAILABLE", requestKey: wrongKey },
        ];
        for (const event of completionEvents) expect(reducer(issuing, event)).toEqual(issuing);

        const ready = reducer(issuing, {
            type: "ISSUE_SUCCEEDED",
            requestKey: key,
            credentials: [{ studentId: "student-1", startCode: "AB2CD3" }],
            csv: "secret",
        });
        expect(reducer(ready, {
            type: "ISSUE_SUCCEEDED",
            requestKey: key,
            credentials: [{ studentId: "student-1", startCode: "EF4GH5" }],
            csv: "new-secret",
        })).toEqual(ready);
        expect(reducer(ready, { type: "OUTCOME_UNKNOWN", requestKey: key })).toEqual(ready);
        const cleared = reducer(ready, { type: "FORCE_CLEARED" });
        expect(reducer(cleared, {
            type: "ISSUE_SUCCEEDED", requestKey: key,
            credentials: [{ studentId: "student-1", startCode: "EF4GH5" }], csv: "new-secret",
        })).toEqual(cleared);
        expect(reducer(cleared, { type: "STATUS_RETRY_STARTED" })).toEqual(cleared);
    });

    it("rejects stale, reordered, duplicate, empty, and oversized selections before issuance", () => {
        expect(dialogModule).not.toBeNull();
        const freeze = dialogModule!.freezeStudentCredentialSelection;
        const first = { studentId: "student-1", name: "가", group: "1반" };
        const second = { studentId: "student-2", name: "나", group: "2반" };

        expect(() => freeze([], [])).toThrow();
        expect(() => freeze([first, first], [first, first])).toThrow();
        expect(() => freeze([first, second], [second, first])).toThrow();
        expect(() => freeze([first, second], [first])).toThrow();
        expect(() => freeze(
            Array.from({ length: 101 }, (_, index) => ({
                studentId: `student-${index}`, name: "학생", group: "반",
            })),
            Array.from({ length: 101 }, (_, index) => ({
                studentId: `student-${index}`, name: "학생", group: "반",
            })),
        )).toThrow();
        expect(() => freeze([first, second], [first, { ...second, name: "교체됨" }])).toThrow();
        expect(() => freeze([first, second], [first, { ...second, group: "다른 반" }])).toThrow();
        const frozen = freeze([first, second], [first, second]);
        first.name = "요청 중 변경";
        expect(frozen[0].name).toBe("가");
        expect(Object.isFrozen(frozen)).toBe(true);
        expect(Object.isFrozen(frozen[0])).toBe(true);
    });

    it("revokes partial downloads, retains retry data on failure, and cleans idempotently", () => {
        expect(dialogModule).not.toBeNull();
        const revoked: string[] = [];
        let shouldThrow = true;
        const controller = dialogModule!.createStudentCredentialDownloadController({
            createBlob: csv => new Blob([csv]),
            createObjectURL: () => "blob:credential-once",
            revokeObjectURL: url => revoked.push(url),
            dispatchDownload: () => {
                if (shouldThrow) throw new Error("blocked click");
            },
        });
        const csv = "\uFEFFstudent_id,name,group,start_code\r\nstudent-1,가,1반,AB2CD3\r\n";

        expect(controller.download(csv)).toBe(false);
        expect(revoked).toEqual(["blob:credential-once"]);
        expect(csv).toContain("AB2CD3");
        shouldThrow = false;
        expect(controller.download(csv)).toBe(true);
        expect(controller.download(csv)).toBe(false);
        controller.cleanup();
        controller.cleanup();
        expect(revoked).toEqual(["blob:credential-once", "blob:credential-once"]);
    });

    it("uses a synchronous request guard to reject double submit and invalidate late results", () => {
        expect(dialogModule).not.toBeNull();
        const guard = dialogModule!.createStudentCredentialRequestGuard();
        const first = guard.begin();
        expect(first).not.toBeNull();
        expect(guard.begin()).toBeNull();
        expect(guard.isCurrent(first!)).toBe(true);
        guard.invalidate();
        expect(guard.isCurrent(first!)).toBe(false);
        const second = guard.begin();
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
        guard.finish(second!);
        expect(guard.begin()).not.toBeNull();
    });

    it("wires selected and one-student issuance through the one-time dialog only", () => {
        const page = source("src/app/teacher/users/page.tsx");
        const dialog = source("src/components/StudentCredentialBatchDialog.tsx");

        expect(page).toContain("StudentCredentialBatchDialog");
        expect(page).toContain("선택 학생 코드 발급");
        expect(page).not.toContain("issueStudentStartCredential");
        expect(page).not.toContain("setSessionStudentCodes");
        expect(page).not.toContain("selectedStartCode");
        expect(page).not.toContain("handleCopyStudentStartCode");
        expect(page).not.toContain("copy-student-start-code");
        expect(page).not.toContain("studentCredentialRequestKeysRef");
        expect(page).not.toMatch(/toast\.success\([\s\S]{0,300}nextCode/);
        expect(page).not.toContain("navigator.clipboard.writeText(loginInfo)");
        expect(page).not.toMatch(/studentCodeRegistry[\s\S]{0,180}startCode/);
        expect(page).toContain("localStorage.removeItem(STUDENT_CODES_STORAGE_KEY)");
        expect(page).not.toContain("seedLocalTestStudentAccounts(localStorage)");
        expect(dialog).toContain("기존 로그인 세션도 즉시 종료됩니다");
        expect(dialog).toContain("expectedStudentIds");
        expect(dialog).toContain("expectedStudents");
        expect(dialog).toContain("frozenStudents");
        expect(dialog).toContain("issueStudentCredentialBatch");
        expect(dialog).toContain("URL.revokeObjectURL");
        expect(dialog).toContain('window.addEventListener("pagehide"');
        expect(dialog).toContain('window.addEventListener("pageshow"');
        expect(dialog).toContain("event.persisted");
        expect(dialog).toContain('window.addEventListener("beforeunload"');
        expect(dialog).toContain("usePathname");
        expect(dialog).not.toMatch(/localStorage|sessionStorage|indexedDB|clipboard|console\./);
        expect(dialog.indexOf("freezeStudentCredentialSelection")).toBeLessThan(
            dialog.indexOf("issueStudentCredentialBatch"),
        );
    });

    it("keeps blob failures download-only and clears secrets after dispatch or lifecycle exit", () => {
        const dialog = source("src/components/StudentCredentialBatchDialog.tsx");

        expect(dialog).toContain("download_dispatched");
        expect(dialog).toContain("ready_once");
        expect(dialog).toContain("clearSecrets");
        expect(dialog).toContain("다운로드만 다시 시도");
        expect(dialog).not.toContain("setTimeout(() => issueStudentCredentialBatch");
    });

    it("defines a safe local journey and a fail-closed explicitly requested hosted gate", () => {
        const e2e = source("e2e/student-credential-batch.spec.ts");
        const playwrightConfig = source("playwright.config.ts");
        const plan = source("docs/superpowers/plans/2026-08-08-provisioned-identity-roster.md");
        const ci = source(".github/workflows/ci.yml");

        expect(e2e).toContain("OMR_STUDENT_CREDENTIAL_HOSTED_MODE");
        expect(e2e).toContain("unverified");
        expect(e2e).toContain('mode: "serial"');
        expect(e2e).toContain("retries: 0");
        expect(e2e).toContain("trace: \"off\"");
        expect(e2e).toContain("screenshot: \"off\"");
        expect(e2e).toContain("video: \"off\"");
        expect(e2e).toContain("finally");
        expect(e2e).toContain("OMR_STUDENT_CREDENTIAL_ALLOW_MUTATION");
        expect(e2e).toContain("OMR_STUDENT_CREDENTIAL_FIXTURE_ID");
        expect(e2e).toContain("baseURL");
        expect(e2e).toContain("OMR_STUDENT_CREDENTIAL_APPROVED_ORIGIN");
        expect(e2e).toContain("OMR_PRODUCTION_ORIGIN");
        expect(e2e).toContain('PLAYWRIGHT_NO_COPY_PROMPT = "1"');
        expect(e2e).toContain("submitWithSecret");
        expect(e2e).not.toMatch(/\.fill\((?:password|fixture\.code|oldCode|newCode)\)/);
        expect(e2e).not.toMatch(/test\.skip|test\.fixme/);
        expect(playwrightConfig).toContain('name: "student-credential-chromium"');
        expect(playwrightConfig).toContain('trace: "off"');
        expect(plan).toContain("--project=student-credential-chromium --workers=1 --retries=0 e2e/student-credential-batch.spec.ts");
        expect(ci).toContain("--project=student-credential-chromium --workers=1 --retries=0");
    });
});
