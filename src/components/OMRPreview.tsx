"use client";

import React, { useRef, useEffect, useState } from 'react';
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

    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    const [contentHeight, setContentHeight] = useState(800);

    const baseWidth = cols === 1 ? 790 : cols === 2 ? 1120 : 1600;
    const minAspect = cols === 1 ? 1 / 1.414 : cols === 2 ? 1.414 : 2.12;
    const minHeight = baseWidth / minAspect;

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            if (entries[0]) {
                const { width } = entries[0].contentRect;
                setScale(width / baseWidth);
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [baseWidth]);

    useEffect(() => {
        if (!contentRef.current) return;
        const observer = new ResizeObserver((entries) => {
            if (entries[0]) {
                setContentHeight(entries[0].contentRect.height);
            }
        });
        observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, []);

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
                <div className="omr-number" style={{ width: '40px', fontWeight: 'bold', color: isRowSelected ? 'var(--primary)' : 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: '1.2' }} title={q.label ? `[${q.label}]` : ''}>
                    <span>{q.number}</span>
                    {(q.score || q.pdfLocation) && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginTop: '2px' }}>
                            {q.pdfLocation && <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--primary)' }} title="PDF Mapped" />}
                            {q.score !== undefined && <span style={{ fontSize: '0.6rem', color: 'var(--muted)', fontWeight: 'normal' }}>{q.score}</span>}
                        </div>
                    )}
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
            </div>
        );
    };

    return (
        <div ref={containerRef} className="omr-preview-scaler" style={{ width: '100%', position: 'relative', height: `${contentHeight * scale}px`, overflow: 'hidden', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0, 0, 0, 0.08), 0 4px 6px rgba(0, 0, 0, 0.04)', background: 'white' }}>
            <div style={{
                width: `${baseWidth}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                position: 'absolute',
                top: 0, left: 0
            }}>
                <div id="omr-preview" ref={contentRef} className="omr-sheet" style={{ width: '100%', minHeight: `${minHeight}px`, maxWidth: 'none', margin: 0, padding: cols === 1 ? '3rem' : '3.5rem 4rem', boxShadow: 'none', borderRadius: 0, border: 'none', display: 'flex', flexDirection: 'column' }}>
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

                    <div style={{ marginTop: 'auto', textAlign: 'center', fontSize: '1rem', color: '#999', paddingTop: '1rem' }}>
                        OMR Maker - Generated Answer Sheet
                    </div>
                </div>
            </div>
        </div>
    );
}
