"use client";

import React from 'react';
import { computeExamTotalScore, DEFAULT_CHOICE_COUNT, normalizeChoiceCount, questionChoiceCount, type Question } from '@/types/omr';
import { splitQuestionsIntoColumns } from '@/lib/pure';

interface OMRPreviewProps {
    title?: string;
    questions?: Question[];
    optionsCount?: number;
    columns?: number;
    selectedQuestionId?: number | null;
    onQuestionClick?: (id: number) => void;
    // New Props
    mode?: 'editor' | 'solve' | 'view';
    showAnswerKey?: boolean;
    userAnswers?: Record<number, number>; // Student marked answers
    onAnswerClick?: (questionId: number, optionIndex: number) => void;
    printVariant?: 'standard' | 'numbersOnly';
}

export default function OMRPreview({
    title = "OMR ANSWER SHEET",
    questions = [],
    optionsCount = DEFAULT_CHOICE_COUNT,
    columns = 2,
    selectedQuestionId = null,
    onQuestionClick,
    mode = 'editor',
    showAnswerKey = mode === 'editor',
    userAnswers = {},
    onAnswerClick,
    printVariant = 'standard'
}: OMRPreviewProps) {
    const isNumbersOnlyPrint = printVariant === 'numbersOnly';

    // Helper to generate dummy questions if empty
    const displayQuestions = questions.length > 0
        ? questions
        : Array.from({ length: 20 }, (_, i) => ({ id: i + 1, number: i + 1 } as Question));

    // Layout Logic
    const columnQuestions = splitQuestionsIntoColumns(displayQuestions, columns || 2);
    const cols = Math.max(columnQuestions.length, 1);
    const effectiveOptionsCount = normalizeChoiceCount(optionsCount);
    const answeredKeyCount = displayQuestions.filter(q => q.answer !== undefined && q.answer !== null).length;
    const pdfLinkedCount = displayQuestions.filter(q => q.pdfLocation || q.pdfRegion).length;
    const totalScore = computeExamTotalScore(displayQuestions);
    const totalScoreLabel = Number.isInteger(totalScore) ? `${totalScore}` : totalScore.toFixed(1);

    const renderQuestion = (q: Question) => {
        const isRowSelected = selectedQuestionId === q.id;

        return (
            <div
                key={q.id}
                className={`omr-row ${isRowSelected ? 'omr-row-selected' : ''}`}
                onClick={() => onQuestionClick && onQuestionClick(q.id)}
                aria-label={`${q.number}번 문항`}
                style={{
                    cursor: onQuestionClick ? 'pointer' : 'default',
                }}
            >
                <div className="omr-number">
                    {q.number}.
                </div>
                <div className="omr-options">
                    {Array.from({ length: questionChoiceCount(q, effectiveOptionsCount) }, (_, i) => {
                        const optionNum = i + 1;
                        // Solve Mode: Student Answer
                        const isMarked = userAnswers[q.id] === optionNum;
                        // Editor Mode: Correct Answer (stored in q.answer)
                        const isCorrect = showAnswerKey && q.answer === optionNum;

                        return (
                            <div
                                key={i}
                                className={`omr-bubble ${isMarked ? 'is-marked' : ''} ${isCorrect ? 'is-key' : ''}`}
                                onClick={(e) => {
                                    if ((mode === 'solve' || mode === 'editor') && onAnswerClick) {
                                        e.stopPropagation(); // Prevent row click
                                        onAnswerClick(q.id, optionNum);
                                    }
                                }}
                                style={{
                                    cursor: (mode === 'solve' || mode === 'editor') ? 'pointer' : 'default',
                                }}
                            >
                                {optionNum}
                            </div>
                        );
                    })}
                </div>

                {!isNumbersOnlyPrint && (
                    <div className="omr-meta">
                        {q.label && (
                            <span className="omr-chip omr-chip-label" title={q.label}>
                                {q.label}
                            </span>
                        )}
                        {q.score !== undefined && (
                            <span className="omr-chip omr-chip-score">
                                {q.score}점
                            </span>
                        )}
                        {(q.pdfLocation || q.pdfRegion) && (
                            <span className="omr-chip omr-chip-pdf" title={`PDF ${q.pdfLocation?.page || q.pdfRegion?.page}쪽 연결`}>
                                PDF
                            </span>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div id="omr-preview" className={`omr-sheet omr-sheet--${mode} ${isNumbersOnlyPrint ? 'omr-sheet--numbers-only' : ''}`}>
            {/* OMR Markers */}
            <div className="omr-marker omr-marker-tl"></div>
            <div className="omr-marker omr-marker-tr"></div>
            <div className="omr-marker omr-marker-bl"></div>
            <div className="omr-marker omr-marker-br"></div>

            {!isNumbersOnlyPrint && (
                <>
                    <div className="omr-header">
                        <div className="omr-title-area">
                            <h1 className="omr-title">{title}</h1>
                            <p className="omr-subtitle">컴퓨터용 사인펜을 사용하여 표기하십시오.</p>
                            <div className="omr-sheet-meta">
                                <span>{displayQuestions.length}문항</span>
                                <span>{effectiveOptionsCount}지선다</span>
                                <span>{cols}단 구성</span>
                            </div>
                        </div>

                        <div className="omr-info-grid">
                            <div className="omr-field">
                                <span className="omr-label">과 목</span>
                                <div className="omr-input-box"></div>
                            </div>
                            <div className="omr-field">
                                <span className="omr-label">점 수</span>
                                <div className="omr-input-box"></div>
                            </div>
                            <div className="omr-field">
                                <span className="omr-label">성 명</span>
                                <div className="omr-input-box"></div>
                            </div>
                            <div className="omr-field">
                                <span className="omr-label">학 번</span>
                                <div className="omr-input-box"></div>
                            </div>
                        </div>
                    </div>

                    <div className="omr-control-band">
                        <div className="omr-id-marking" aria-label="수험번호 마킹란">
                            <div className="omr-section-title">수험번호 마킹란</div>
                            <div className="omr-id-columns">
                                {Array.from({ length: 6 }, (_, columnIndex) => (
                                    <div className="omr-id-column" key={columnIndex}>
                                        <div className="omr-id-column-label">{columnIndex + 1}</div>
                                        {Array.from({ length: 10 }, (_, digit) => (
                                            <span className="omr-id-bubble" key={digit}>
                                                {digit}
                                            </span>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="omr-test-summary" aria-label="시험 요약">
                            <div className="omr-section-title">검사지 정보</div>
                            <div className="omr-summary-grid">
                                <div className="omr-summary-card">
                                    <span>총점</span>
                                    <strong>{totalScoreLabel}</strong>
                                </div>
                                <div className="omr-summary-card">
                                    <span>정답</span>
                                    <strong>{answeredKeyCount}/{displayQuestions.length}</strong>
                                </div>
                                <div className="omr-summary-card">
                                    <span>PDF</span>
                                    <strong>{pdfLinkedCount}/{displayQuestions.length}</strong>
                                </div>
                            </div>
                            <div className="omr-barcode-strip" aria-hidden="true" />
                            <div className="omr-supervisor-box">
                                <span>감독 확인</span>
                            </div>
                        </div>
                    </div>
                </>
            )}

            <div className="omr-body" style={{ '--omr-cols': cols } as React.CSSProperties}>
                {columnQuestions.map((chunk, index) => (
                    <React.Fragment key={index}>
                        <div className="omr-column">
                            {chunk.map(renderQuestion)}
                        </div>
                        {index < cols - 1 && <div className="omr-column-divider" aria-hidden="true" />}
                    </React.Fragment>
                ))}
            </div>

            {!isNumbersOnlyPrint && (
                <div className="omr-footer">
                    OMR Maker - Generated Answer Sheet
                </div>
            )}
        </div>
    );
}
