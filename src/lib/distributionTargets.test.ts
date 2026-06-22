import { describe, expect, it } from "vitest";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { summarizeDistributionTargets } from "./distributionTargets";

const baseStudent = {
    email: "",
    avatar: "#4f46e5",
    avgScore: 0,
    examsTaken: 0,
    lastActive: "기록 없음",
    trend: "flat" as const,
    status: "active" as const,
};

const groups: RosterGroup[] = [
    { id: "class-a", name: "A반", region: "서울", count: 0, avgScore: 0, color: "#4f46e5" },
    { id: "class-b", name: "B반", region: "부산", count: 0, avgScore: 0, color: "#10b981" },
];

const students: RosterStudent[] = [
    { ...baseStudent, id: "class-a::김학생", name: "김학생", group: "A반", region: "서울" },
    { ...baseStudent, id: "A반::이학생", name: "이학생", group: "A반", region: "서울" },
    { ...baseStudent, id: "class-b::박학생", name: "박학생", group: "B반", region: "부산" },
];

describe("distribution targets", () => {
    it("counts students for selected group ids using group names and scoped legacy ids", () => {
        const summary = summarizeDistributionTargets({
            selectedGroupIds: ["class-a"],
            groups,
            students,
        });

        expect(summary).toMatchObject({
            selectedGroupIds: ["class-a"],
            selectedGroupNames: ["A반 · 서울"],
            targetStudentCount: 2,
            targetStudentIds: ["class-a::김학생", "A반::이학생"],
            missingGroupIds: [],
            hasRoster: true,
        });
    });

    it("reports missing groups and zero roster targets without treating the link as impossible", () => {
        const summary = summarizeDistributionTargets({
            selectedGroupIds: ["class-c"],
            groups,
            students: [],
        });

        expect(summary).toEqual({
            selectedGroupIds: ["class-c"],
            selectedGroupNames: ["class-c"],
            targetStudentCount: 0,
            targetStudentIds: [],
            missingGroupIds: ["class-c"],
            hasRoster: false,
        });
    });

    it("does not include another region's same-name class when a concrete group is selected", () => {
        const summary = summarizeDistributionTargets({
            selectedGroupIds: ["seoul-a"],
            groups: [
                { id: "seoul-a", name: "A반", region: "서울", count: 0, avgScore: 0, color: "#4f46e5" },
                { id: "busan-a", name: "A반", region: "부산", count: 0, avgScore: 0, color: "#10b981" },
            ],
            students: [
                { ...baseStudent, id: "seoul-a::김학생", name: "김학생", group: "A반", region: "서울" },
                { ...baseStudent, id: "busan-a::김학생", name: "김학생", group: "A반", region: "부산" },
            ],
        });

        expect(summary).toMatchObject({
            selectedGroupNames: ["A반 · 서울"],
            targetStudentCount: 1,
            targetStudentIds: ["seoul-a::김학생"],
        });
    });
});
