"use client";

import { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PdfDrawings } from '@/types/omr';
import { FileText } from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Worker setup for Next.js
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface MarkerData {
    page: number;
    x: number;
    y: number;
    label: string | number;
    color?: string;
    onClick?: () => void;
    // Floating OMR popup support
    questionId?: number;
    currentAnswer?: number;
    onAnswer?: (option: number) => void;
    optionsCount?: number;
}

interface PDFViewerProps {
    file: File | null;
    onLoadSuccess: (numPages: number) => void;
    onPageClick?: (page: number, x: number, y: number) => void;
    onFileDrop?: (file: File) => void;
    // Drawing Props
    enableDrawing?: boolean;
    readOnlyDrawings?: boolean;
    drawings?: PdfDrawings; // per page, array of path strings
    onDrawingsChange?: (page: number, newPaths: string[]) => void;
    // Markers Props
    markers?: MarkerData[];
}

export default function PDFViewer({
    file,
    onLoadSuccess,
    onPageClick,
    onFileDrop,
    enableDrawing = false,
    readOnlyDrawings = false,
    drawings = {},
    onDrawingsChange,
    markers = [],
    forcePage
}: PDFViewerProps & { forcePage?: number }) {
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState<number>(1);
    const [inputPage, setInputPage] = useState<string>("1");
    const [scale, setScale] = useState<number>(1.0);
    const [isDragging, setIsDragging] = useState(false);

    // Drawing State
    const [isDrawing, setIsDrawing] = useState(false);
    const [currentPath, setCurrentPath] = useState<{ x: number, y: number }[]>([]);
    const [drawingMode, setDrawingMode] = useState<'click' | 'pen' | 'eraser'>('click');
    const [penColor, setPenColor] = useState('#ef4444'); // Default Red
    const [undoStack, setUndoStack] = useState<Record<number, string[][]>>({});
    const [redoStack, setRedoStack] = useState<Record<number, string[][]>>({});
    const shouldRenderDrawingLayer = enableDrawing || readOnlyDrawings;
    const canEditDrawing = enableDrawing && !readOnlyDrawings;

    // Floating OMR popup state - tracks active marker index (page + list index)
    const [activePopupKey, setActivePopupKey] = useState<string | null>(null);

    // Canvas Ref
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState<number>(0);

    useEffect(() => {
        if (!wrapperRef.current) return;
        const observer = new ResizeObserver((entries) => {
            if (entries[0]) {
                const { width } = entries[0].contentRect;
                setContainerWidth(width - 64); // Account for 2rem padding (32px * 2)
            }
        });
        observer.observe(wrapperRef.current);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (typeof forcePage === 'number' && forcePage >= 1 && forcePage <= numPages) {
            setPageNumber(forcePage);
        }
    }, [forcePage, numPages]);

    // Close popup on Escape key
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setActivePopupKey(null);
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, []);

    // Close popup when changing page
    useEffect(() => {
        setActivePopupKey(null);
    }, [pageNumber]);

    function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
        setNumPages(numPages);
        onLoadSuccess(numPages);
    }

    useEffect(() => {
        setInputPage(pageNumber.toString());
    }, [pageNumber]);

    const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInputPage(e.target.value);
    };

    const handlePageInputSubmit = (e: React.KeyboardEvent<HTMLInputElement> | React.FocusEvent<HTMLInputElement>) => {
        if ('key' in e && (e as React.KeyboardEvent).key !== 'Enter') return;
        let newPage = parseInt(inputPage);
        if (isNaN(newPage)) {
            setInputPage(pageNumber.toString());
            return;
        }
        if (newPage < 1) newPage = 1;
        if (newPage > numPages) newPage = numPages;
        setPageNumber(newPage);
        setInputPage(newPage.toString());
    };

    // --- Drawing Logic ---

    // Render existing paths when page or drawings change
    useEffect(() => {
        if (!shouldRenderDrawingLayer || !canvasRef.current || !containerRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Resize canvas to match container (vital for scaling)
        const rect = containerRef.current.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw saved paths
        const paths = drawings[pageNumber] || [];
        paths.forEach(pathStr => {
            try {
                const pathData = JSON.parse(pathStr);
                if (pathData.points && pathData.points.length > 0) {
                    ctx.beginPath();
                    const isEraser = pathData.mode === 'eraser';
                    ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
                    ctx.strokeStyle = isEraser ? 'rgba(0,0,0,1)' : (pathData.color || '#ef4444');
                    ctx.lineWidth = pathData.width || (isEraser ? 20 : 2);
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.moveTo(pathData.points[0].x * canvas.width, pathData.points[0].y * canvas.height);
                    for (let i = 1; i < pathData.points.length; i++) {
                        ctx.lineTo(pathData.points[i].x * canvas.width, pathData.points[i].y * canvas.height);
                    }
                    ctx.stroke();
                }
            } catch (err) {
                console.error("Failed to parse path JSON", err);
            }
        });

        // Reset globalCompositeOperation to default
        ctx.globalCompositeOperation = 'source-over';

    }, [pageNumber, drawings, shouldRenderDrawingLayer, scale, file]); // Re-render on these changes

    const handleUndo = useCallback(() => {
        if (!canEditDrawing || !onDrawingsChange) return;
        const pageUndo = undoStack[pageNumber] || [];
        if (pageUndo.length === 0) return; // nothing to undo
        
        const previousState = pageUndo[pageUndo.length - 1];
        const newUndo = pageUndo.slice(0, -1);
        
        // Push current state to redo stack
        const currentState = drawings[pageNumber] || [];
        setRedoStack(prev => ({
            ...prev,
            [pageNumber]: [...(prev[pageNumber] || []), currentState]
        }));
        
        setUndoStack(prev => ({
            ...prev,
            [pageNumber]: newUndo
        }));
        
        onDrawingsChange(pageNumber, previousState);
    }, [canEditDrawing, drawings, onDrawingsChange, pageNumber, undoStack]);

    const handleRedo = useCallback(() => {
        if (!canEditDrawing || !onDrawingsChange) return;
        const pageRedo = redoStack[pageNumber] || [];
        if (pageRedo.length === 0) return; // nothing to redo
        
        const nextState = pageRedo[pageRedo.length - 1];
        const newRedo = pageRedo.slice(0, -1);
        
        // Push current state to undo stack
        const currentState = drawings[pageNumber] || [];
        setUndoStack(prev => ({
            ...prev,
            [pageNumber]: [...(prev[pageNumber] || []), currentState]
        }));
        
        setRedoStack(prev => ({
            ...prev,
            [pageNumber]: newRedo
        }));
        
        onDrawingsChange(pageNumber, nextState);
    }, [canEditDrawing, drawings, onDrawingsChange, pageNumber, redoStack]);

    // Keyboard Shortcuts for Undo/Redo
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!canEditDrawing) return;
            
            // Do not capture if editing an input
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
                return;
            }

            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

            if (isCmdOrCtrl && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    handleRedo();
                } else {
                    handleUndo();
                }
            } else if (isCmdOrCtrl && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                handleRedo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [canEditDrawing, handleRedo, handleUndo]);

    const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
        if (!canEditDrawing || drawingMode === 'click') return;
        
        // Multi-touch scroll check: ignore drawing if 2+ fingers are touch-dragging
        if ('touches' in e) {
            if (e.touches.length >= 2) {
                setIsDrawing(false);
                return;
            }
            // Prevent browser scroll when drawing with 1 finger
            if (e.touches.length === 1) {
                e.preventDefault();
            }
        }

        setIsDrawing(true);
        const pos = getPos(e);
        setCurrentPath([pos]);
    };

    const draw = (e: React.MouseEvent | React.TouchEvent) => {
        if (!isDrawing || !canEditDrawing || !canvasRef.current) return;
        
        // Multi-touch zoom/scroll: abort drawing if fingers >= 2
        if ('touches' in e) {
            if (e.touches.length >= 2) {
                stopDrawing();
                return;
            }
            if (e.touches.length === 1) {
                e.preventDefault();
            }
        }

        const pos = getPos(e);
        const last = currentPath[currentPath.length - 1];
        setCurrentPath(prev => [...prev, pos]);

        // Real-time visual feedback drawing segment-by-segment
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            const rect = canvasRef.current.getBoundingClientRect();
            ctx.beginPath();
            if (last) {
                ctx.moveTo(last.x * rect.width, last.y * rect.height);
            } else {
                ctx.moveTo(pos.x * rect.width, pos.y * rect.height);
            }
            ctx.lineTo(pos.x * rect.width, pos.y * rect.height);
            
            const isEraser = drawingMode === 'eraser';
            ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
            ctx.strokeStyle = isEraser ? 'rgba(0,0,0,1)' : penColor;
            ctx.lineWidth = isEraser ? 20 : 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
            
            // Restore default draw mode
            ctx.globalCompositeOperation = 'source-over';
        }
    };

    const stopDrawing = () => {
        if (!isDrawing) return;
        setIsDrawing(false);

        // Save Path
        if (currentPath.length > 0 && onDrawingsChange) {
            const newPath = {
                mode: drawingMode,
                color: drawingMode === 'eraser' ? 'rgba(0,0,0,1)' : penColor,
                width: drawingMode === 'eraser' ? 20 : 2,
                points: currentPath
            };
            const currentPaths = drawings[pageNumber] || [];
            
            // Push to Undo Stack and clear Redo Stack
            setUndoStack(prev => ({
                ...prev,
                [pageNumber]: [...(prev[pageNumber] || []), currentPaths]
            }));
            setRedoStack(prev => ({
                ...prev,
                [pageNumber]: []
            }));

            onDrawingsChange(pageNumber, [...currentPaths, JSON.stringify(newPath)]);
        }
        setCurrentPath([]);
    };

    const getPos = (e: React.MouseEvent | React.TouchEvent) => {
        if (!canvasRef.current) return { x: 0, y: 0 };
        const rect = canvasRef.current.getBoundingClientRect();
        let clientX, clientY;
        if ('touches' in e) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = (e as React.MouseEvent).clientX;
            clientY = (e as React.MouseEvent).clientY;
        }
        return {
            x: (clientX - rect.left) / rect.width,
            y: (clientY - rect.top) / rect.height
        };
    };

    const clearPage = () => {
        if (confirm("이 페이지의 필기를 모두 지우시겠습니까?")) {
            if (onDrawingsChange) {
                const currentPaths = drawings[pageNumber] || [];
                setUndoStack(prev => ({
                    ...prev,
                    [pageNumber]: [...(prev[pageNumber] || []), currentPaths]
                }));
                setRedoStack(prev => ({
                    ...prev,
                    [pageNumber]: []
                }));
                onDrawingsChange(pageNumber, []);
            }
        }
    };

    // --- End Drawing Logic ---


    function handlePageClick(event: React.MouseEvent<HTMLDivElement>) {
        // ... (Existing click logic, maybe disable if drawing?)
        if (canEditDrawing && drawingMode === 'pen') return; // Don't trigger link click while drawing
        if (!onPageClick) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const normalizedX = x / rect.width;
        const normalizedY = y / rect.height;

        onPageClick(pageNumber, normalizedX, normalizedY);
    }

    // Drag & Drop Handlers (Existing...)
    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault(); setIsDragging(false);
        if (onFileDrop && e.dataTransfer.files[0] && e.dataTransfer.files[0].type === 'application/pdf') {
            onFileDrop(e.dataTransfer.files[0]);
        } else { alert('PDF 파일만 업로드 가능합니다.'); }
    };

    return (
        <div
            className="pdf-viewer-container"
            onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
            style={{
                height: '100%', display: 'flex', flexDirection: 'column',
                background: '#525659', borderRight: '1px solid #333', position: 'relative', overflow: 'hidden'
            }}
        >
            {/* ... Drag Overlay ... */}
            {isDragging && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(99, 102, 241, 0.2)', border: '3px dashed #6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold', fontSize: '1.5rem', backdropFilter: 'blur(4px)' }}>PDF 파일을 여기에 놓으세요</div>
            )}

            {/* PDF Toolbar */}
            <div className="pdf-viewer-toolbar" style={{ padding: '0.5rem 1rem', background: '#323639', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.9rem', borderBottom: '1px solid #000' }}>
                <div className="pdf-viewer-file" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span className="pdf-viewer-file-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>{file ? file.name : 'PDF 없음'}</span>
                </div>

                {file && (
                    <div className="pdf-viewer-controls" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {/* Drawing Tools */}
                        {canEditDrawing && (
                            <div className="pdf-viewer-drawing-tools" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginRight: '1rem', paddingRight: '1rem', borderRight: '1px solid #555' }}>
                                <button 
                                    onClick={() => setDrawingMode('click')} 
                                    title="일반 마우스 모드 (선택/클릭)"
                                    style={{ 
                                        background: drawingMode === 'click' ? '#4f46e5' : '#222', 
                                        border: '1px solid #555', 
                                        borderRadius: '6px', 
                                        padding: '4px 10px', 
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    🖱️ 일반
                                </button>
                                <button 
                                    onClick={() => setDrawingMode('pen')} 
                                    title="펜 그리기 모드"
                                    style={{ 
                                        background: drawingMode === 'pen' ? '#4f46e5' : '#222', 
                                        border: '1px solid #555', 
                                        borderRadius: '6px', 
                                        padding: '4px 10px', 
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    ✏️ 펜
                                </button>
                                <button 
                                    onClick={() => setDrawingMode('eraser')} 
                                    title="지우개 모드 (선택 궤적 삭제)"
                                    style={{ 
                                        background: drawingMode === 'eraser' ? '#4f46e5' : '#222', 
                                        border: '1px solid #555', 
                                        borderRadius: '6px', 
                                        padding: '4px 10px', 
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    🧹 지우개
                                </button>

                                {drawingMode === 'pen' && (
                                    <input 
                                        type="color" 
                                        value={penColor} 
                                        onChange={(e) => setPenColor(e.target.value)} 
                                        title="펜 색상 선택"
                                        style={{ width: '28px', height: '28px', padding: 0, border: '1px solid #555', borderRadius: '50%', background: 'none', cursor: 'pointer', overflow: 'hidden' }} 
                                    />
                                )}

                                <div style={{ width: '1px', height: '16px', background: '#555', margin: '0 4px' }}></div>

                                <button 
                                    onClick={handleUndo} 
                                    disabled={!(undoStack[pageNumber] && undoStack[pageNumber].length > 0)}
                                    title="실행 취소 (Cmd/Ctrl+Z)"
                                    style={{ 
                                        background: '#222', 
                                        border: '1px solid #555', 
                                        borderRadius: '6px', 
                                        padding: '4px 8px', 
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        cursor: (undoStack[pageNumber] && undoStack[pageNumber].length > 0) ? 'pointer' : 'not-allowed',
                                        opacity: (undoStack[pageNumber] && undoStack[pageNumber].length > 0) ? 1 : 0.4,
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    ↩️ Undo
                                </button>
                                <button 
                                    onClick={handleRedo} 
                                    disabled={!(redoStack[pageNumber] && redoStack[pageNumber].length > 0)}
                                    title="다시 실행 (Cmd/Ctrl+Y)"
                                    style={{ 
                                        background: '#222', 
                                        border: '1px solid #555', 
                                        borderRadius: '6px', 
                                        padding: '4px 8px', 
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        cursor: (redoStack[pageNumber] && redoStack[pageNumber].length > 0) ? 'pointer' : 'not-allowed',
                                        opacity: (redoStack[pageNumber] && redoStack[pageNumber].length > 0) ? 1 : 0.4,
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    ↪️ Redo
                                </button>
                                <button 
                                    onClick={clearPage} 
                                    title="이 페이지의 모든 필기 삭제"
                                    style={{ 
                                        background: '#ef4444', 
                                        border: 'none', 
                                        borderRadius: '6px', 
                                        padding: '4px 8px', 
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        marginLeft: '4px',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    🗑️ 전체삭제
                                </button>
                            </div>
                        )}

                        <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1} style={{ color: 'white', padding: '0.2rem 0.5rem', cursor: 'pointer', background: 'transparent', border: 'none' }}>◀</button>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input
                                type="text"
                                value={inputPage}
                                onChange={handlePageInputChange}
                                onBlur={handlePageInputSubmit}
                                onKeyDown={handlePageInputSubmit}
                                style={{ width: '30px', textAlign: 'center', background: '#222', color: 'white', border: '1px solid #555', borderRadius: '4px', padding: '2px' }}
                            />
                            / {numPages}
                        </span>
                        <button onClick={() => setPageNumber(p => Math.min(numPages, p + 1))} disabled={pageNumber >= numPages} style={{ color: 'white', padding: '0.2rem 0.5rem', cursor: 'pointer', background: 'transparent', border: 'none' }}>▶</button>
                        <div style={{ width: '1px', height: '15px', background: '#666', margin: '0 0.5rem' }}></div>
                        <button onClick={() => setScale(s => Math.max(0.5, s - 0.1))} style={{ color: 'white', cursor: 'pointer' }}>-</button>
                        <span>{Math.round(scale * 100)}%</span>
                        <button onClick={() => setScale(s => Math.min(2.5, s + 0.1))} style={{ color: 'white', cursor: 'pointer' }}>+</button>
                    </div>
                )}
            </div>

            {/* PDF Content */}
            <div ref={wrapperRef} className="pdf-viewer-scroll" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#525659', position: 'relative' }}>
                <div className="pdf-viewer-page-wrap" style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '2rem', width: '100%' }}>
                    {file ? (
                        <Document file={file} onLoadSuccess={onDocumentLoadSuccess} loading={<div style={{ color: 'white' }}>문서 로딩 중...</div>}>
                            <div
                                ref={containerRef}
                                onClick={handlePageClick}
                                style={{ position: 'relative', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                            >
                                <Page pageNumber={pageNumber} scale={scale} width={containerWidth > 0 ? containerWidth : undefined} renderTextLayer={true} renderAnnotationLayer={true} />{/* Canvas Overlay */}
                                {shouldRenderDrawingLayer && (
                                    <canvas
                                        ref={canvasRef}
                                        onMouseDown={startDrawing}
                                        onMouseMove={draw}
                                        onMouseUp={stopDrawing}
                                        onMouseLeave={stopDrawing}
                                        onTouchStart={startDrawing}
                                        onTouchMove={draw}
                                        onTouchEnd={stopDrawing}
                                        style={{
                                            position: 'absolute',
                                            top: 0, left: 0,
                                            width: '100%', height: '100%',
                                            zIndex: 10,
                                            cursor: canEditDrawing ? (drawingMode === 'pen' ? 'crosshair' : drawingMode === 'eraser' ? 'cell' : 'default') : 'default',
                                            pointerEvents: canEditDrawing && (drawingMode === 'pen' || drawingMode === 'eraser') ? 'auto' : 'none' // Allow click through if not drawing
                                        }}
                                    />
                                )}

                                {/* Markers Overlay */}
                                {markers.filter(m => m.page === pageNumber).map((marker, i) => {
                                    const popupKey = `${pageNumber}-${i}`;
                                    const isPopupActive = activePopupKey === popupKey;
                                    const optsCount = marker.optionsCount || 5;
                                    const hasAnswerHandler = !!marker.onAnswer;
                                    const markerColor = marker.color || '#ef4444';
                                    const isMarked = marker.currentAnswer !== undefined && marker.currentAnswer !== null;

                                    return (
                                        <div
                                            key={i}
                                            style={{
                                                position: 'absolute',
                                                left: `${marker.x * 100}%`,
                                                top: `${marker.y * 100}%`,
                                                transform: 'translate(-50%, -50%)',
                                                zIndex: isPopupActive ? 40 : 20,
                                            }}
                                        >
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (marker.onClick) marker.onClick();
                                                    if (hasAnswerHandler) {
                                                        setActivePopupKey(isPopupActive ? null : popupKey);
                                                    }
                                                }}
                                                style={{
                                                    width: '28px', height: '28px',
                                                    background: isMarked
                                                        ? 'linear-gradient(135deg, #4f46e5, #3730a3)'
                                                        : markerColor,
                                                    color: 'white',
                                                    borderRadius: '50%',
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontWeight: 800, fontSize: '0.78rem',
                                                    boxShadow: isPopupActive
                                                        ? '0 4px 14px rgba(0,0,0,0.45), 0 0 0 3px rgba(99,102,241,0.3)'
                                                        : '0 2px 6px rgba(0,0,0,0.3)',
                                                    border: '2px solid white',
                                                    cursor: 'pointer',
                                                    padding: 0,
                                                    transition: 'transform 0.15s, box-shadow 0.15s',
                                                    transform: isPopupActive ? 'scale(1.15)' : 'scale(1)',
                                                    fontVariantNumeric: 'tabular-nums',
                                                }}
                                                title={`문제 ${marker.label}번${isMarked ? ` · 현재: ${marker.currentAnswer}` : ''}`}
                                            >
                                                {marker.label}
                                            </button>

                                            {/* Floating OMR popup */}
                                            {isPopupActive && hasAnswerHandler && (
                                                <div
                                                    className="pdf-marker-popup"
                                                    style={{
                                                        left: '50%',
                                                        top: '-14px',
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {Array.from({ length: optsCount }, (_, j) => {
                                                        const optNum = j + 1;
                                                        const thisMarked = marker.currentAnswer === optNum;
                                                        return (
                                                            <button
                                                                key={j}
                                                                className={`pdf-popup-bubble ${thisMarked ? 'marked' : ''}`}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    marker.onAnswer?.(optNum);
                                                                    setActivePopupKey(null);
                                                                }}
                                                            >
                                                                {optNum}
                                                            </button>
                                                        );
                                                    })}
                                                    <button
                                                        className="pdf-popup-close"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setActivePopupKey(null);
                                                        }}
                                                        title="닫기"
                                                    >
                                                        ×
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </Document>
                    ) : (
                        <div onClick={() => document.getElementById('pdf-upload-input')?.click()} style={{ color: '#aaa', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', cursor: 'pointer', border: '2px dashed #666', margin: '1rem', borderRadius: '1rem' }}>
                            <FileText size={48} style={{ marginBottom: '1rem' }} />
                            <p style={{ fontWeight: 600 }}>PDF 업로드</p>
                            <p style={{ fontSize: '0.8rem', opacity: 0.7 }}>클릭하거나 파일을 드래그하세요</p>
                        </div>
                    )}
                </div>

                {/* Bottom Pagination Toolbar (Only visible if file exists) */}
                {file && (
                    <div className="pdf-viewer-bottom-toolbar" style={{
                        width: '100%',
                        padding: '0.5rem',
                        background: '#323639',
                        color: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '1rem',
                        borderTop: '1px solid #000',
                        marginTop: 'auto'
                    }}>
                        <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1} style={{ color: 'white', padding: '0.2rem 0.5rem', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', border: 'none' }}>◀ 이전</button>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input
                                type="text"
                                value={inputPage}
                                onChange={handlePageInputChange}
                                onBlur={handlePageInputSubmit}
                                onKeyDown={handlePageInputSubmit}
                                style={{ width: '30px', textAlign: 'center', background: '#222', color: 'white', border: '1px solid #555', borderRadius: '4px', padding: '2px' }}
                            />
                            / {numPages}
                        </span>
                        <button onClick={() => setPageNumber(p => Math.min(numPages, p + 1))} disabled={pageNumber >= numPages} style={{ color: 'white', padding: '0.2rem 0.5rem', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', border: 'none' }}>다음 ▶</button>
                    </div>
                )}
            </div>
        </div>
    );
}
