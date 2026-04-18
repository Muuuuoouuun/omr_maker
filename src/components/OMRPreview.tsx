"use client";

import React from 'react';
import { Question } from '@/types/omr';

interface OMRPreviewProps {
    title?: string;
    questions?: Question[];
    optionsCount?: number;
    columns?: number;
    selectedQuestionId?: number | null;
    onQuestionClick?: (id: number) => void;
    // New Props
    mode?: 'editor' | 'solve' | 'view';
    userAnswers?: Record<number, number>; // Student marked answers
    onAnswerClick?: (questionId: number, optionIndex: number) => void;
}

export default function OMRPreview({
    title = "OMR ANSWER SHEET",
    questions = [],
    optionsCount = 5,
    columns = 2,
    selectedQuestionId = null,
    onQuestionClick,
    mode = 'editor',
    userAnswers = {},
    onAnswerClick
}: OMRPreviewProps) {

    // Helper to generate dummy questions if empty
    const displayQuestions = questions.length > 0
        ? questions
        : Array.from({ length: 20 }, (_, i) => ({ id: i + 1, number: i + 1 } as Question));

    const totalQuestions = displayQuestions.length;

    // Layout Logic
    const cols = Math.min(Math.max(columns || 2, 1), 3);
    const questionsPerCol = Math.ceil(totalQuestions / cols);

    const columnQuestions = Array.from({ length: cols }, (_, colIndex) => {
        const start = colIndex * questionsPerCol;
        const end = Math.min((colIndex + 1) * questionsPerCol, totalQuestions);
        return displayQuestions.slice(start, end);
    });

    const renderQuestion = (q: Question) => {
        const isRowSelected = selectedQuestionId === q.id;

        return (
            <div
                key={q.id}
                className={`omr-row ${isRowSelected ? 'omr-row-selected' : ''}`}
                onClick={() => onQuestionClick && onQuestionClick(q.id)}
                style={{
                    cursor: onQuestionClick ? 'pointer' : 'default',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    background: isRowSelected ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    border: isRowSelected ? '1px solid var(--primary)' : '1px solid transparent',
                    transition: 'all 0.2s ease'
                }}
            >
                <div className="omr-number" style={{ width: '30px', fontWeight: 'bold', color: isRowSelected ? 'var(--primary)' : 'inherit' }}>
                    {q.number}
                </div>
                <div className="omr-options">
                    {Array.from({ length: optionsCount }, (_, i) => {
                        const optionNum = i + 1;
                        // Solve Mode: Student Answer
                        const isMarked = userAnswers[q.id] === optionNum;
                        // Editor Mode: Correct Answer (stored in q.answer)
                        const isCorrect = mode === 'editor' && q.answer === optionNum;

                        return (
                            <div
                                key={i}
                                className="omr-bubble"
                                onClick={(e) => {
                                    if ((mode === 'solve' || mode === 'editor') && onAnswerClick) {
                                        e.stopPropagation(); // Prevent row click
                                        onAnswerClick(q.id, optionNum);
                                    }
                                }}
                                style={{
                                    cursor: (mode === 'solve' || mode === 'editor') ? 'pointer' : 'default',
                                    background: isMarked ? '#000' : (isCorrect ? 'rgba(239, 68, 68, 0.1)' : 'white'), // Black for student, Red tint for teacher
                                    color: isMarked ? '#fff' : (isCorrect ? '#ef4444' : 'inherit'),
                                    borderColor: isCorrect ? '#ef4444' : undefined,
                                    fontWeight: isMarked || isCorrect ? 'bold' : 'normal',
                                    position: 'relative'
                                }}
                            >
                                {optionNum}
                                {/* Teacher Key Indicator (Circle) */}
                                {isCorrect && <div style={{ position: 'absolute', inset: -2, border: '2px solid #ef4444', borderRadius: '50%' }}></div>}
                            </div>
                        );
                    })}
                </div>

                {/* Metadata Tags */}
                <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
                    {q.label && (
                        <span style={{ fontSize: '0.7rem', background: '#e2e8f0', padding: '1px 5px', borderRadius: '4px', color: '#475569' }}>
                            {q.label}
                        </span>
                    )}
                    {q.score !== undefined && (
                        <span style={{ fontSize: '0.7rem', background: 'rgba(236, 72, 153, 0.1)', padding: '1px 5px', borderRadius: '4px', color: 'var(--secondary)', fontWeight: 'bold' }}>
                            {q.score}점
                        </span>
                    )}
                    {q.pdfLocation && (
                        <span style={{ fontSize: '0.8rem', cursor: 'help' }} title={`Page ${q.pdfLocation.page}`}>
                            🔗
                        </span>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div id="omr-preview" className="omr-sheet">
            {/* OMR Markers */}
            <div className="omr-marker omr-marker-tl"></div>
            <div className="omr-marker omr-marker-tr"></div>
            <div className="omr-marker omr-marker-bl"></div>
            <div className="omr-marker omr-marker-br"></div>

            <div className="omr-header">
                <div className="omr-title-area">
                    <h1 className="omr-title">{title}</h1>
                    <p style={{ fontSize: '0.9rem', color: '#666' }}>컴퓨터용 사인펜을 사용하여 표기하십시오.</p>
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

            <div className="omr-body" style={{ '--omr-cols': cols } as React.CSSProperties}>
                {columnQuestions.map((chunk, index) => (
                    <React.Fragment key={index}>
                        <div className="omr-column">
                            {chunk.map(renderQuestion)}
                        </div>
                        {index < cols - 1 && (
                            <div style={{ width: '1px', background: '#000', margin: '0 1rem' }}></div>
                        )}
                    </React.Fragment>
                ))}
            </div>

            <div style={{ marginTop: 'auto', textAlign: 'center', fontSize: '0.8rem', color: '#999' }}>
                OMR Maker - Generated Answer Sheet
            </div>
        </div>
    );
}
