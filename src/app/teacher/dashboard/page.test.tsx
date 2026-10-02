// @vitest-environment jsdom
import React, { type ComponentType } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerPlanSnapshot } from "@/app/actions/premiumAccess";
import type { DemoDashboardData } from "@/lib/demoData";
import type { Attempt, Exam } from "@/types/omr";

const controls = vi.hoisted(() => ({
    // These objects must retain their identity across dashboard state updates.
    searchParams: new URLSearchParams("showcase=1"),
    router: { replace: vi.fn() },
    buildDemo: vi.fn(),
    loadExams: vi.fn(),
    loadSummaries: vi.fn(),
    loadAttempts: vi.fn(),
    loadAnalytics: vi.fn(),
    loadRoster: vi.fn(),
    loadAggregate: vi.fn(),
    loadAssignmentCounts: vi.fn(),
    getServerPlan: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => controls.router,
    useSearchParams: () => controls.searchParams,
}));
vi.mock("next/link", () => ({
    default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock("next/dynamic", () => ({
    default: (loader: () => Promise<{ default: ComponentType }>) => React.lazy(loader),
}));
vi.mock("@/components/TeacherHeader", () => ({ default: () => null }));
vi.mock("@/components/BrandLogo", () => ({ default: () => null }));
vi.mock("@/components/NotificationBell", () => ({ default: () => null }));
vi.mock("@/components/TeacherLogoutButton", () => ({ default: () => null }));
vi.mock("@/components/Toast", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/dashboard/MockupOverview", () => ({
    default: ({ exams, attempts }: { exams: Exam[]; attempts: Attempt[] }) => (
        <section aria-label="Showcase overview">
            <span>{exams[0]?.title}</span>
            <span>{attempts.length} showcase attempts</span>
        </section>
    ),
}));
vi.mock("@/components/dashboard/tabs/OverviewTab", () => ({
    default: () => <section aria-label="Canonical overview" />,
}));
vi.mock("@/components/dashboard/tabs/ExamAnalyticsTab", () => ({ default: () => null }));
vi.mock("@/components/dashboard/tabs/StudentAnalyticsTab", () => ({ default: () => null }));
vi.mock("@/lib/demoData", () => ({ buildDemoDashboardData: controls.buildDemo }));
vi.mock("@/lib/teacherExamClient", () => ({ loadTeacherExams: controls.loadExams }));
vi.mock("@/lib/teacherAttemptClient", () => ({
    loadTeacherAttemptSummaries: controls.loadSummaries,
    loadTeacherAttempts: controls.loadAttempts,
    loadTeacherAnalyticsSnapshots: controls.loadAnalytics,
    resolveTeacherAttemptCollectionCompleteness: vi.fn(() => "ready"),
}));
vi.mock("@/lib/teacherRosterClient", () => ({ loadTeacherRosterSnapshot: controls.loadRoster }));
vi.mock("@/lib/teacherAttemptReportingClient", () => ({ loadTeacherAttemptAggregate: controls.loadAggregate }));
vi.mock("@/app/actions/teacherAssignment", () => ({
    loadTeacherIndividualAssignmentTargetCounts: controls.loadAssignmentCounts,
}));
vi.mock("@/app/actions/premiumAccess", () => ({ getServerPlanSnapshot: controls.getServerPlan }));

import TeacherDashboardPage from "./page";
import { MOCKUP_TEACHER_IDENTITY } from "@/lib/mockupAccount";
import { createTeacherSession, TEACHER_SESSION_KEY } from "@/lib/teacherSession";

const SYNTHETIC_TOKEN = `tkn_fixture_${"0".repeat(32)}`;
const SYNTHETIC_ORGANIZATION_ID = `pilot_org_${"1".repeat(24)}`;
const planSnapshot: ServerPlanSnapshot = {
    authenticated: true,
    authoritative: true,
    plan: "academy",
    source: "supabase",
    limits: { exams: 100, students: 100, aiRecognition: 100 },
};
let resolvePlan: (snapshot: ServerPlanSnapshot) => void;

function demoFixture(): DemoDashboardData {
    const timestamp = new Date().toISOString();
    const exam: Exam = {
        id: "fixture-showcase-exam",
        title: "Showcase fixture exam",
        createdAt: timestamp,
        questions: [{ id: 1, number: 1, choices: 5, answer: 1, score: 5 }],
    };
    return {
        exams: [exam],
        attempts: [{
            id: "fixture-showcase-attempt",
            examId: exam.id,
            examTitle: exam.title,
            studentName: "Fixture student",
            studentId: "fixture-student",
            startedAt: timestamp,
            finishedAt: timestamp,
            score: 5,
            totalScore: 5,
            answers: { 1: 1 },
            status: "completed",
        }],
        rosterStudents: [],
        rosterGroups: [],
    };
}

function seedMockupSession() {
    sessionStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify(createTeacherSession(
        SYNTHETIC_TOKEN,
        Date.now(),
        { ...MOCKUP_TEACHER_IDENTITY, sessionAuthority: "mockup" },
    )));
}

function seedCanonicalSession() {
    sessionStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify(createTeacherSession(
        SYNTHETIC_TOKEN,
        Date.now(),
        {
            teacherId: `teacher_${"2".repeat(16)}`,
            organizationId: SYNTHETIC_ORGANIZATION_ID,
            organizationName: "Fixture organization",
            memberRole: "teacher",
            plan: "academy",
            sessionAuthority: "account",
            accountSessionGeneration: 1,
        },
    )));
}

async function flushNativeInitialization() {
    // Keep the actual microtasks and zero-delay timer ordering that exposed the
    // duplicate snapshot. Fake timers are used only for later 30-second events.
    await act(async () => {
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    });
}

async function renderInitialized() {
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<TeacherDashboardPage />); });
    await flushNativeInitialization();
    return view;
}

function expectNoCanonicalRequests() {
    for (const loader of [
        controls.loadExams,
        controls.loadSummaries,
        controls.loadAttempts,
        controls.loadAnalytics,
        controls.loadRoster,
        controls.loadAggregate,
        controls.loadAssignmentCounts,
    ]) expect(loader).not.toHaveBeenCalled();
}

function dispatchRefocusBurst() {
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
}

describe("teacher dashboard showcase initialization", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        window.history.replaceState(null, "", "/teacher/dashboard?showcase=1");
        // Hold only the gate's clock steady during native initialization, so the
        // following timer assertions exercise the exact 30-second boundary.
        vi.spyOn(Date, "now").mockReturnValue(Date.now());
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        seedMockupSession();
        controls.buildDemo.mockImplementation(demoFixture);
        controls.getServerPlan.mockReturnValue(new Promise<ServerPlanSnapshot>(resolve => { resolvePlan = resolve; }));
        const remoteReady = {
            remoteLoaded: true,
            remoteSynced: true,
            meta: { organizationId: SYNTHETIC_ORGANIZATION_ID },
        };
        controls.loadExams.mockResolvedValue({ ...remoteReady, items: demoFixture().exams });
        controls.loadSummaries.mockResolvedValue({ ...remoteReady, items: [] });
        controls.loadAttempts.mockResolvedValue({ ...remoteReady, items: [] });
        controls.loadAnalytics.mockResolvedValue({ status: "loaded", analyticsSnapshots: {}, meta: remoteReady.meta });
        controls.loadRoster.mockResolvedValue({ ...remoteReady, students: [], groups: [] });
        controls.loadAggregate.mockResolvedValue({ status: "service_unavailable" });
        controls.loadAssignmentCounts.mockResolvedValue({ status: "loaded", targetCounts: {}, assignmentModes: {} });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("builds the initial showcase snapshot once after native microtasks and zero-delay timers", async () => {
        await renderInitialized();

        expect(controls.buildDemo).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("region", { name: "Showcase overview" })).toBeInTheDocument();
        expect(screen.getByText("Showcase fixture exam")).toBeInTheDocument();
        expect(screen.getByText("1 showcase attempts")).toBeInTheDocument();
        expectNoCanonicalRequests();
    });

    it("does not rebuild on plan resolution, a same-identity rerender, or omr_plan storage changes", async () => {
        const view = await renderInitialized();
        await act(async () => { resolvePlan(planSnapshot); });
        seedMockupSession();
        view.rerender(<TeacherDashboardPage />);
        fireEvent(window, new StorageEvent("storage", {
            key: "omr_plan",
            newValue: "academy",
            storageArea: localStorage,
        }));
        await flushNativeInitialization();

        expect(controls.getServerPlan).toHaveBeenCalledTimes(1);
        expect(controls.buildDemo).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("region", { name: "Showcase overview" })).toBeInTheDocument();
        expectNoCanonicalRequests();
    });

    it("coalesces focus and visible-event bursts into one trailing refresh at 30 seconds", async () => {
        await renderInitialized();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        dispatchRefocusBurst();
        expect(controls.buildDemo).toHaveBeenCalledTimes(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
        expect(controls.buildDemo).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(controls.buildDemo).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("region", { name: "Showcase overview" })).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(controls.buildDemo).toHaveBeenCalledTimes(2);
        expectNoCanonicalRequests();
    });

    it("does not schedule recurring refreshes without revalidation events", async () => {
        await renderInitialized();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

        expect(controls.buildDemo).toHaveBeenCalledTimes(1);
        expectNoCanonicalRequests();
    });

    it("cancels a pending trailing refresh and removes event listeners on unmount", async () => {
        const view = await renderInitialized();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        dispatchRefocusBurst();
        view.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        dispatchRefocusBurst();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

        expect(controls.buildDemo).toHaveBeenCalledTimes(1);
        expectNoCanonicalRequests();
    });

    it("cancels initialization when unmounted before the account-resolution microtask", async () => {
        const view = render(<TeacherDashboardPage />);
        view.unmount();
        await flushNativeInitialization();

        expect(controls.buildDemo).not.toHaveBeenCalled();
        expectNoCanonicalRequests();
    });

    it("retains the canonical initial loader and explicit refresh for real teachers", async () => {
        seedCanonicalSession();
        await renderInitialized();

        expect(controls.loadExams).toHaveBeenCalledTimes(1);
        expect(controls.loadSummaries).toHaveBeenCalledTimes(1);
        expect(controls.loadRoster).toHaveBeenCalledTimes(1);
        expect(controls.loadAggregate).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("region", { name: "Canonical overview" })).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "동기화 다시 확인" }));
        });
        expect(controls.loadExams).toHaveBeenCalledTimes(2);
        expect(controls.loadSummaries).toHaveBeenCalledTimes(2);
        expect(controls.loadRoster).toHaveBeenCalledTimes(2);
        expect(controls.loadAggregate).toHaveBeenCalledTimes(2);
        expect(controls.buildDemo).not.toHaveBeenCalled();
    });

    it("does not grant showcase data from the URL without a valid teacher session", async () => {
        sessionStorage.clear();
        await renderInitialized();

        expect(screen.getByTestId("canonical-error-no-cache")).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Showcase overview" })).not.toBeInTheDocument();
        expect(controls.buildDemo).not.toHaveBeenCalled();
        expectNoCanonicalRequests();
    });
});
