"use client";

import { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { DEFAULT_CHOICE_COUNT, normalizeChoiceCount, type PdfDrawings } from '@/types/omr';
import { toast } from '@/components/Toast';
import {
    Eraser,
    FileText,
    Hand,
    Highlighter,
    MousePointer2,
    PenLine,
    Redo2,
    Trash2,
    Undo2,
} from 'lucide-react';
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
    region?: MarkerRegion;
    onClick?: () => void;
    // Floating OMR popup support
    questionId?: number;
    currentAnswer?: number;
    onAnswer?: (option: number) => void;
    optionsCount?: number;
}

interface MarkerRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface PdfFocusTarget {
    page: number;
    x: number;
    y: number;
    key?: string | number;
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
    forcePage?: number;
    focusTarget?: PdfFocusTarget | null;
}

type DrawingMode = 'click' | 'pen' | 'highlighter' | 'eraser';
type DrawPoint = { x: number; y: number };

const PEN_COLORS = ['#ef4444', '#111827', '#2563eb', '#16a34a'];
const HIGHLIGHTER_COLOR = 'rgba(250, 204, 21, 0.38)';
const MIN_POINT_DISTANCE = 0.0012;

function isPdfUploadFile(file: File): boolean {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
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
    forcePage,
    focusTarget,
}: PDFViewerProps) {
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState<number>(1);
    const [inputPage, setInputPage] = useState<string>("1");
    const [scale, setScale] = useState<number>(1.0);
    const [isDragging, setIsDragging] = useState(false);
    const [pageRenderVersion, setPageRenderVersion] = useState(0);

    // Drawing State
    const [, setIsDrawing] = useState(false);
    const [drawingMode, setDrawingMode] = useState<DrawingMode>('click');
    const [penColor, setPenColor] = useState('#ef4444'); // Default Red
    const [penWidth, setPenWidth] = useState(2);
    const [highlighterWidth, setHighlighterWidth] = useState(12);
    const [eraserWidth, setEraserWidth] = useState(22);
    const [fingerDrawingEnabled, setFingerDrawingEnabled] = useState(false);
    const [undoStack, setUndoStack] = useState<Record<number, string[][]>>({});
    const [redoStack, setRedoStack] = useState<Record<number, string[][]>>({});
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const shouldRenderDrawingLayer = enableDrawing || readOnlyDrawings;
    const canEditDrawing = enableDrawing && !readOnlyDrawings;
    const isDrawingRef = useRef(false);
    const activeDrawingModeRef = useRef<DrawingMode>('pen');
    const currentPathRef = useRef<DrawPoint[]>([]);
    const activePointerIdRef = useRef<number | null>(null);
    const pendingFocusTargetRef = useRef<PdfFocusTarget | null>(null);

    // Floating OMR popup state - tracks active marker index (page + list index)
    const [activePopupKey, setActivePopupKey] = useState<string | null>(null);

    // Canvas Ref
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState<number>(0);
    const activeStrokeWidth = drawingMode === 'eraser'
        ? eraserWidth
        : drawingMode === 'highlighter'
            ? highlighterWidth
            : penWidth;

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
        setNumPages(0);
        setPageNumber(1);
        setInputPage("1");
        setActivePopupKey(null);
    }, [file]);

    useEffect(() => {
        if (typeof forcePage === 'number' && forcePage >= 1 && forcePage <= numPages) {
            setPageNumber(forcePage);
        }
    }, [forcePage, numPages]);

    useEffect(() => {
        if (!focusTarget) return;
        if (focusTarget.page < 1 || (numPages > 0 && focusTarget.page > numPages)) return;
        pendingFocusTargetRef.current = focusTarget;
        setActivePopupKey(null);
        setPageNumber(focusTarget.page);
    }, [focusTarget, numPages]);

    useEffect(() => {
        const target = pendingFocusTargetRef.current;
        if (!target || target.page !== pageNumber) return;

        let firstFrame = 0;
        let secondFrame = 0;
        firstFrame = window.requestAnimationFrame(() => {
            secondFrame = window.requestAnimationFrame(() => {
                const wrapper = wrapperRef.current;
                const page = containerRef.current;
                if (!wrapper || !page || page.offsetWidth === 0 || page.offsetHeight === 0) return;

                const x = Math.min(1, Math.max(0, target.x));
                const y = Math.min(1, Math.max(0, target.y));
                const left = page.offsetLeft + page.offsetWidth * x - wrapper.clientWidth / 2;
                const top = page.offsetTop + page.offsetHeight * y - wrapper.clientHeight / 2;

                wrapper.scrollTo({
                    left: Math.max(0, left),
                    top: Math.max(0, top),
                    behavior: 'smooth',
                });
                pendingFocusTargetRef.current = null;
            });
        });

        return () => {
            window.cancelAnimationFrame(firstFrame);
            window.cancelAnimationFrame(secondFrame);
        };
    }, [pageNumber, scale, containerWidth, file, focusTarget, pageRenderVersion]);

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

    const getCanvasMetrics = () => {
        if (!canvasRef.current || !containerRef.current) return null;
        const rect = containerRef.current.getBoundingClientRect();
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        return { rect, dpr };
    };

    const prepareCanvas = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, rect: DOMRect, dpr: number) => {
        const nextWidth = Math.max(1, Math.round(rect.width * dpr));
        const nextHeight = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
            canvas.width = nextWidth;
            canvas.height = nextHeight;
        }
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
    };

    const applyStrokeStyle = useCallback((
        ctx: CanvasRenderingContext2D,
        mode: DrawingMode,
        color: string,
        width: number,
    ) => {
        const isEraser = mode === 'eraser';
        ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
        ctx.strokeStyle = isEraser ? 'rgba(0,0,0,1)' : color;
        ctx.fillStyle = isEraser ? 'rgba(0,0,0,1)' : color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }, []);

    const drawSmoothPath = useCallback((
        ctx: CanvasRenderingContext2D,
        points: DrawPoint[],
        rect: DOMRect,
        mode: DrawingMode,
        color: string,
        width: number,
    ) => {
        if (points.length === 0) return;
        applyStrokeStyle(ctx, mode, color, width);

        const first = points[0];
        const firstX = first.x * rect.width;
        const firstY = first.y * rect.height;

        if (points.length === 1) {
            ctx.beginPath();
            ctx.arc(firstX, firstY, Math.max(1, width / 2), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            return;
        }

        ctx.beginPath();
        ctx.moveTo(firstX, firstY);
        for (let i = 1; i < points.length - 1; i++) {
            const current = points[i];
            const next = points[i + 1];
            const currentX = current.x * rect.width;
            const currentY = current.y * rect.height;
            const midX = ((current.x + next.x) / 2) * rect.width;
            const midY = ((current.y + next.y) / 2) * rect.height;
            ctx.quadraticCurveTo(currentX, currentY, midX, midY);
        }

        const last = points[points.length - 1];
        ctx.lineTo(last.x * rect.width, last.y * rect.height);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
    }, [applyStrokeStyle]);

    const getDrawingColor = (mode: DrawingMode) => {
        if (mode === 'highlighter') return HIGHLIGHTER_COLOR;
        if (mode === 'eraser') return 'rgba(0,0,0,1)';
        return penColor;
    };

    const getDrawingWidth = (mode: DrawingMode) => {
        if (mode === 'eraser') return eraserWidth;
        if (mode === 'highlighter') return highlighterWidth;
        return penWidth;
    };

    // Render existing paths when page or drawings change
    useEffect(() => {
        if (!shouldRenderDrawingLayer || !canvasRef.current || !containerRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Resize canvas to match container (vital for scaling)
        const metrics = getCanvasMetrics();
        if (!metrics) return;
        prepareCanvas(canvas, ctx, metrics.rect, metrics.dpr);

        // Draw saved paths
        const paths = drawings[pageNumber] || [];
        paths.forEach(pathStr => {
            try {
                const pathData = JSON.parse(pathStr);
                if (pathData.points && pathData.points.length > 0) {
                    const mode = (pathData.mode || 'pen') as DrawingMode;
                    const color = pathData.color || (mode === 'highlighter' ? HIGHLIGHTER_COLOR : '#ef4444');
                    const width = pathData.width || (mode === 'eraser' ? eraserWidth : mode === 'highlighter' ? highlighterWidth : 2);
                    drawSmoothPath(ctx, pathData.points, metrics.rect, mode, color, width);
                }
            } catch (err) {
                console.error("Failed to parse path JSON", err);
            }
        });

        // Reset globalCompositeOperation to default
        ctx.globalCompositeOperation = 'source-over';

    }, [pageNumber, drawings, shouldRenderDrawingLayer, scale, file, eraserWidth, highlighterWidth, drawSmoothPath]); // Re-render on these changes

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

    const drawingModeForPointer = (e: React.PointerEvent<HTMLCanvasElement>): DrawingMode => {
        if (e.pointerType === 'pen' && drawingMode === 'click') return 'pen';
        return drawingMode;
    };

    const shouldHandlePointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!canEditDrawing) return false;
        const pointerDrawingMode = drawingModeForPointer(e);
        if (pointerDrawingMode === 'click') return false;
        if (e.pointerType === 'mouse' && e.button !== 0) return false;
        if (e.pointerType === 'touch' && !fingerDrawingEnabled) return false;
        return true;
    };

    const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!shouldHandlePointer(e)) return;
        e.preventDefault();
        setActivePopupKey(null);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        activePointerIdRef.current = e.pointerId;
        isDrawingRef.current = true;
        setIsDrawing(true);
        const pointerDrawingMode = drawingModeForPointer(e);
        activeDrawingModeRef.current = pointerDrawingMode;
        if (e.pointerType === 'pen' && drawingMode === 'click') setDrawingMode('pen');
        currentPathRef.current = [getPos(e)];
    };

    const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current || activePointerIdRef.current !== e.pointerId || !canEditDrawing || !canvasRef.current) return;
        e.preventDefault();

        const pos = getPos(e);
        const path = currentPathRef.current;
        const last = path[path.length - 1];
        if (last && Math.hypot(pos.x - last.x, pos.y - last.y) < MIN_POINT_DISTANCE) return;

        currentPathRef.current = [...path, pos];

        // Real-time visual feedback drawing segment-by-segment
        const ctx = canvasRef.current.getContext('2d');
        const metrics = getCanvasMetrics();
        if (ctx && metrics) {
            const pointerDrawingMode = activeDrawingModeRef.current;
            ctx.save();
            ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
            drawSmoothPath(
                ctx,
                last ? [last, pos] : [pos],
                metrics.rect,
                pointerDrawingMode,
                getDrawingColor(pointerDrawingMode),
                getDrawingWidth(pointerDrawingMode),
            );
            ctx.restore();
            ctx.globalCompositeOperation = 'source-over';
        }
    };

    const stopDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current) return;
        if (e && activePointerIdRef.current !== e.pointerId) return;
        e?.preventDefault();
        if (e && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
        }

        isDrawingRef.current = false;
        activePointerIdRef.current = null;
        setIsDrawing(false);

        const finishedPath = currentPathRef.current;
        // Save Path
        if (finishedPath.length > 0 && onDrawingsChange) {
            const pointerDrawingMode = activeDrawingModeRef.current;
            const newPath = {
                mode: pointerDrawingMode,
                color: getDrawingColor(pointerDrawingMode),
                width: getDrawingWidth(pointerDrawingMode),
                points: finishedPath
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
        currentPathRef.current = [];
    };

    const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!canvasRef.current) return { x: 0, y: 0 };
        const rect = canvasRef.current.getBoundingClientRect();
        const normalizedX = (e.clientX - rect.left) / rect.width;
        const normalizedY = (e.clientY - rect.top) / rect.height;
        return {
            x: Math.min(1, Math.max(0, normalizedX)),
            y: Math.min(1, Math.max(0, normalizedY))
        };
    };

    const requestClearPage = () => {
        if (!onDrawingsChange) return;
        const currentPaths = drawings[pageNumber] || [];
        if (currentPaths.length === 0) {
            toast.info("삭제할 필기 없음", "현재 페이지에 저장된 필기가 없습니다.");
            return;
        }
        setClearConfirmOpen(true);
    };

    const confirmClearPage = () => {
        if (!onDrawingsChange) return;
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
        setClearConfirmOpen(false);
        toast.success("필기 삭제됨", "현재 페이지의 필기를 지웠습니다.");
    };

    // --- End Drawing Logic ---


    function handlePageClick(event: React.MouseEvent<HTMLDivElement>) {
        // ... (Existing click logic, maybe disable if drawing?)
        if (canEditDrawing && drawingMode !== 'click') return; // Don't trigger link click while drawing
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
        if (onFileDrop && e.dataTransfer.files[0] && isPdfUploadFile(e.dataTransfer.files[0])) {
            onFileDrop(e.dataTransfer.files[0]);
        } else {
            toast.error("PDF 파일만 업로드 가능", "문제지 또는 정답지는 PDF 형식으로 올려주세요.");
        }
    };

    const handleDocumentLoadError = (error: Error) => {
        console.error("PDF load failed", error);
        toast.error("PDF 열기 실패", "파일이 손상되었거나 브라우저에서 읽을 수 없는 PDF입니다.");
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
                            <div className="pdf-viewer-drawing-tools">
                                <div className="pdf-tool-group" role="toolbar" aria-label="PDF 필기 도구">
                                    <button
                                        type="button"
                                        className={`pdf-tool-button ${drawingMode === 'click' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('click')}
                                        title="선택"
                                        aria-label="선택"
                                    >
                                        <MousePointer2 size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`pdf-tool-button ${drawingMode === 'pen' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('pen')}
                                        title="펜"
                                        aria-label="펜"
                                    >
                                        <PenLine size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`pdf-tool-button ${drawingMode === 'highlighter' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('highlighter')}
                                        title="형광펜"
                                        aria-label="형광펜"
                                    >
                                        <Highlighter size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`pdf-tool-button ${drawingMode === 'eraser' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('eraser')}
                                        title="지우개"
                                        aria-label="지우개"
                                    >
                                        <Eraser size={15} />
                                    </button>
                                </div>

                                {drawingMode === 'pen' && (
                                    <div className="pdf-color-swatches" aria-label="펜 색상">
                                        {PEN_COLORS.map(color => (
                                            <button
                                                key={color}
                                                type="button"
                                                className={`pdf-color-swatch ${penColor === color ? 'active' : ''}`}
                                                onClick={() => setPenColor(color)}
                                                title={`펜 색상 ${color}`}
                                                aria-label={`펜 색상 ${color}`}
                                                style={{ background: color }}
                                            />
                                        ))}
                                        <input
                                            className="pdf-color-input"
                                            type="color"
                                            value={penColor}
                                            onChange={(e) => setPenColor(e.target.value)}
                                            title="펜 색상 직접 선택"
                                            aria-label="펜 색상 직접 선택"
                                        />
                                    </div>
                                )}

                                {drawingMode !== 'click' && (
                                    <label className="pdf-width-control" title="굵기">
                                        <span>{activeStrokeWidth}px</span>
                                        <input
                                            type="range"
                                            min={drawingMode === 'pen' ? 1 : 6}
                                            max={drawingMode === 'eraser' ? 42 : drawingMode === 'highlighter' ? 24 : 8}
                                            value={activeStrokeWidth}
                                            onChange={(e) => {
                                                const next = Number(e.target.value);
                                                if (drawingMode === 'eraser') setEraserWidth(next);
                                                else if (drawingMode === 'highlighter') setHighlighterWidth(next);
                                                else setPenWidth(next);
                                            }}
                                            aria-label="필기 굵기"
                                        />
                                    </label>
                                )}

                                <button
                                    type="button"
                                    className={`pdf-tool-button ${fingerDrawingEnabled ? 'active' : ''}`}
                                    onClick={() => setFingerDrawingEnabled(value => !value)}
                                    title={fingerDrawingEnabled ? "손가락 필기 켜짐" : "손가락 필기 꺼짐"}
                                    aria-label={fingerDrawingEnabled ? "손가락 필기 끄기" : "손가락 필기 켜기"}
                                    aria-pressed={fingerDrawingEnabled}
                                >
                                    <Hand size={15} />
                                </button>

                                <div className="pdf-tool-divider" />

                                <button
                                    type="button"
                                    className="pdf-tool-button"
                                    onClick={handleUndo}
                                    disabled={!(undoStack[pageNumber] && undoStack[pageNumber].length > 0)}
                                    title="실행 취소 (Cmd/Ctrl+Z)"
                                    aria-label="실행 취소"
                                >
                                    <Undo2 size={15} />
                                </button>
                                <button
                                    type="button"
                                    className="pdf-tool-button"
                                    onClick={handleRedo}
                                    disabled={!(redoStack[pageNumber] && redoStack[pageNumber].length > 0)}
                                    title="다시 실행 (Cmd/Ctrl+Y)"
                                    aria-label="다시 실행"
                                >
                                    <Redo2 size={15} />
                                </button>
                                <button
                                    type="button"
                                    className="pdf-tool-button danger"
                                    onClick={requestClearPage}
                                    title="이 페이지의 모든 필기 삭제"
                                    aria-label="이 페이지의 모든 필기 삭제"
                                >
                                    <Trash2 size={15} />
                                </button>
                                {clearConfirmOpen && (
                                    <div
                                        role="alertdialog"
                                        aria-label="필기 삭제 확인"
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.35rem',
                                            padding: '0.25rem',
                                            borderRadius: 8,
                                            background: 'rgba(15,23,42,0.92)',
                                            border: '1px solid rgba(255,255,255,0.16)',
                                            boxShadow: '0 8px 18px rgba(0,0,0,0.22)',
                                        }}
                                    >
                                        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'white', whiteSpace: 'nowrap', padding: '0 0.3rem' }}>
                                            이 페이지 필기 삭제?
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setClearConfirmOpen(false)}
                                            style={{ color: '#cbd5e1', fontSize: '0.72rem', fontWeight: 700, padding: '0.25rem 0.45rem' }}
                                        >
                                            취소
                                        </button>
                                        <button
                                            type="button"
                                            onClick={confirmClearPage}
                                            style={{ color: 'white', background: '#ef4444', borderRadius: 6, fontSize: '0.72rem', fontWeight: 800, padding: '0.25rem 0.5rem' }}
                                        >
                                            삭제
                                        </button>
                                    </div>
                                )}
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
            <div ref={wrapperRef} className="pdf-viewer-scroll scroll-custom" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#525659', position: 'relative' }}>
                <div className="pdf-viewer-page-wrap" style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '2rem', width: '100%' }}>
                    {file ? (
                        <Document
                            file={file}
                            onLoadSuccess={onDocumentLoadSuccess}
                            onLoadError={handleDocumentLoadError}
                            loading={<div style={{ color: 'white' }}>문서 로딩 중...</div>}
                            error={<div style={{ color: 'white', fontWeight: 700 }}>PDF를 열 수 없습니다.</div>}
                        >
                            <div
                                ref={containerRef}
                                onClick={handlePageClick}
                                style={{ position: 'relative', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                            >
                                <Page
                                    pageNumber={pageNumber}
                                    scale={scale}
                                    width={containerWidth > 0 ? containerWidth : undefined}
                                    renderTextLayer={true}
                                    renderAnnotationLayer={true}
                                    onRenderSuccess={() => setPageRenderVersion(value => value + 1)}
                                />{/* Canvas Overlay */}
                                {shouldRenderDrawingLayer && (
                                    <canvas
                                        ref={canvasRef}
                                        onPointerDown={startDrawing}
                                        onPointerMove={draw}
                                        onPointerUp={stopDrawing}
                                        onPointerCancel={stopDrawing}
                                        style={{
                                            position: 'absolute',
                                            top: 0, left: 0,
                                            width: '100%', height: '100%',
                                            zIndex: 10,
                                            cursor: canEditDrawing ? (drawingMode === 'pen' || drawingMode === 'highlighter' ? 'crosshair' : drawingMode === 'eraser' ? 'cell' : 'default') : 'default',
                                            pointerEvents: canEditDrawing ? 'auto' : 'none',
                                            touchAction: fingerDrawingEnabled ? 'none' : 'pan-x pan-y pinch-zoom'
                                        }}
                                    />
                                )}

                                {/* Markers Overlay */}
                                {markers.filter(m => m.page === pageNumber).map((marker, i) => {
                                    const popupKey = `${pageNumber}-${i}`;
                                    const isPopupActive = activePopupKey === popupKey;
                                    const optsCount = normalizeChoiceCount(marker.optionsCount, DEFAULT_CHOICE_COUNT);
                                    const hasAnswerHandler = !!marker.onAnswer;
                                    const markerColor = marker.color || '#ef4444';
                                    const isMarked = marker.currentAnswer !== undefined && marker.currentAnswer !== null;
                                    const regionBackground = markerColor === '#6366f1'
                                        ? 'rgba(99,102,241,0.1)'
                                        : 'rgba(239,68,68,0.07)';

                                    return (
                                        <div
                                            key={i}
                                            style={{
                                                position: 'absolute',
                                                inset: 0,
                                                zIndex: isPopupActive ? 40 : 20,
                                                pointerEvents: 'none',
                                            }}
                                        >
                                            {marker.region && (
                                                <div
                                                    aria-hidden="true"
                                                    title={`문항 영역 ${marker.label}번`}
                                                    style={{
                                                        position: 'absolute',
                                                        left: `${marker.region.x * 100}%`,
                                                        top: `${marker.region.y * 100}%`,
                                                        width: `${marker.region.width * 100}%`,
                                                        height: `${marker.region.height * 100}%`,
                                                        border: `2px solid ${markerColor}`,
                                                        background: regionBackground,
                                                        borderRadius: 6,
                                                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.55)',
                                                    }}
                                                />
                                            )}

                                            <div
                                                style={{
                                                    position: 'absolute',
                                                    left: `${marker.x * 100}%`,
                                                    top: `${marker.y * 100}%`,
                                                    transform: 'translate(-50%, -50%)',
                                                    pointerEvents: 'auto',
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
