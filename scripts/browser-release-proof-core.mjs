import { RELEASE_ATOMIC_CHECKS } from "./release-quality-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_SUITES = 256;
const MAX_NESTING_DEPTH = 8;
const MAX_REPORT_SPECS = 4_096;
const MAX_TESTS_PER_SPEC = 32;
const MAX_ANNOTATIONS_PER_TEST = 64;

export const BROWSER_RELEASE_PROOF_IDS = Object.freeze([
    ...RELEASE_ATOMIC_CHECKS.student_core.map(({ id }) => id),
    ...RELEASE_ATOMIC_CHECKS.teacher_core.map(({ id }) => id),
    ...RELEASE_ATOMIC_CHECKS.ux_accessibility_responsiveness.map(({ id }) => id),
    "browser_determinism_credential_boundary",
    "browser_determinism_reduced_motion",
    "browser_determinism_fresh_context",
]);

const OWNERSHIP = Object.freeze({
    student_core_identity_entry: ["chromium", "e2e/full-journey.spec.ts", "requires student ID or email before opening a roster-backed student account"],
    student_core_assignment_state: ["chromium", "e2e/student-assignment-lifecycle.spec.ts", "local lifecycle fixture renders boundaries without claiming hosted authorization"],
    student_core_autosave_resume: ["webkit", "e2e/pwa-mobile.spec.ts", "lets students answer and submit an exam in the phone and tablet app shell"],
    student_core_exact_submit: ["chromium", "e2e/full-journey.spec.ts", "lets a start-code student submit an exam and feed teacher analytics"],
    student_core_history: ["chromium", "e2e/full-journey.spec.ts", "keeps tablet student history and review usable with real submission data"],
    student_core_question_feedback: ["chromium", "e2e/full-journey.spec.ts", "automatically sends an offline queued question after connectivity recovers"],
    student_core_cross_device: ["chromium", "e2e/full-journey.spec.ts", "reconciles manual and automatic submission receipt retries through the real server action"],
    student_core_handwriting_recovery: ["chromium", "e2e/student-handwriting-recovery.spec.ts", "restores and retries a private handwriting upload on phone and tablet"],
    student_core_retake: ["chromium", "e2e/full-journey.spec.ts", "skips the entry dialog and scopes questions when re-entering a retake from the student's own review"],
    student_core_guest_boundary: ["chromium", "e2e/student-dashboard-load-state.spec.ts", "dashboard data failure is not presented as an empty successful dashboard and can recover"],
    teacher_core_teacher_login: ["chromium", "e2e/full-journey.spec.ts", "creates an exam through the teacher UI before student submission and analytics"],
    teacher_core_truthful_load_states: ["chromium", "e2e/teacher-canonical-load-state.spec.ts", "teacher dashboard keeps a scoped degraded snapshot strictly read only"],
    teacher_core_draft_create: ["chromium", "e2e/full-journey.spec.ts", "creates an exam through the teacher UI before student submission and analytics"],
    teacher_core_publish_distribution: ["chromium", "e2e/full-journey.spec.ts", "creates an exam through the teacher UI before student submission and analytics"],
    teacher_core_live_monitor: ["chromium", "e2e/teacher-pages.spec.ts", "renders timer, stat tiles, students grid, heatmap, and controls refresh"],
    teacher_core_results_feedback: ["chromium", "e2e/teacher-pages.spec.ts", "returns plain-text feedback through the teacher result flow and shows it in student review"],
    teacher_core_statistics: ["chromium", "e2e/full-journey.spec.ts", "covers creation entry, student submission, teacher analytics, and statistics CSV"],
    teacher_core_csv_export: ["chromium", "e2e/full-journey.spec.ts", "covers creation entry, student submission, teacher analytics, and statistics CSV"],
    teacher_core_roster: ["chromium", "e2e/teacher-canonical-load-state.spec.ts", "teacher roster and distribution preserve failure, recovery, and degraded capabilities"],
    teacher_core_retest: ["chromium", "e2e/teacher-pages.spec.ts", "opens one student result hub and preserves the selected view across attempts"],
    ux_accessibility_responsiveness_student_mobile: ["webkit", "e2e/pwa-mobile.spec.ts", "lets students answer and submit an exam in the phone and tablet app shell"],
    ux_accessibility_responsiveness_teacher_mobile: ["webkit", "e2e/teacher-mobile.spec.ts", "keeps the dashboard header touch friendly"],
    ux_accessibility_responsiveness_tablet: ["chromium", "e2e/full-journey.spec.ts", "keeps the tablet solve rail usable for answer entry"],
    ux_accessibility_responsiveness_desktop: ["chromium", "e2e/full-journey.spec.ts", "keeps the desktop solve OMR as a blurred overlay without shrinking the PDF"],
    ux_accessibility_responsiveness_keyboard: ["chromium", "e2e/ui-ux-audit.spec.ts", "lets keyboard users bypass repeated teacher header controls"],
    ux_accessibility_responsiveness_screen_reader: ["chromium", "e2e/ui-ux-audit.spec.ts", "keeps one visible landing landmark and one role-specific level-one heading"],
    ux_accessibility_responsiveness_contrast: ["chromium", "e2e/teacher-pages.spec.ts", "away severity stays factual and escalates from neutral to attention"],
    ux_accessibility_responsiveness_reduced_motion: ["chromium", "e2e/ui-ux-audit.spec.ts", "uses balanced motion for primary actions, cards, modal panels, and tab indicators"],
    ux_accessibility_responsiveness_load_states: ["chromium", "e2e/student-dashboard-load-state.spec.ts", "dashboard data failure is not presented as an empty successful dashboard and can recover"],
    ux_accessibility_responsiveness_error_recovery: ["chromium", "e2e/student-dashboard-load-state.spec.ts", "dashboard data failure is not presented as an empty successful dashboard and can recover"],
    browser_determinism_credential_boundary: ["chromium", "e2e/full-journey.spec.ts", "requires student ID or email before opening a roster-backed student account"],
    browser_determinism_reduced_motion: ["chromium", "e2e/ui-ux-audit.spec.ts", "uses balanced motion for primary actions, cards, modal panels, and tab indicators"],
    browser_determinism_fresh_context: ["chromium", "e2e/ui-ux-audit.spec.ts", "keeps one visible landing landmark and one role-specific level-one heading"],
});

export class BrowserReleaseProofError extends Error {
    constructor() {
        super("Browser release proof evidence is invalid");
        this.name = "BrowserReleaseProofError";
    }
}

function fail() {
    throw new BrowserReleaseProofError();
}

function makeCatalog() {
    const ownershipKeys = Object.keys(OWNERSHIP);
    if (ownershipKeys.length !== BROWSER_RELEASE_PROOF_IDS.length
        || ownershipKeys.some((id) => !BROWSER_RELEASE_PROOF_IDS.includes(id))) fail();
    return Object.freeze(BROWSER_RELEASE_PROOF_IDS.map((id) => {
        const owner = OWNERSHIP[id];
        if (!Array.isArray(owner) || owner.length !== 3
            || !["chromium", "webkit"].includes(owner[0])
            || typeof owner[1] !== "string" || !/^e2e\/[a-z0-9-]+\.spec\.ts$/.test(owner[1])
            || typeof owner[2] !== "string" || owner[2].length < 8 || owner[2].length > 240) fail();
        return Object.freeze({ id, browser: owner[0], file: owner[1], title: owner[2] });
    }));
}

export const BROWSER_RELEASE_PROOF_CATALOG = makeCatalog();

const OWNER_BY_ID = new Map(BROWSER_RELEASE_PROOF_CATALOG.map((entry) => [entry.id, entry]));
const IDS_BY_BROWSER = new Map(["chromium", "webkit"].map((browser) => [
    browser,
    BROWSER_RELEASE_PROOF_CATALOG.filter((entry) => entry.browser === browser).map(({ id }) => id),
]));

function ownDataRecord(value, requiredKeys, optionalKeys = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail();
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (keys.some((key) => !allowed.has(key)) || requiredKeys.some((key) => !(key in descriptors))) fail();
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) fail();
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function exactArray(value, maximum, exactLength) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > maximum || (exactLength !== undefined && value.length !== exactLength)) fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.at(-1) !== "length"
        || keys.slice(0, -1).some((key, index) => key !== String(index))) fail();
    return [...value];
}

function boundedString(value, maximum = 512) {
    if (typeof value !== "string" || value.length > maximum) fail();
    return value;
}

function reportObject(value) {
    if (value instanceof Uint8Array) {
        if (value.byteLength < 2 || value.byteLength > MAX_REPORT_BYTES) fail();
        try {
            return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(value));
        } catch {
            fail();
        }
    }
    return value;
}

function annotationValues(value) {
    return exactArray(value, MAX_ANNOTATIONS_PER_TEST).map((annotation) => {
        const fields = ownDataRecord(annotation, ["type", "description"]);
        if (fields.type !== "release-proof") fail();
        return boundedString(fields.description, 128);
    });
}

function resultPassed(value) {
    const fields = ownDataRecord(value, [
        "workerIndex", "parallelIndex", "status", "duration", "errors", "stdout", "stderr",
        "retry", "startTime", "annotations", "attachments",
    ], ["error", "errorLocation"]);
    if (fields.status !== "passed" || fields.retry !== 0
        || !Number.isSafeInteger(fields.workerIndex) || fields.workerIndex < 0
        || !Number.isSafeInteger(fields.parallelIndex) || fields.parallelIndex < 0
        || typeof fields.duration !== "number" || !Number.isFinite(fields.duration) || fields.duration < 0
        || typeof fields.startTime !== "string") fail();
    exactArray(fields.errors, 64);
    exactArray(fields.stdout, 1_024);
    exactArray(fields.stderr, 1_024);
    exactArray(fields.annotations, MAX_ANNOTATIONS_PER_TEST);
    exactArray(fields.attachments, 256);
}

function proofIdsFromTest(value, browser, file, title) {
    const fields = ownDataRecord(value, [
        "timeout", "annotations", "expectedStatus", "projectId", "projectName", "results", "status",
    ]);
    if (!Number.isSafeInteger(fields.timeout) || fields.timeout < 0 || fields.timeout > 10 * 60_000
        || fields.expectedStatus !== "passed" || fields.status !== "expected"
        || typeof fields.projectId !== "string" || typeof fields.projectName !== "string") fail();
    const results = exactArray(fields.results, 2, 1);
    resultPassed(results[0]);
    const proofIds = annotationValues(fields.annotations);
    for (const id of proofIds) {
        const owner = OWNER_BY_ID.get(id);
        if (!owner || owner.browser !== browser || owner.file !== `e2e/${file}` || owner.title !== title) fail();
    }
    return proofIds;
}

function proofIdsFromSpec(value, browser, suiteFile) {
    const fields = ownDataRecord(value, ["title", "ok", "tags", "tests", "id", "file", "line", "column"]);
    const title = boundedString(fields.title);
    const file = boundedString(fields.file, 240);
    if (file !== suiteFile || fields.ok !== true || typeof fields.id !== "string"
        || !Number.isSafeInteger(fields.line) || fields.line < 0
        || !Number.isSafeInteger(fields.column) || fields.column < 0) fail();
    exactArray(fields.tags, 64);
    return exactArray(fields.tests, MAX_TESTS_PER_SPEC)
        .flatMap((test) => proofIdsFromTest(test, browser, file, title));
}

function proofIdsFromSuites(value, browser, depth, budget) {
    if (depth > MAX_NESTING_DEPTH) fail();
    const proofIds = [];
    for (const suite of exactArray(value, MAX_REPORT_SUITES)) {
        const fields = ownDataRecord(suite, ["title", "file", "column", "line", "specs"], ["suites"]);
        boundedString(fields.title);
        const file = boundedString(fields.file, 240);
        if (!Number.isSafeInteger(fields.line) || fields.line < 0
            || !Number.isSafeInteger(fields.column) || fields.column < 0) fail();
        const specs = exactArray(fields.specs, MAX_REPORT_SPECS);
        budget.count += specs.length;
        if (budget.count > MAX_REPORT_SPECS) fail();
        for (const spec of specs) proofIds.push(...proofIdsFromSpec(spec, browser, file));
        if (fields.suites !== undefined) {
            proofIds.push(...proofIdsFromSuites(fields.suites, browser, depth + 1, budget));
        }
    }
    return proofIds;
}

function proofIdsFromReport(value, browser) {
    const root = ownDataRecord(reportObject(value), ["config", "suites", "errors", "stats"]);
    ownDataRecord(root.config, ["workers", "projects"], [
        "configFile", "forbidOnly", "fullyParallel", "globalSetup", "globalTeardown", "globalTimeout",
        "grep", "grepInvert", "maxFailures", "metadata", "preserveOutput", "reporter", "reportSlowTests",
        "quiet", "rootDir", "shard", "tags", "updateSnapshots", "updateSourceMethod", "version", "webServer",
    ]);
    for (const project of exactArray(root.config.projects, 64)) {
        const fields = ownDataRecord(project, ["id", "name", "retries"], [
            "metadata", "outputDir", "repeatEach", "testDir", "testIgnore", "testMatch", "timeout",
        ]);
        boundedString(fields.id, 240);
        boundedString(fields.name, 240);
        if (fields.retries !== 0) fail();
    }
    const errors = exactArray(root.errors, 256);
    if (errors.length !== 0) fail();
    const stats = ownDataRecord(root.stats, ["expected", "skipped", "unexpected", "flaky"], ["startTime", "duration"]);
    if (!Number.isSafeInteger(stats.expected) || stats.expected < 1
        || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) fail();
    const proofIds = proofIdsFromSuites(root.suites, browser, 0, { count: 0 });
    const expectedIds = IDS_BY_BROWSER.get(browser);
    if (!expectedIds || proofIds.length < expectedIds.length) fail();
    const seen = new Set(proofIds);
    if (seen.size !== expectedIds.length || expectedIds.some((id) => !seen.has(id))) fail();
    return proofIds;
}

export function deriveBrowserReleaseProofs(input) {
    const fields = ownDataRecord(input, ["chromiumReports", "webkitReports"]);
    const chromiumReports = exactArray(fields.chromiumReports, 10, 10);
    const webkitReports = exactArray(fields.webkitReports, 16);
    if (webkitReports.length < 1) fail();
    for (const report of chromiumReports) proofIdsFromReport(report, "chromium");
    for (const report of webkitReports) proofIdsFromReport(report, "webkit");
    return BROWSER_RELEASE_PROOF_IDS;
}
