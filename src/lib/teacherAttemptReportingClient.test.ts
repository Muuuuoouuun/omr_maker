import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
    getAggregate: vi.fn(),
    getExportDataset: vi.fn(),
}));

vi.mock("@/app/actions/teacherAttempts", () => ({
    getTeacherCanonicalAttemptAggregate: actions.getAggregate,
    getTeacherCanonicalAttemptExportDataset: actions.getExportDataset,
}));

import {
    loadTeacherAttemptAggregate,
    loadTeacherAttemptExportDataset,
} from "./teacherAttemptReportingClient";

const aggregate = {
    totalAttemptCount: 4,
    completedAttemptCount: 3,
    inProgressAttemptCount: 1,
    baseAttemptCount: 4,
    completedBaseAttemptCount: 3,
    distinctStudentCount: 3,
    completedBaseScorePercentSum: 240,
    averageScorePercent: 80,
    periodAttemptCount: 2,
    periodHandwritingArchiveCount: 1,
    periodHandwritingQuestionCount: 2,
    periodHandwritingStrokeCount: 90,
    snapshotAt: "2026-08-07T01:00:00.000Z",
};

function row(id: string, finishedAt: string) {
    return {
        attemptId: id,
        examId: "exam-1",
        studentScopeHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "completed" as const,
        scorePercent: 80,
        isRetake: false,
        handwritingArchived: false,
        handwritingQuestionCount: 0,
        handwritingStrokeCount: 0,
        startedAt: "2026-08-07T00:00:00.000Z",
        finishedAt,
    };
}

describe("teacher attempt reporting client", () => {
    beforeEach(() => {
        actions.getAggregate.mockReset();
        actions.getExportDataset.mockReset();
    });

    it("loads the exact aggregate independently of the recent attempt list", async () => {
        actions.getAggregate.mockResolvedValue({ status: "loaded", aggregate });
        await expect(loadTeacherAttemptAggregate({ examId: "exam-1" })).resolves.toEqual({
            status: "loaded",
            aggregate,
        });
        expect(actions.getAggregate).toHaveBeenCalledWith({ examId: "exam-1" });
    });

    it("loads one atomic aggregate-plus-row snapshot", async () => {
        const rows = [
            row("attempt-c", "2026-08-07T00:30:00.000Z"),
            row("attempt-b", "2026-08-07T00:20:00.000Z"),
            row("attempt-a", "2026-08-07T00:10:00.000Z"),
        ];
        actions.getExportDataset.mockResolvedValue({ status: "loaded", aggregate, rows });

        await expect(loadTeacherAttemptExportDataset({ examId: "exam-1", pageSize: 2 })).resolves.toEqual({
            status: "loaded",
            aggregate,
            rows,
        });
        expect(actions.getExportDataset).toHaveBeenCalledTimes(1);
        expect(actions.getExportDataset).toHaveBeenCalledWith({
            examId: "exam-1",
            limit: 5_000,
        });
    });

    it("fails closed instead of exporting a partial or unexpectedly large data set", async () => {
        actions.getExportDataset.mockResolvedValue({ status: "capacity_exceeded" });
        await expect(loadTeacherAttemptExportDataset()).resolves.toEqual({
            status: "capacity_exceeded",
            error: "Attempt export exceeds the 5000-row operational boundary",
        });
        actions.getExportDataset.mockResolvedValue({
            status: "service_unavailable",
            error: "Invalid canonical attempt export",
        });
        await expect(loadTeacherAttemptExportDataset()).resolves.toEqual({
            status: "service_unavailable",
            error: "Invalid canonical attempt export",
        });
    });
});
