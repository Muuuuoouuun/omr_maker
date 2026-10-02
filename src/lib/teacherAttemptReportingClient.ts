import {
    getTeacherCanonicalAttemptAggregate,
    getTeacherCanonicalAttemptExportDataset,
} from "@/app/actions/teacherAttempts";
import {
    TEACHER_ATTEMPT_EXPORT_MAX_PAGE_SIZE,
    type TeacherAttemptAggregate,
    type TeacherAttemptAggregateInput,
    type TeacherAttemptExportRow,
} from "@/lib/teacherAttemptReportingGateway";

// Initial-operations boundary: one same-origin action/RPC returns a bounded,
// internally consistent dataset with a low-single-digit-MiB browser projection.
export const TEACHER_ATTEMPT_EXPORT_MAX_ROWS = 5_000;

export type TeacherAttemptAggregateLoadResult =
    | { status: "loaded"; aggregate: TeacherAttemptAggregate }
    | { status: "forbidden" | "local_only" | "unauthorized" | "invalid_request" | "service_unavailable"; error?: string };

export interface TeacherAttemptExportDatasetInput extends TeacherAttemptAggregateInput {
    pageSize?: number;
}

export type TeacherAttemptExportDatasetResult =
    | { status: "loaded"; aggregate: TeacherAttemptAggregate; rows: TeacherAttemptExportRow[] }
    | { status: "forbidden" | "local_only" | "unauthorized" | "invalid_request" | "service_unavailable" | "capacity_exceeded"; error?: string };

export async function loadTeacherAttemptAggregate(
    input: TeacherAttemptAggregateInput = {},
): Promise<TeacherAttemptAggregateLoadResult> {
    return getTeacherCanonicalAttemptAggregate(input);
}

export async function loadTeacherAttemptExportDataset(
    input: TeacherAttemptExportDatasetInput = {},
): Promise<TeacherAttemptExportDatasetResult> {
    const pageSize = input.pageSize ?? TEACHER_ATTEMPT_EXPORT_MAX_PAGE_SIZE;
    if (
        !Number.isSafeInteger(pageSize)
        || pageSize < 1
        || pageSize > TEACHER_ATTEMPT_EXPORT_MAX_PAGE_SIZE
    ) return { status: "invalid_request" };

    void pageSize; // compatibility-only input; the atomic server export owns paging.
    const result = await getTeacherCanonicalAttemptExportDataset({
        ...(input.examId ? { examId: input.examId } : {}),
        limit: TEACHER_ATTEMPT_EXPORT_MAX_ROWS,
    });
    if (result.status === "capacity_exceeded") return {
        status: "capacity_exceeded",
        error: `Attempt export exceeds the ${TEACHER_ATTEMPT_EXPORT_MAX_ROWS}-row operational boundary`,
    };
    return result;
}
