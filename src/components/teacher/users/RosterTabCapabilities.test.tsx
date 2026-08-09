// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import GroupsTab, { type GroupsTabProps } from "./GroupsTab";
import InvitesTab, { type InvitesTabProps } from "./InvitesTab";

const group = {
    id: "group-a",
    name: "A반",
    region: "서울",
    count: 1,
    avgScore: 87,
    color: "#4f46e5",
};

const student = {
    id: "student-a",
    name: "학생 A",
    email: "student@example.com",
    group: "A반",
    region: "서울",
    avatar: "SA",
    avgScore: 87,
    examsTaken: 2,
    lastActive: "오늘",
    trend: "flat" as const,
    status: "active" as const,
};

const invite = {
    id: "invite-a",
    email: "student@example.com",
    sentAt: "오늘",
    status: "pending" as const,
};

afterEach(cleanup);

describe("read-only roster tab capabilities", () => {
    it("renders group membership without accepting or exposing callbacks", () => {
        render(<GroupsTab
            capability="degraded_read_only"
            displayGroups={[group]}
            displayStudents={[student]}
        />);

        expect(screen.getByRole("heading", { name: "A반" })).toBeVisible();
        expect(screen.getByText("1명 등록 · 서울")).toBeVisible();
        expect(screen.queryAllByRole("button")).toHaveLength(0);
        expect(screen.queryAllByRole("link")).toHaveLength(0);
    });

    it("renders invite identity and status without accepting or exposing callbacks", () => {
        render(<InvitesTab
            capability="degraded_read_only"
            hydrated
            rosterInvites={[invite]}
        />);

        expect(screen.getByText("student@example.com")).toBeVisible();
        expect(screen.getByText("대기 중")).toBeVisible();
        expect(screen.queryAllByRole("button")).toHaveLength(0);
        expect(screen.queryAllByRole("link")).toHaveLength(0);
    });
});

const invalidDegradedGroups = {
    capability: "degraded_read_only" as const,
    displayGroups: [],
    displayStudents: [],
    handleDeleteGroup: () => undefined,
};
// @ts-expect-error degraded group props must not accept mutation callbacks
const _invalidGroupsProps: GroupsTabProps = invalidDegradedGroups;
void _invalidGroupsProps;

const invalidDegradedInvites = {
    capability: "degraded_read_only" as const,
    hydrated: true,
    rosterInvites: [],
    handleCopyInvite: () => undefined,
};
// @ts-expect-error degraded invite props must not accept copy or mutation callbacks
const _invalidInvitesProps: InvitesTabProps = invalidDegradedInvites;
void _invalidInvitesProps;
