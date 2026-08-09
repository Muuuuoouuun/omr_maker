// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DistributeModal from "./DistributeModal";

const controls = vi.hoisted(() => ({
    loadRoster: vi.fn(),
    loadAssignment: vi.fn(),
    loadMetadata: vi.fn(),
    rawUrlChange: vi.fn(),
    saveRoster: vi.fn(),
    persistCandidate: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock("qrcode.react", () => ({ QRCodeCanvas: () => <canvas data-testid="qr-code" /> }));
vi.mock("@/hooks/useDialogFocus", () => ({ useDialogFocus: () => ({ current: null }) }));
vi.mock("@/components/Toast", () => ({
    toast: { success: vi.fn(), error: controls.toastError, info: vi.fn() },
}));
vi.mock("@/lib/teacherSession", () => ({
    TEACHER_SESSION_IDENTITY_CHANGED_EVENT: "omr:teacher-session-identity-changed",
    TEACHER_SESSION_KEY: "omr_teacher_session",
    readTeacherSession: () => ({
        organizationId: "default",
        teacherId: "admin",
        accountSessionGeneration: 1,
    }),
}));
vi.mock("@/lib/teacherRosterClient", () => ({
    loadTeacherRosterSnapshot: controls.loadRoster,
    saveTeacherRosterSnapshotIfCurrent: controls.saveRoster,
}));
vi.mock("@/lib/teacherRosterCanonicalCache", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/teacherRosterCanonicalCache")>();
    return {
        ...actual,
        readTeacherRosterDegradedCache: () => ({
            kind: "teacher_roster_degraded",
            staleAt: "2026-08-09T01:02:03.000Z",
            students: [{
                kind: "degraded_roster_student",
                id: "student-1",
                name: "학생",
                email: "student@example.com",
                groupId: "group-1",
                status: "active",
                avgScore: 80,
                examsTaken: 1,
                lastActive: "오늘",
            }],
            groups: [{
                kind: "degraded_roster_group",
                id: "group-1",
                name: "A반",
                status: "active",
                studentCount: 1,
                avgScore: 80,
            }],
            invites: [],
        }),
        persistTeacherRosterCompletionIfCurrent: controls.persistCandidate,
    };
});

const readyRoster = {
    students: [],
    groups: [],
    invites: [],
    remoteLoaded: true,
    remoteSynced: true,
    candidate: {
        snapshot: { students: [], groups: [], invites: [] },
        revision: 1,
        meta: {
            organizationId: "default",
            loadedAt: "2026-08-09T01:03:03.000Z",
            rawCount: 0,
            parsedCount: 0,
        },
    },
    meta: {
        organizationId: "default",
        loadedAt: "2026-08-09T01:03:03.000Z",
        rawCount: 0,
        parsedCount: 0,
    },
};

function renderExistingExam(initialAccessConfig: { type: "group"; groupIds: string[] } | { type: "targeted" }) {
    return render(<DistributeModal
        isOpen
        onClose={vi.fn()}
        onSaveAndShare={vi.fn()}
        onAssignStudents={vi.fn()}
        onClearStudentAssignment={vi.fn()}
        onLoadStudentAssignment={controls.loadAssignment}
        onLoadInviteMetadata={controls.loadMetadata}
        onRevokeInvite={vi.fn()}
        inviteRawUrlState={null}
        onInviteRawUrlStateChange={controls.rawUrlChange}
        retakeAssignmentsEnabled
        initialAccessConfig={initialAccessConfig}
        examId="exam-existing"
        isExistingExam
    />);
}

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    controls.saveRoster.mockResolvedValue({ localSaved: true, remoteSaved: true });
    controls.persistCandidate.mockReturnValue({
        status: "persisted",
        localPersisted: true,
        cacheWritten: true,
    });
    controls.loadRoster
        .mockResolvedValueOnce({
            students: [], groups: [], invites: [],
            remoteLoaded: false, remoteSynced: false, remoteError: "offline",
        })
        .mockResolvedValueOnce(readyRoster);
    controls.loadAssignment.mockResolvedValue({ status: "not_found" });
    controls.loadMetadata.mockResolvedValue({
        status: "found",
        metadata: {
            examId: "exam-existing",
            generation: 2,
            issuedAt: "2026-08-09T01:00:00.000Z",
            expiresAt: "2099-08-09T02:00:00.000Z",
            revokedAt: null,
        },
    });
});

describe("DistributeModal canonical roster recovery", () => {
    it("restarts assignment and invite metadata loads after degraded roster recovery", async () => {
        renderExistingExam({ type: "group", groupIds: ["group-1"] });

        const degraded = await screen.findByTestId("canonical-degraded-cache");
        await waitFor(() => {
            expect(controls.loadAssignment).toHaveBeenCalledTimes(1);
            expect(controls.loadMetadata).toHaveBeenCalledTimes(1);
        });

        fireEvent.click(degraded.querySelector("button")!);

        await waitFor(() => {
            expect(controls.loadAssignment).toHaveBeenCalledTimes(2);
            expect(controls.loadMetadata).toHaveBeenCalledTimes(2);
        });
        expect(await screen.findByTestId("distribution-invite-active_but_raw_unavailable")).toBeVisible();
        expect(screen.queryByText("현재 배포 링크 상태를 확인하고 있습니다.")).not.toBeInTheDocument();
    });

    it("publishes the fresh targeted assignment response after roster recovery", async () => {
        controls.loadAssignment.mockResolvedValue({
            status: "loaded",
            targetStudentIds: ["student-1"],
            mode: "retake",
            revision: 4,
        });
        renderExistingExam({ type: "targeted" });

        const degraded = await screen.findByTestId("canonical-degraded-cache");
        fireEvent.click(degraded.querySelector("button")!);

        await waitFor(() => expect(controls.loadAssignment).toHaveBeenCalledTimes(2));
        expect(screen.getByLabelText("배정 유형")).toHaveValue("retake");
    });

    it("never rehydrates tenant A legacy invites into a tenant B inline save after partial local persistence", async () => {
        const tenantBInvite = { id: "invite-b", email: "b@example.com", sentAt: "오늘", status: "pending" as const };
        const tenantAInvite = { id: "invite-a", email: "a-secret@example.com", sentAt: "어제", status: "pending" as const };
        window.localStorage.setItem("omr_invites", JSON.stringify([tenantAInvite]));
        controls.loadRoster.mockReset().mockResolvedValue({
            ...readyRoster,
            invites: [tenantBInvite],
            candidate: {
                ...readyRoster.candidate,
                snapshot: { ...readyRoster.candidate.snapshot, invites: [tenantBInvite] },
            },
        });
        controls.persistCandidate.mockReturnValue({
            status: "persisted",
            localPersisted: false,
            cacheWritten: true,
        });
        renderExistingExam({ type: "group", groupIds: [] });

        const newGroup = await screen.findByRole("button", { name: /새 반/ });
        await waitFor(() => expect(newGroup).toBeEnabled());
        fireEvent.click(newGroup);
        fireEvent.change(screen.getByLabelText("새 반 이름"), { target: { value: "B반" } });
        fireEvent.click(screen.getByRole("button", { name: "반 만들고 대상으로 선택" }));

        await waitFor(() => expect(controls.saveRoster).toHaveBeenCalled());
        const savedSnapshot = controls.saveRoster.mock.calls[0][1];
        expect(savedSnapshot.invites).toEqual([tenantBInvite]);
        expect(JSON.stringify(savedSnapshot)).not.toContain("a-secret@example.com");
    });

    it("never lets failed inline save N roll back optimistic N+1 or its revision", async () => {
        controls.loadRoster.mockReset().mockResolvedValue(readyRoster);
        let resolveN!: (result: { localSaved: boolean; remoteSaved: boolean; remoteError?: string }) => void;
        let resolveN1!: (result: { localSaved: boolean; remoteSaved: boolean; remoteRevision?: number }) => void;
        controls.saveRoster
            .mockReset()
            .mockReturnValueOnce(new Promise(resolve => { resolveN = resolve; }))
            .mockReturnValueOnce(new Promise(resolve => { resolveN1 = resolve; }))
            .mockResolvedValue({ localSaved: true, remoteSaved: true, remoteRevision: 4 });
        renderExistingExam({ type: "group", groupIds: [] });

        const addGroup = async (name: string) => {
            const newGroup = await screen.findByRole("button", { name: /새 반/ });
            await waitFor(() => expect(newGroup).toBeEnabled());
            fireEvent.click(newGroup);
            fireEvent.change(screen.getByLabelText("새 반 이름"), { target: { value: name } });
            fireEvent.click(screen.getByRole("button", { name: "반 만들고 대상으로 선택" }));
            await screen.findByText(name);
        };

        await addGroup("N반");
        await waitFor(() => expect(controls.saveRoster).toHaveBeenCalledTimes(1));
        await addGroup("N+1반");
        await waitFor(() => expect(controls.saveRoster).toHaveBeenCalledTimes(2));

        resolveN({ localSaved: false, remoteSaved: false, remoteError: "N failed" });
        await Promise.resolve();
        expect(screen.getByText("N반")).toBeVisible();
        expect(screen.getByText("N+1반")).toBeVisible();
        expect(controls.toastError).not.toHaveBeenCalledWith("명단 저장 실패", expect.anything());

        resolveN1({ localSaved: true, remoteSaved: true, remoteRevision: 3 });
        await waitFor(() => expect(screen.getByText("N+1반")).toBeVisible());
        await addGroup("N+2반");
        await waitFor(() => expect(controls.saveRoster).toHaveBeenCalledTimes(3));

        const latestSnapshot = controls.saveRoster.mock.calls[2][1];
        expect(latestSnapshot.groups.map((group: { name: string }) => group.name)).toEqual(["N반", "N+1반", "N+2반"]);
        expect(controls.saveRoster.mock.calls[2][3]).toBe(3);
    });
});
