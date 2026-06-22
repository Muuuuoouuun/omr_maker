import { questionChoiceCount, questionWeight } from "@/types/omr";
import type { Exam, Question } from "@/types/omr";
import { isValidExamPin } from "@/lib/examAccess";

export type ExamValidationSeverity = "error" | "warning";

export interface ExamValidationIssue {
    severity: ExamValidationSeverity;
    code: string;
    message: string;
    questionIds?: number[];
}

export interface ExamValidationInput {
    title: string;
    questions: Question[];
    durationMin?: number | "";
    startAt?: string;
    endAt?: string;
    hasProblemPdf?: boolean;
    accessConfig?: Exam["accessConfig"];
}

export interface ExamValidationSummary {
    isPublishable: boolean;
    errors: ExamValidationIssue[];
    warnings: ExamValidationIssue[];
    totalQuestions: number;
    answeredCount: number;
    totalScore: number;
    taggedCount: number;
    pdfLinkedCount: number;
    pdfRegionCount: number;
}

function parseDateTime(value?: string): number | null {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
}

function issue(severity: ExamValidationSeverity, code: string, message: string, questionIds?: number[]): ExamValidationIssue {
    return { severity, code, message, questionIds };
}

export function validateExamDraft(input: ExamValidationInput): ExamValidationSummary {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const totalQuestions = questions.length;
    const errors: ExamValidationIssue[] = [];
    const warnings: ExamValidationIssue[] = [];
    const title = input.title.trim();

    if (title.length < 2) {
        errors.push(issue("error", "title_required", "시험 제목은 2자 이상 입력해야 합니다."));
    }

    if (totalQuestions === 0) {
        errors.push(issue("error", "questions_required", "문항이 1개 이상 필요합니다."));
    }

    const duplicateIds = questions
        .map(question => question.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
        errors.push(issue("error", "duplicate_question_ids", "문항 ID가 중복되었습니다. 문항 수를 다시 조정해 주세요.", duplicateIds));
    }

    const invalidNumberIds = questions
        .filter(question => !Number.isInteger(question.number) || question.number <= 0)
        .map(question => question.id);
    if (invalidNumberIds.length > 0) {
        errors.push(issue("error", "invalid_question_numbers", "문항 번호는 1 이상의 정수여야 합니다.", invalidNumberIds));
    }

    const duplicateNumbers = questions
        .map(question => question.number)
        .filter((number, index, numbers) => numbers.indexOf(number) !== index);
    if (duplicateNumbers.length > 0) {
        const duplicateNumberIds = questions
            .filter(question => duplicateNumbers.includes(question.number))
            .map(question => question.id);
        errors.push(issue("error", "duplicate_question_numbers", "문항 번호가 중복되었습니다. OMR 답안 매핑을 위해 번호를 고유하게 조정해 주세요.", duplicateNumberIds));
    }

    const missingAnswerIds = questions
        .filter(question => question.answer === undefined || question.answer === null || question.answer === 0)
        .map(question => question.id);
    if (missingAnswerIds.length > 0) {
        errors.push(issue("error", "missing_answers", `정답이 없는 문항이 ${missingAnswerIds.length}개 있습니다.`, missingAnswerIds));
    }

    const outOfRangeAnswerIds = questions
        .filter(question => {
            if (question.answer === undefined || question.answer === null) return false;
            return question.answer < 1 || question.answer > questionChoiceCount(question);
        })
        .map(question => question.id);
    if (outOfRangeAnswerIds.length > 0) {
        errors.push(issue("error", "answer_out_of_range", "선택지 수보다 큰 정답이 지정된 문항이 있습니다.", outOfRangeAnswerIds));
    }

    const invalidScoreIds = questions
        .filter(question => question.score !== undefined && (!Number.isFinite(question.score) || question.score <= 0))
        .map(question => question.id);
    if (invalidScoreIds.length > 0) {
        errors.push(issue("error", "invalid_scores", "배점은 0보다 큰 숫자여야 합니다.", invalidScoreIds));
    }

    if (input.durationMin !== "" && input.durationMin !== undefined) {
        if (!Number.isFinite(input.durationMin) || input.durationMin <= 0) {
            errors.push(issue("error", "invalid_duration", "시험 시간은 1분 이상이어야 합니다."));
        }
    }

    const startTime = parseDateTime(input.startAt);
    const endTime = parseDateTime(input.endAt);
    if (input.startAt && startTime === null) {
        errors.push(issue("error", "invalid_start_at", "시작 시각 형식이 올바르지 않습니다."));
    }
    if (input.endAt && endTime === null) {
        errors.push(issue("error", "invalid_end_at", "종료 시각 형식이 올바르지 않습니다."));
    }
    if (startTime !== null && endTime !== null && endTime <= startTime) {
        errors.push(issue("error", "invalid_schedule_order", "종료 시각은 시작 시각보다 뒤여야 합니다."));
    }

    if (input.accessConfig?.type === "group" && (!input.accessConfig.groupIds || input.accessConfig.groupIds.length === 0)) {
        errors.push(issue("error", "group_required", "그룹 배포는 대상 그룹을 1개 이상 선택해야 합니다."));
    }
    if (input.accessConfig?.pin && !isValidExamPin(input.accessConfig.pin)) {
        errors.push(issue("error", "invalid_pin", "PIN은 4~6자리 숫자여야 합니다."));
    }

    const answeredCount = totalQuestions - missingAnswerIds.length;
    const taggedCount = questions.filter(question => question.tags?.concept || question.label).length;
    const pdfLinkedQuestions = questions.filter(question => question.pdfLocation || question.pdfRegion);
    const pdfLinkedCount = pdfLinkedQuestions.length;
    const pdfRegionQuestions = questions.filter(question => question.pdfRegion);
    const pdfRegionCount = pdfRegionQuestions.length;
    const totalScore = Math.round(
        questions.reduce((sum, question) => sum + questionWeight(question, totalQuestions), 0) * 100
    ) / 100;

    if (!input.hasProblemPdf) {
        warnings.push(issue("warning", "problem_pdf_missing", "문제지 PDF가 없으면 학생 화면에서 별도 파일 업로드가 필요합니다."));
    }
    if (taggedCount < totalQuestions) {
        warnings.push(issue(
            "warning",
            "metadata_incomplete",
            `개념/라벨이 없는 문항이 ${totalQuestions - taggedCount}개 있습니다.`,
            questions
                .filter(question => !(question.tags?.concept || question.label))
                .map(question => question.id)
        ));
    }
    if (input.hasProblemPdf && pdfLinkedCount < totalQuestions) {
        warnings.push(issue(
            "warning",
            "pdf_locations_incomplete",
            `PDF 위치가 연결되지 않은 문항이 ${totalQuestions - pdfLinkedCount}개 있습니다.`,
            questions
                .filter(question => !(question.pdfLocation || question.pdfRegion))
                .map(question => question.id)
        ));
    }
    if (input.hasProblemPdf && pdfLinkedCount > 0 && pdfRegionCount < totalQuestions) {
        warnings.push(issue(
            "warning",
            "pdf_regions_incomplete",
            `문항 영역이 정밀 연결되지 않은 문항이 ${totalQuestions - pdfRegionCount}개 있습니다. 필기 수집/문항별 분석 정확도를 위해 자동 매칭을 권장합니다.`,
            questions
                .filter(question => !question.pdfRegion)
                .map(question => question.id)
        ));
    }
    if (totalQuestions > 0 && totalScore <= 0) {
        warnings.push(issue("warning", "score_total_zero", "총점이 0점입니다. 배점을 확인해 주세요."));
    }

    return {
        isPublishable: errors.length === 0,
        errors,
        warnings,
        totalQuestions,
        answeredCount,
        totalScore,
        taggedCount,
        pdfLinkedCount,
        pdfRegionCount,
    };
}
