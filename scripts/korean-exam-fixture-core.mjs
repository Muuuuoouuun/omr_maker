export const KOREAN_EXAM_FIXTURE_OWNER = "korean-exam-sample-v1";
export const SHARED_ORGANIZATION_ID = "teacher_sharedqa";
export const SHARED_CLASS_ID = "teacher_sharedqa_test_class";
export const SHARED_STUDENT_IDS = Object.freeze([
    "teacher_sharedqa_student1",
    "teacher_sharedqa_student2",
    "teacher_sharedqa_student3",
]);
export const NORMALIZED_SOURCE_PAGE_INDEXES = Object.freeze([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19,
]);

const OUTPUT_DIRECTORY = "output/pdf";
const REMOTE_BUCKET = "omr-private-assets";
const CREATED_BY_USER_ID = "teacher_fixture_korean_exam";
const SAMPLE_HANDWRITING_DRAWINGS = Object.freeze({
    1: ["M 120 180 L 210 180 L 210 260", "M 130 300 L 250 300"],
    5: ["M 80 420 L 250 420", "M 160 360 L 160 500"],
    13: ["M 100 200 L 260 200", "M 100 250 L 220 310"],
});

const EXAM_DEFINITIONS = Object.freeze([
    {
        id: "fixture-korean-2025-csat-media",
        title: "[샘플] 2025학년도 수능 국어 언어와 매체",
        sourcePath: "/Users/bigmac_moon/Library/CloudStorage/GoogleDrive-seoulmentoss@gmail.com/내 드라이브/ai-proj/문제/수업 자료 샘플/고3 시험지/국어영역_문제지_홀수형_2025학년도.pdf",
        outputName: "2025학년도-수능-국어-언어와매체-홀수형.pdf",
        answerSourceUrl: "https://wdown.ebsi.co.kr/W61001/01exam/20241114/go3/korB_1_hsj_XE2T11IT.pdf",
        answers: [3, 4, 5, 4, 5, 3, 2, 1, 2, 3, 1, 5, 3, 1, 2, 2, 3, 2, 4, 1, 4, 4, 5, 2, 2, 1, 1, 4, 3, 5, 4, 3, 5, 2, 5, 4, 3, 1, 2, 4, 3, 5, 2, 1, 3],
        threePointQuestions: [3, 8, 13, 16, 21, 25, 31, 34, 36, 45],
    },
    {
        id: "fixture-korean-2026-september-media",
        title: "[샘플] 2026학년도 9월 모평 국어 언어와 매체",
        sourcePath: "/Users/bigmac_moon/Library/CloudStorage/GoogleDrive-seoulmentoss@gmail.com/내 드라이브/ai-proj/문제/수업 자료 샘플/고3 시험지/26학년도 9월 모평/국어.pdf",
        outputName: "2026학년도-9월-모평-국어-언어와매체.pdf",
        answerSourceUrl: "https://wdown.ebsi.co.kr/W61001/01exam/20250903/go3/korB_1_hsj_SVCWW4XL_1.pdf",
        answers: [2, 5, 3, 2, 2, 5, 5, 1, 1, 5, 4, 4, 3, 3, 3, 5, 5, 5, 1, 2, 5, 4, 3, 5, 3, 4, 2, 1, 2, 1, 3, 4, 2, 3, 1, 3, 5, 4, 5, 4, 3, 5, 3, 4, 2],
        threePointQuestions: [3, 8, 12, 17, 21, 24, 30, 34, 38, 42],
    },
    {
        id: "fixture-korean-2026-csat-media",
        title: "[샘플] 2026학년도 수능 국어 언어와 매체",
        sourcePath: "/Users/bigmac_moon/Library/CloudStorage/GoogleDrive-seoulmentoss@gmail.com/내 드라이브/ai-proj/문제/수업 자료 샘플/26학년도 수능/25수능 국어.pdf",
        outputName: "2026학년도-수능-국어-언어와매체-홀수형.pdf",
        answerSourceUrl: "https://wdown.ebsi.co.kr/W61001/01exam/20251113/go3/live_main_answer_1_kor_8ZE3E1XR.pdf",
        answers: [3, 5, 4, 1, 4, 2, 5, 3, 5, 5, 3, 1, 1, 5, 1, 2, 3, 2, 4, 3, 2, 5, 1, 4, 4, 2, 5, 5, 1, 3, 2, 4, 1, 3, 3, 2, 4, 4, 1, 2, 4, 5, 2, 4, 3],
        threePointQuestions: [3, 8, 12, 17, 21, 23, 30, 34, 36, 42],
    },
]);

function canonicalQuestionId(examId, questionId) {
    return `${examId}:${questionId}`;
}

function problemAssetId(examId) {
    return `fixture-asset-${examId}-problem`;
}

function problemObjectPath(examId) {
    const assetId = problemAssetId(examId);
    return `organizations/${SHARED_ORGANIZATION_ID}/exams/${examId}/problem/${assetId}.pdf`;
}

function handwritingAssetId(attemptId) {
    return `fixture-asset-${attemptId}-handwriting`;
}

function handwritingObjectPath(attemptId) {
    const assetId = handwritingAssetId(attemptId);
    return `organizations/${SHARED_ORGANIZATION_ID}/attempts/${attemptId}/handwriting/${assetId}.json`;
}

function questionTags(questionNumber, definition) {
    const media = questionNumber >= 35;
    return {
        subject: "국어",
        unit: media ? "언어와 매체" : "공통",
        concept: media ? "언어와 매체" : "독서·문학",
        skill: "대학수학능력시험형 문항 해결",
        difficulty: definition.threePointQuestions.includes(questionNumber) ? "hard" : "medium",
        cognitiveLevel: definition.threePointQuestions.includes(questionNumber) ? "reasoning" : "application",
        source: definition.title.replace("[샘플] ", ""),
        expectedTimeSec: definition.threePointQuestions.includes(questionNumber) ? 100 : 75,
        mistakeTypes: media ? ["개념 적용"] : ["근거 확인"],
        prerequisites: media ? ["언어와 매체 개념"] : ["지문 독해"],
    };
}

function buildQuestions(definition) {
    return definition.answers.map((answer, index) => {
        const number = index + 1;
        return {
            id: number,
            number,
            label: number >= 35 ? "언어와 매체" : "공통",
            score: definition.threePointQuestions.includes(number) ? 3 : 2,
            answer,
            choices: 5,
            tags: questionTags(number, definition),
        };
    });
}

function remoteRef({ id, kind, examId, attemptId, name, now }) {
    return {
        store: "remote",
        key: id,
        organizationId: SHARED_ORGANIZATION_ID,
        kind,
        ...(examId ? { examId } : {}),
        ...(attemptId ? { attemptId } : {}),
        name,
        mimeType: kind === "attempt_handwriting" ? "application/json" : "application/pdf",
        updatedAt: now,
    };
}

function buildExam(definition, now) {
    const assetId = problemAssetId(definition.id);
    return {
        id: definition.id,
        title: definition.title,
        organizationId: SHARED_ORGANIZATION_ID,
        classId: SHARED_CLASS_ID,
        createdByUserId: CREATED_BY_USER_ID,
        questions: buildQuestions(definition),
        createdAt: now,
        updatedAt: now,
        durationMin: 80,
        archived: false,
        pdfDataRef: remoteRef({
            id: assetId,
            kind: "problem_pdf",
            examId: definition.id,
            name: definition.outputName,
            now,
        }),
        accessConfig: { type: "group", groupIds: [SHARED_CLASS_ID] },
        fixtureOwner: KOREAN_EXAM_FIXTURE_OWNER,
        sourceProvenance: {
            answerSourceUrl: definition.answerSourceUrl,
            sourceFileName: definition.sourcePath.split("/").at(-1),
            selectedSourcePages: "1-12,17-20",
        },
    };
}

function examToRow(exam) {
    return {
        id: exam.id,
        organization_id: exam.organizationId,
        class_id: exam.classId,
        title: exam.title,
        payload: exam,
        created_by_user_id: exam.createdByUserId,
        created_at: exam.createdAt,
        updated_at: exam.updatedAt,
        archived: false,
    };
}

function examQuestionToRow(exam, question, now) {
    const tags = question.tags;
    const id = canonicalQuestionId(exam.id, question.id);
    return {
        id,
        organization_id: exam.organizationId,
        class_id: exam.classId,
        exam_id: exam.id,
        question_id: question.id,
        question_number: question.number,
        canonical_question_id: id,
        label: question.label,
        subject: tags.subject,
        unit: tags.unit,
        concept: tags.concept,
        skill: tags.skill,
        source: tags.source,
        difficulty: tags.difficulty,
        cognitive_level: tags.cognitiveLevel,
        mistake_types: tags.mistakeTypes,
        prerequisites: tags.prerequisites,
        expected_time_sec: tags.expectedTimeSec,
        choices: question.choices,
        correct_answer: question.answer,
        score: question.score,
        pdf_page: null,
        pdf_location: null,
        pdf_region: null,
        has_pdf_region: false,
        asset_status: "metadata_only",
        image_asset_ref: null,
        payload: question,
        updated_at: now,
    };
}

function wrongChoice(answer) {
    return answer === 5 ? 1 : answer + 1;
}

function buildAttempt({
    id,
    exam,
    studentNumber,
    wrongQuestionIds,
    unansweredQuestionIds = [],
    startedAt,
    finishedAt,
    retake,
    handwriting = false,
}) {
    const studentProfileId = SHARED_STUDENT_IDS[studentNumber - 1];
    const includedQuestions = retake
        ? exam.questions.filter(question => retake.questionIds.includes(question.id))
        : exam.questions;
    const wrong = new Set(wrongQuestionIds);
    const unanswered = new Set(unansweredQuestionIds);
    const answers = {};

    for (const question of includedQuestions) {
        if (unanswered.has(question.id)) continue;
        answers[question.id] = wrong.has(question.id) ? wrongChoice(question.answer) : question.answer;
    }

    const resultBase = {
        schemaVersion: 1,
        attemptId: id,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: SHARED_ORGANIZATION_ID,
        classId: SHARED_CLASS_ID,
        studentProfileId,
        studentName: `학생 ${studentNumber}`,
        studentId: studentProfileId,
        groupId: SHARED_CLASS_ID,
        groupName: "테스트반",
        regionName: "서울",
        identityType: "temporary",
        finishedAt,
    };
    const questionResults = includedQuestions.map(question => {
        const selectedAnswer = answers[question.id];
        const status = selectedAnswer === undefined
            ? "unanswered"
            : selectedAnswer === question.answer
                ? "correct"
                : "wrong";
        const drawingQuestion = handwriting && [3, 8, 13, 25, 36, 45].includes(question.id);
        return {
            ...resultBase,
            questionId: question.id,
            questionNumber: question.number,
            canonicalQuestionId: canonicalQuestionId(exam.id, question.id),
            label: question.label,
            score: question.score,
            earnedScore: status === "correct" ? question.score : 0,
            ...(selectedAnswer === undefined ? {} : { selectedAnswer }),
            correctAnswer: question.answer,
            status,
            isCorrect: status === "correct",
            isWrong: status === "wrong",
            isUnanswered: status === "unanswered",
            ...question.tags,
            timeSec: question.tags.expectedTimeSec + (question.id % 5) * 3,
            visitCount: drawingQuestion ? 2 : 1,
            revisitCount: drawingQuestion ? 1 : 0,
            answerChangeCount: wrong.has(question.id) ? 1 : 0,
            handwritingStrokeCount: drawingQuestion ? 2 : 0,
            ...(retake ? {
                retakeSourceAttemptId: retake.sourceAttemptId,
                retakeMode: retake.mode,
            } : {}),
            answeredAt: finishedAt,
        };
    });
    const score = questionResults.reduce((total, result) => total + result.earnedScore, 0);
    const totalScore = questionResults.reduce((total, result) => total + result.score, 0);
    const handwritingRef = handwriting
        ? remoteRef({
            id: handwritingAssetId(id),
            kind: "attempt_handwriting",
            attemptId: id,
            name: `${id}-handwriting.json`,
            now: finishedAt,
        })
        : undefined;

    return {
        id,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: SHARED_ORGANIZATION_ID,
        classId: SHARED_CLASS_ID,
        studentProfileId,
        studentName: `학생 ${studentNumber}`,
        studentId: studentProfileId,
        groupId: SHARED_CLASS_ID,
        groupName: "테스트반",
        regionName: "서울",
        identityType: "temporary",
        startedAt,
        finishedAt,
        score,
        totalScore,
        answers,
        status: "completed",
        questionResults,
        questionTimings: questionResults.map(result => ({
            questionId: result.questionId,
            questionNumber: result.questionNumber,
            totalTimeSec: result.timeSec,
            visitCount: result.visitCount,
            revisitCount: result.revisitCount,
            answerChangeCount: result.answerChangeCount,
        })),
        ...(handwriting ? {
            drawings: SAMPLE_HANDWRITING_DRAWINGS,
            drawingsRef: handwritingRef,
            handwriting: {
                schemaVersion: 1,
                status: "saved",
                strokesRef: handwritingRef,
                plan: "academy",
                summary: { pageCount: 3, strokeCount: 6, questionCount: 6 },
                questions: {
                    3: { questionId: 3, questionNumber: 3, page: 1, strokeCount: 2 },
                    13: { questionId: 13, questionNumber: 13, page: 5, strokeCount: 2 },
                    36: { questionId: 36, questionNumber: 36, page: 13, strokeCount: 2 },
                },
            },
            handwritingArchived: true,
            handwritingPlan: "academy",
            drawingPageCount: 3,
            drawingStrokeCount: 6,
            questionDrawings: [
                { questionId: 3, questionNumber: 3, page: 1, strokeCount: 2 },
                { questionId: 13, questionNumber: 13, page: 5, strokeCount: 2 },
                { questionId: 36, questionNumber: 36, page: 13, strokeCount: 2 },
            ],
        } : {}),
        ...(retake ? { retake } : {}),
        fixtureOwner: KOREAN_EXAM_FIXTURE_OWNER,
    };
}

function attemptToRow(attempt) {
    return {
        id: attempt.id,
        ticket_id: null,
        organization_id: attempt.organizationId,
        class_id: attempt.classId,
        assignment_id: null,
        student_profile_id: attempt.studentProfileId,
        exam_id: attempt.examId,
        student_name: attempt.studentName,
        student_id: attempt.studentId,
        group_id: attempt.groupId,
        group_name: attempt.groupName,
        region_id: null,
        region_name: attempt.regionName,
        identity_type: attempt.identityType,
        status: attempt.status,
        score: attempt.score,
        total_score: attempt.totalScore,
        score_percent: attempt.totalScore > 0 ? Math.round((attempt.score / attempt.totalScore) * 100) : 0,
        retake_source_attempt_id: attempt.retake?.sourceAttemptId ?? null,
        retake_mode: attempt.retake?.mode ?? null,
        retake_question_ids: attempt.retake?.questionIds ?? [],
        merged_from_guest_id: null,
        merged_at: null,
        payload: attempt,
        started_at: attempt.startedAt,
        finished_at: attempt.finishedAt,
    };
}

function questionResultToRow(result, now) {
    return {
        id: `${result.attemptId}:${result.questionId}`,
        organization_id: result.organizationId,
        class_id: result.classId,
        assignment_id: null,
        student_profile_id: result.studentProfileId,
        attempt_id: result.attemptId,
        exam_id: result.examId,
        student_name: result.studentName,
        student_id: result.studentId,
        group_id: result.groupId,
        group_name: result.groupName,
        region_id: null,
        region_name: result.regionName,
        identity_type: result.identityType,
        question_id: result.questionId,
        question_number: result.questionNumber,
        canonical_question_id: result.canonicalQuestionId,
        label: result.label,
        subject: result.subject,
        unit: result.unit,
        concept: result.concept,
        skill: result.skill,
        source: result.source,
        difficulty: result.difficulty,
        cognitive_level: result.cognitiveLevel,
        mistake_types: result.mistakeTypes,
        prerequisites: result.prerequisites,
        expected_time_sec: result.expectedTimeSec,
        selected_answer: result.selectedAnswer ?? null,
        correct_answer: result.correctAnswer,
        status: result.status,
        is_correct: result.isCorrect,
        is_wrong: result.isWrong,
        is_unanswered: result.isUnanswered,
        score: result.score,
        earned_score: result.earnedScore,
        pdf_page: null,
        pdf_location: null,
        pdf_region: null,
        time_sec: result.timeSec,
        visit_count: result.visitCount,
        revisit_count: result.revisitCount,
        answer_change_count: result.answerChangeCount,
        handwriting_stroke_count: result.handwritingStrokeCount,
        handwriting_page: null,
        retake_source_attempt_id: result.retakeSourceAttemptId ?? null,
        retake_mode: result.retakeMode ?? null,
        answered_at: result.answeredAt,
        finished_at: result.finishedAt,
        payload: result,
        created_at: result.finishedAt,
        updated_at: now,
    };
}

function buildFeedback(original, now) {
    const wrongResults = original.questionResults.filter(result => result.status !== "correct");
    return {
        id: "fixture-feedback-student1-original",
        attemptId: original.id,
        examId: original.examId,
        organizationId: SHARED_ORGANIZATION_ID,
        studentProfileId: original.studentProfileId,
        teacherUserId: CREATED_BY_USER_ID,
        status: "returned",
        summary: "틀린 문항은 지문의 근거와 개념을 다시 표시했습니다. 재시험에서 근거를 확인하고 답을 선택하세요.",
        questionComments: wrongResults.slice(0, 4).map(result => ({
            id: `fixture-comment-${result.questionId}`,
            questionId: result.questionId,
            questionNumber: result.questionNumber,
            body: result.status === "unanswered"
                ? "미응답 문항입니다. 제한 시간 안에 반드시 답을 선택하는 연습을 해 보세요."
                : "선택지 판단의 근거가 되는 문장을 지문에서 다시 확인하세요.",
            visibility: "student_visible",
        })),
        downloadPolicy: {
            allowStudentDownload: true,
            allowAnnotatedPdfDownload: false,
            watermarkStudentName: true,
        },
        delivery: {
            notificationStatus: "queued",
            notificationChannel: "in_app",
            notifiedAt: now,
            firstOpenedAt: now,
            lastOpenedAt: now,
            openCount: 1,
        },
        returnedAt: now,
        createdAt: now,
        updatedAt: now,
        fixtureOwner: KOREAN_EXAM_FIXTURE_OWNER,
    };
}

function feedbackToRow(feedback) {
    return {
        id: feedback.id,
        organization_id: feedback.organizationId,
        attempt_id: feedback.attemptId,
        exam_id: feedback.examId,
        student_profile_id: feedback.studentProfileId,
        teacher_user_id: feedback.teacherUserId,
        status: feedback.status,
        summary: feedback.summary,
        question_comments: feedback.questionComments,
        markup: null,
        markup_drawings: null,
        download_policy: feedback.downloadPolicy,
        notification_status: feedback.delivery.notificationStatus,
        notification_channel: feedback.delivery.notificationChannel,
        notified_at: feedback.delivery.notifiedAt,
        first_opened_at: feedback.delivery.firstOpenedAt,
        last_opened_at: feedback.delivery.lastOpenedAt,
        open_count: feedback.delivery.openCount,
        returned_at: feedback.returnedAt,
        payload: feedback,
        created_at: feedback.createdAt,
        updated_at: feedback.updatedAt,
    };
}

function artifactFor(definition) {
    return {
        examId: definition.id,
        assetId: problemAssetId(definition.id),
        kind: "problem_pdf",
        sourcePath: definition.sourcePath,
        outputPath: `${OUTPUT_DIRECTORY}/${definition.outputName}`,
        outputName: definition.outputName,
        sourcePageIndexes: [...NORMALIZED_SOURCE_PAGE_INDEXES],
        outputPageCount: NORMALIZED_SOURCE_PAGE_INDEXES.length,
        normalizedToSourcePage: Object.fromEntries(NORMALIZED_SOURCE_PAGE_INDEXES.map((page, index) => [index + 1, page + 1])),
        bucket: REMOTE_BUCKET,
        objectPath: problemObjectPath(definition.id),
        answerSourceUrl: definition.answerSourceUrl,
    };
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

export function buildKoreanExamFixture({ now = new Date().toISOString() } = {}) {
    const exams = EXAM_DEFINITIONS.map(definition => buildExam(definition, now));
    const seededExam = exams[0];
    const original = buildAttempt({
        id: "fixture-attempt-student1-original",
        exam: seededExam,
        studentNumber: 1,
        wrongQuestionIds: [3, 8, 13, 16, 21, 36],
        unansweredQuestionIds: [25, 45],
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T01:20:00.000Z",
        handwriting: true,
    });
    const retakeQuestionIds = original.questionResults
        .filter(result => result.status !== "correct")
        .map(result => result.questionId);
    const retake = buildAttempt({
        id: "fixture-attempt-student1-retake",
        exam: seededExam,
        studentNumber: 1,
        wrongQuestionIds: [13, 45],
        startedAt: "2026-07-22T00:00:00.000Z",
        finishedAt: "2026-07-22T00:25:00.000Z",
        retake: {
            sourceAttemptId: original.id,
            questionIds: retakeQuestionIds,
            mode: "wrong",
            labels: ["공통", "언어와 매체"],
            concepts: ["독서·문학", "언어와 매체"],
            createdAt: "2026-07-21T02:00:00.000Z",
        },
    });
    const student2 = buildAttempt({
        id: "fixture-attempt-student2-original",
        exam: seededExam,
        studentNumber: 2,
        wrongQuestionIds: [2, 9, 37],
        startedAt: "2026-07-21T03:00:00.000Z",
        finishedAt: "2026-07-21T04:20:00.000Z",
    });
    const attempts = [original, retake, student2];
    const feedback = [buildFeedback(original, now)];
    const handwritingPayloads = [{
        assetId: handwritingAssetId(original.id),
        attemptId: original.id,
        bucket: REMOTE_BUCKET,
        objectPath: handwritingObjectPath(original.id),
        originalName: `${original.id}-handwriting.json`,
        drawings: SAMPLE_HANDWRITING_DRAWINGS,
    }];

    const fixture = {
        owner: KOREAN_EXAM_FIXTURE_OWNER,
        organizationId: SHARED_ORGANIZATION_ID,
        classId: SHARED_CLASS_ID,
        studentIds: [...SHARED_STUDENT_IDS],
        exams,
        attempts,
        feedback,
        pdfArtifacts: EXAM_DEFINITIONS.map(artifactFor),
        handwritingPayloads,
        examRows: exams.map(examToRow),
        examQuestionRows: exams.flatMap(exam => exam.questions.map(question => examQuestionToRow(exam, question, now))),
        attemptRows: attempts.map(attemptToRow),
        questionResultRows: attempts.flatMap(attempt => attempt.questionResults.map(result => questionResultToRow(result, now))),
        feedbackRows: feedback.map(feedbackToRow),
    };
    validateKoreanExamFixture(fixture);
    return fixture;
}

export function validateKoreanExamFixture(fixture) {
    assert(fixture?.owner === KOREAN_EXAM_FIXTURE_OWNER, "fixture owner mismatch");
    assert(fixture.organizationId === SHARED_ORGANIZATION_ID, "organization mismatch");
    assert(fixture.classId === SHARED_CLASS_ID, "class mismatch");
    assert(Array.isArray(fixture.exams) && fixture.exams.length === 3, "exactly three exams are required");
    const allIds = [];
    for (const exam of fixture.exams) {
        assert(exam.fixtureOwner === KOREAN_EXAM_FIXTURE_OWNER, `${exam.id}: fixture owner missing`);
        assert(exam.questions.length === 45, `${exam.id}: expected 45 questions`);
        assert(exam.accessConfig?.type === "group", `${exam.id}: group access required`);
        assert(exam.accessConfig.groupIds?.length === 1 && exam.accessConfig.groupIds[0] === SHARED_CLASS_ID, `${exam.id}: shared class access required`);
        assert(exam.questions.every(question => Number.isInteger(question.answer) && question.answer >= 1 && question.answer <= 5), `${exam.id}: answer out of range`);
        assert(exam.questions.filter(question => question.score === 3).length === 10, `${exam.id}: expected ten 3-point questions`);
        assert(exam.questions.filter(question => question.score === 2).length === 35, `${exam.id}: expected thirty-five 2-point questions`);
        assert(exam.questions.reduce((total, question) => total + question.score, 0) === 100, `${exam.id}: expected 100 total points`);
        allIds.push(exam.id, ...exam.questions.map(question => canonicalQuestionId(exam.id, question.id)));
    }
    assert(new Set(allIds).size === allIds.length, "duplicate exam or question id");
    assert(fixture.examQuestionRows.length === 135, "expected 135 exam question rows");
    assert(fixture.attempts.length === 3, "expected three attempts");
    assert(fixture.attempts.every(attempt => attempt.fixtureOwner === KOREAN_EXAM_FIXTURE_OWNER), "attempt fixture owner missing");
    const original = fixture.attempts.find(attempt => attempt.id === "fixture-attempt-student1-original");
    const retake = fixture.attempts.find(attempt => attempt.id === "fixture-attempt-student1-retake");
    assert(original && retake, "student 1 lifecycle missing");
    const expectedRetakeIds = original.questionResults.filter(result => result.status !== "correct").map(result => result.questionId);
    assert(JSON.stringify(retake.retake?.questionIds) === JSON.stringify(expectedRetakeIds), "retake questions must match original wrong/unanswered questions");
    assert(retake.retake?.sourceAttemptId === original.id && retake.retake?.mode === "wrong", "invalid retake linkage");
    assert(fixture.feedback.length === 1 && fixture.feedback[0].attemptId === original.id && fixture.feedback[0].status === "returned", "returned feedback missing");
    assert(fixture.pdfArtifacts.length === 3 && fixture.handwritingPayloads.length === 1, "expected four private assets");
    assert(fixture.studentIds[2] === SHARED_STUDENT_IDS[2] && !fixture.attempts.some(attempt => attempt.studentProfileId === SHARED_STUDENT_IDS[2]), "student 3 must remain fresh");
    assert(!fixture.attempts.some(attempt => attempt.examId !== fixture.exams[0].id), "exams 2 and 3 must remain fresh");

    return {
        exams: fixture.exams.length,
        examQuestions: fixture.examQuestionRows.length,
        attempts: fixture.attempts.length,
        questionResults: fixture.questionResultRows.length,
        feedback: fixture.feedback.length,
        assets: fixture.pdfArtifacts.length + fixture.handwritingPayloads.length,
    };
}

export function summarizeKoreanExamFixture(fixture) {
    const counts = validateKoreanExamFixture(fixture);
    return {
        owner: fixture.owner,
        organizationId: fixture.organizationId,
        classId: fixture.classId,
        exams: fixture.exams.map(exam => ({ id: exam.id, title: exam.title, questionCount: exam.questions.length })),
        students: fixture.studentIds.map(studentProfileId => ({
            studentProfileId,
            attemptIds: fixture.attempts.filter(attempt => attempt.studentProfileId === studentProfileId).map(attempt => attempt.id),
        })),
        counts,
        assets: [
            ...fixture.pdfArtifacts.map(artifact => ({ kind: artifact.kind, outputPath: artifact.outputPath })),
            ...fixture.handwritingPayloads.map(asset => ({ kind: "attempt_handwriting", attemptId: asset.attemptId })),
        ],
    };
}
