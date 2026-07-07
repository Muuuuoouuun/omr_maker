"use client";

import React, { useEffect, useRef } from "react";
import { PenLine } from "lucide-react";
import { DEFAULT_CHOICE_COUNT, normalizeChoiceCount, questionChoiceCount, type Question, type QuestionDrawingSummary } from "@/types/omr";
import { getCardViewGridMetrics } from "@/lib/pure";

interface OMRCardViewProps {
  title?: string;
  questions: Question[];
  optionsCount?: number;
  userAnswers?: Record<number, number>;
  selectedQuestionId?: number | null;
  onAnswerClick?: (questionId: number, optionIndex: number) => void;
  onQuestionClick?: (id: number) => void;
  mode?: "solve" | "view" | "editor";
  correctAnswers?: Record<number, number>;
  columns?: number; // Optional hint for column count
  showMeta?: boolean; // Show label/score/PDF indicators
  questionDrawings?: QuestionDrawingSummary[];
  numberingLayout?: "grid" | "vertical";
}

function LinkIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
      <path
        d="M5 7C5.5 7.5 6.5 7.5 7 7L8.5 5.5C9.5 4.5 9.5 3 8.5 2C7.5 1 6 1 5 2L4 3M7 5C6.5 4.5 5.5 4.5 5 5L3.5 6.5C2.5 7.5 2.5 9 3.5 10C4.5 11 6 11 7 10L8 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

const difficultyLabels: Record<string, string> = {
  easy: "기초",
  medium: "표준",
  hard: "심화",
  killer: "킬러",
};

export default function OMRCardView({
  title = "OMR 답안지",
  questions,
  optionsCount = DEFAULT_CHOICE_COUNT,
  userAnswers = {},
  selectedQuestionId = null,
  onAnswerClick,
  onQuestionClick,
  mode = "solve",
  correctAnswers,
  columns = 1,
  showMeta = false,
  questionDrawings = [],
  numberingLayout = "grid",
}: OMRCardViewProps) {
  const isEditor = mode === "editor";
  const fallbackChoiceCount = normalizeChoiceCount(optionsCount);

  // In editor mode, "answers" to show as marked are the correct answers stored in the questions themselves
  const effectiveAnswers: Record<number, number> = isEditor
    ? questions.reduce((acc, q) => {
        if (q.answer !== undefined && q.answer !== null) acc[q.id] = q.answer;
        return acc;
      }, {} as Record<number, number>)
    : userAnswers;

  const answeredCount = questions.filter(
    (question) => effectiveAnswers[question.id] !== undefined && effectiveAnswers[question.id] !== null
  ).length;
  const totalCount = questions.length;
  const progress = totalCount > 0 ? (answeredCount / totalCount) * 100 : 0;

  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const gridMetrics = getCardViewGridMetrics(questions.length, columns);
  const gridRows = Math.max(gridMetrics.rows, 1);
  const gridStyle = {
    "--omr-card-cols": gridMetrics.columns,
    "--omr-card-rows": gridRows,
    gridTemplateRows: `repeat(${gridRows}, auto)`,
  } as React.CSSProperties;
  const handwritingByQuestionId = new Map(
    questionDrawings.map((drawing) => [drawing.questionId, drawing])
  );

  useEffect(() => {
    if (selectedQuestionId !== null && cardRefs.current[selectedQuestionId]) {
      cardRefs.current[selectedQuestionId]?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [selectedQuestionId]);

  return (
    <div className={`omr-cardview ${numberingLayout === "vertical" ? "is-vertical-numbering" : ""}`}>
      {/* Header with progress */}
      <div className="omr-cardview-header">
        <div className="omr-cardview-header-top">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="omr-cardview-title">{title}</div>
            <div
              style={{
                fontSize: "0.78rem",
                color: "var(--muted)",
                fontWeight: 500,
                marginTop: "2px",
              }}
            >
              {isEditor
                ? "문항을 선택하고 정답을 지정하세요"
                : "문제 번호 또는 보기를 눌러 답을 표기하세요"}
            </div>
          </div>
          <div className="omr-cardview-counter">
            <span className="omr-cardview-counter-current">{answeredCount}</span>
            <span className="omr-cardview-counter-total">/ {totalCount}</span>
          </div>
        </div>

        <div className="omr-cardview-progress">
          <div
            className="omr-cardview-progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Card Grid */}
      <div className="omr-cardview-grid" style={gridStyle}>
        {questions.map((q) => {
          const answered = effectiveAnswers[q.id];
          const isSelected = selectedQuestionId === q.id;
          const isAnswered = answered !== undefined && answered !== null;
          const questionOptionsCount = questionChoiceCount(q, fallbackChoiceCount);
          const handwritingSummary = handwritingByQuestionId.get(q.id);

          return (
            <div
              key={q.id}
              ref={(el) => {
                cardRefs.current[q.id] = el;
              }}
              className={`q-card ${isAnswered ? "answered" : ""} ${
                isSelected ? "selected" : ""
              } ${isEditor ? "editor-card" : ""} ${handwritingSummary ? "has-handwriting" : ""}`}
              onClick={() => onQuestionClick?.(q.id)}
            >
              <div className="q-card-num">{q.number}.</div>

              <div className="q-card-bubbles">
                {Array.from({ length: questionOptionsCount }, (_, i) => {
                  const optNum = i + 1;
                  const isMarked = answered === optNum;
                  const correct = correctAnswers?.[q.id];
                  const isCorrectAnswer =
                    mode === "view" && correct !== undefined && correct === optNum;
                  const isWrongAnswer =
                    mode === "view" &&
                    isMarked &&
                    correct !== undefined &&
                    correct !== optNum;

                  let bubbleClass = "q-bubble";
                  if (isMarked && !isWrongAnswer) bubbleClass += " marked";
                  if (isCorrectAnswer && !isMarked) bubbleClass += " correct";
                  if (isWrongAnswer) bubbleClass += " wrong";

                  return (
                    <button
                      key={i}
                      className={bubbleClass}
                      onClick={(e) => {
                        e.stopPropagation();
                        if ((mode === "solve" || mode === "editor") && onAnswerClick) {
                          onAnswerClick(q.id, optNum);
                        }
                      }}
                      disabled={mode === "view"}
                      aria-label={`문제 ${q.number}번 보기 ${optNum}`}
                    >
                      {optNum}
                    </button>
                  );
                })}
              </div>

              {handwritingSummary && (
                <span
                  className="q-handwriting-chip"
                  title={`${handwritingSummary.page}p 필기 ${handwritingSummary.strokeCount}획`}
                  aria-label={`문제 ${q.number}번 필기 ${handwritingSummary.strokeCount}획`}
                >
                  <PenLine size={10} aria-hidden="true" />
                  {handwritingSummary.strokeCount}
                </span>
              )}

              {/* Meta indicators (editor mode) */}
              {showMeta && (q.label || q.tags?.concept || q.tags?.difficulty || q.score !== undefined || q.pdfLocation || q.pdfRegion) && (
                <div className="q-card-meta">
                  {q.label && (
                    <span className="q-meta-chip q-meta-label">{q.label}</span>
                  )}
                  {q.tags?.concept && (
                    <span className="q-meta-chip q-meta-label">{q.tags.concept}</span>
                  )}
                  {q.tags?.difficulty && (
                    <span className="q-meta-chip q-meta-score">{difficultyLabels[q.tags.difficulty] || q.tags.difficulty}</span>
                  )}
                  {q.score !== undefined && (
                    <span className="q-meta-chip q-meta-score">{q.score}점</span>
                  )}
                  {(q.pdfLocation || q.pdfRegion) && (
                    <span className="q-meta-chip q-meta-pdf" title={`PDF ${q.pdfLocation?.page || q.pdfRegion?.page}p 연결됨`}>
                      <LinkIcon />
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      {mode === "solve" && answeredCount < totalCount && (
        <div
          style={{
            textAlign: "center",
            fontSize: "0.78rem",
            color: "var(--muted)",
            marginTop: "0.5rem",
            fontWeight: 500,
          }}
        >
          남은 문제 {totalCount - answeredCount}개
        </div>
      )}
      {mode === "solve" && answeredCount === totalCount && totalCount > 0 && (
        <div
          className="badge badge-success"
          style={{
            margin: "0.5rem auto 0",
            fontSize: "0.75rem",
            padding: "0.4rem 0.9rem",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6L5 9L10 3"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          모든 문제 표기 완료
        </div>
      )}
    </div>
  );
}
