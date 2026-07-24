"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { DEFAULT_CHOICE_COUNT, normalizeChoiceCount, type PdfDrawings } from '@/types/omr';
import { toast } from '@/components/Toast';
import {
    Check,
    Eraser,
    Feather,
    FileText,
    Hand,
    Highlighter,
    MousePointer2,
    Palette,
    PenLine,
    Redo2,
    Trash2,
    Undo2,
    UploadCloud,
} from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { buildPenCursor, buildHighlighterCursor } from '@/lib/drawingCursors';
import { strokeHitTest } from '@/lib/strokeGeometry';

// Worker setup for Next.js — version the URL so a pdfjs-dist upgrade is a cache
// miss (avoids the "API version X does not match Worker version Y" hard-fail for
// returning PWA users still holding the old cache-first worker).
pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjs.version}`;

interface MarkerData {
    page: number;
    x: number;
    y: number;
    label: string | number;
    color?: string;
    kind?: 'question' | 'passage';
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
/**
 * Normalized stroke point. `p` (0..1 pointer pressure) is present only on pen
 * strokes captured from a real stylus with 필압 enabled — mouse/touch strokes
 * and legacy stored data omit it and render at constant width.
 */
type DrawPoint = { x: number; y: number; p?: number };

/** Pressure → stroke-width multiplier (p=0.5 ⇒ ×1.0, clamped to a usable range). */
function pressureScale(p: number): number {
    return 0.55 + 0.9 * Math.min(1, Math.max(0, p));
}

/** Some styluses report pressure 0 on hover/unsupported states — treat as neutral. */
function normalizePressure(pressure: number): number {
    return pressure > 0 ? Math.min(1, pressure) : 0.5;
}

/** 4 decimal places ≈ 0.1px on a 1000px page — visually lossless, but cuts the
    serialized JSON (full-precision floats dominate stroke payloads) by ~60%. */
function roundCoord(value: number): number {
    return Math.round(value * 10000) / 10000;
}

const PEN_COLORS = ['#111827', '#ef4444', '#2563eb', '#16a34a'];
const HIGHLIGHTER_COLORS = [
    'rgba(250, 204, 21, 0.38)',
    'rgba(74, 222, 128, 0.36)',
    'rgba(244, 114, 182, 0.36)',
    'rgba(96, 165, 250, 0.36)',
];
const HIGHLIGHTER_COLOR = HIGHLIGHTER_COLORS[0];
const HIGHLIGHTER_CURSOR_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa'];
const MIN_POINT_DISTANCE = 0.0012;

function isPdfUploadFile(file: File): boolean {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function formatMarkerLabel(label: string | number): string {
    const text = String(label).trim();
    return text.endsWith('.') ? text : `${text}.`;
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
    const [drawingMode, setDrawingMode] = useState<DrawingMode>('click');
    const [penColor, setPenColor] = useState('#111827'); // Default Black
    const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0]);
    const [penWidth, setPenWidth] = useState(2);
    const [highlighterWidth, setHighlighterWidth] = useState(12);
    const [eraserWidth, setEraserWidth] = useState(22);
    const [eraserMode, setEraserMode] = useState<'pixel' | 'stroke'>('stroke');
    const [fingerDrawingEnabled, setFingerDrawingEnabled] = useState(false);
    // 필압: stylus pressure varies pen stroke width (see pressureScale). On by
    // default — pressure is only ever recorded from a real pen pointer.
    const [pressureEnabled, setPressureEnabled] = useState(true);
    const [undoStack, setUndoStack] = useState<Record<number, string[][]>>({});
    const [redoStack, setRedoStack] = useState<Record<number, string[][]>>({});
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const shouldRenderDrawingLayer = enableDrawing || readOnlyDrawings;
    const canEditDrawing = enableDrawing && !readOnlyDrawings;
    const isDrawingRef = useRef(false);
    const activeDrawingModeRef = useRef<DrawingMode>('pen');
    const currentPathRef = useRef<DrawPoint[]>([]);
    // Rect is captured once per stroke (pointer-down) and reused for every pointermove,
    // so drawing never forces a synchronous layout/reflow mid-stroke.
    const activeStrokeRectRef = useRef<DOMRect | null>(null);
    const activePointerIdRef = useRef<number | null>(null);
    // Pointer type of the in-flight stroke. Read at stroke END so the
    // click→pen toolbar switch never re-renders (and re-evaluates the canvas's
    // touch-action) in the middle of the first pen stroke — that mid-stroke
    // style flip was a source of first-stroke jank on stylus devices.
    const activePointerTypeRef = useRef<string>('');
    const activeEraserModeRef = useRef<'pixel' | 'stroke'>('stroke');
    const strokeEraseBaselineRef = useRef<string[] | null>(null);
    const strokeEraseChangedRef = useRef<boolean>(false);
    const eraseDragStrokesRef = useRef<Array<{ raw: string; pts: DrawPoint[] | null; halfWidth: number }> | null>(null);
    const pendingFocusTargetRef = useRef<PdfFocusTarget | null>(null);
    // Mirrors the drawings prop, updated synchronously on every emit: commits
    // that land within the same frame (redo then an immediate stroke) must not
    // read a stale render's snapshot, or the earlier change gets overwritten.
    const latestDrawingsRef = useRef(drawings);
    useEffect(() => { latestDrawingsRef.current = drawings; }, [drawings]);
    const emitDrawingsChange = useCallback((page: number, paths: string[]) => {
        if (!onDrawingsChange) return;
        latestDrawingsRef.current = { ...latestDrawingsRef.current, [page]: paths };
        onDrawingsChange(page, paths);
    }, [onDrawingsChange]);

    // Floating OMR popup state - tracks active marker index (page + list index)
    const [activePopupKey, setActivePopupKey] = useState<string | null>(null);

    // Canvas Ref
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // Live-stroke overlay: the in-progress pen/highlighter stroke renders here
    // (cleared + redrawn as one smoothed path every frame), then commits onto
    // the main canvas on pointer-up. Drawing the live stroke segment-by-segment
    // on the main canvas doubled alpha at every joint (visible "지지직" blotches
    // with the translucent highlighter) and skipped the quadratic smoothing the
    // committed stroke gets — which is why strokes visibly "changed shape" the
    // moment the pen lifted.
    const liveCanvasRef = useRef<HTMLCanvasElement>(null);
    const eraserRingRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState<number>(0);
    const activeStrokeWidth = drawingMode === 'eraser'
        ? eraserWidth
        : drawingMode === 'highlighter'
            ? highlighterWidth
            : penWidth;
    // Live nib preview: bar height reflects the pen stroke thickness (scaled for visibility).
    const nibBarHeight = Math.max(2, Math.round(penWidth * 1.6));
    const widthControl = drawingMode !== 'click' ? (
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
    ) : null;

    const penCursor = useMemo(() => buildPenCursor(penColor), [penColor]);
    const highlighterCursor = useMemo(() => {
        const idx = HIGHLIGHTER_COLORS.indexOf(highlighterColor);
        return buildHighlighterCursor(HIGHLIGHTER_CURSOR_COLORS[idx] ?? HIGHLIGHTER_CURSOR_COLORS[0]);
    }, [highlighterColor]);
    const canvasCursor = !canEditDrawing
        ? 'default'
        : drawingMode === 'pen'
            ? penCursor
            : drawingMode === 'highlighter'
                ? highlighterCursor
                : drawingMode === 'eraser'
                    ? 'none' // ring overlay draws the eraser cursor (Task 6)
                    : 'default';

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
        const rect = activeStrokeRectRef.current ?? containerRef.current.getBoundingClientRect();
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

    // `desynchronized` lets the compositor present ink with lower latency where
    // supported; harmless elsewhere. Only the live overlay uses it — the main
    // canvas keeps default presentation for stable readback/undo redraws.
    const getLiveContext = () => {
        const live = liveCanvasRef.current;
        if (!live) return null;
        return live.getContext('2d', { desynchronized: true });
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
            const dotScale = typeof first.p === 'number' ? pressureScale(first.p) : 1;
            ctx.beginPath();
            ctx.arc(firstX, firstY, Math.max(1, (width * dotScale) / 2), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            return;
        }

        // 필압 stroke: opaque pen strokes with recorded pressure render as
        // per-segment quadratic curves so lineWidth can vary along the stroke.
        // Overlapping round caps are invisible on opaque ink, so this stays
        // artifact-free (translucent highlighter never records pressure).
        const hasPressure = mode === 'pen' && points.some(point => typeof point.p === 'number');
        if (hasPressure && points.length >= 2) {
            let prevX = firstX;
            let prevY = firstY;
            for (let i = 1; i < points.length; i++) {
                const current = points[i];
                const currentX = current.x * rect.width;
                const currentY = current.y * rect.height;
                const isLast = i === points.length - 1;
                const next = isLast ? current : points[i + 1];
                const endX = isLast ? currentX : ((current.x + next.x) / 2) * rect.width;
                const endY = isLast ? currentY : ((current.y + next.y) / 2) * rect.height;
                ctx.lineWidth = Math.max(0.5, width * pressureScale(current.p ?? 0.5));
                ctx.beginPath();
                ctx.moveTo(prevX, prevY);
                ctx.quadraticCurveTo(currentX, currentY, endX, endY);
                ctx.stroke();
                prevX = endX;
                prevY = endY;
            }
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
        if (mode === 'highlighter') return highlighterColor;
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

        // Warm + size the live-stroke overlay up front so the very first
        // pen-down doesn't pay for backing-store allocation mid-stroke.
        const liveCtx = getLiveContext();
        if (liveCanvasRef.current && liveCtx) {
            prepareCanvas(liveCanvasRef.current, liveCtx, metrics.rect, metrics.dpr);
        }

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

        // `pageRenderVersion` and `containerWidth` are essential deps: the PDF
        // page (and the container's real width) arrive AFTER mount, and nothing
        // else re-triggers this effect when the parent doesn't re-render — a
        // read-only review could otherwise keep a default-sized, blank overlay
        // and never paint the stored handwriting.
    }, [pageNumber, drawings, shouldRenderDrawingLayer, scale, file, eraserWidth, highlighterWidth, drawSmoothPath, pageRenderVersion, containerWidth]); // Re-render on these changes

    const handleUndo = useCallback(() => {
        if (!canEditDrawing || !onDrawingsChange) return;
        const pageUndo = undoStack[pageNumber] || [];
        if (pageUndo.length === 0) return; // nothing to undo

        const previousState = pageUndo[pageUndo.length - 1];
        const newUndo = pageUndo.slice(0, -1);

        // Push current state to redo stack
        const currentState = latestDrawingsRef.current[pageNumber] || [];
        setRedoStack(prev => ({
            ...prev,
            [pageNumber]: [...(prev[pageNumber] || []), currentState]
        }));

        setUndoStack(prev => ({
            ...prev,
            [pageNumber]: newUndo
        }));

        emitDrawingsChange(pageNumber, previousState);
    }, [canEditDrawing, emitDrawingsChange, onDrawingsChange, pageNumber, undoStack]);

    const handleRedo = useCallback(() => {
        if (!canEditDrawing || !onDrawingsChange) return;
        const pageRedo = redoStack[pageNumber] || [];
        if (pageRedo.length === 0) return; // nothing to redo

        const nextState = pageRedo[pageRedo.length - 1];
        const newRedo = pageRedo.slice(0, -1);

        // Push current state to undo stack
        const currentState = latestDrawingsRef.current[pageNumber] || [];
        setUndoStack(prev => ({
            ...prev,
            [pageNumber]: [...(prev[pageNumber] || []), currentState]
        }));

        setRedoStack(prev => ({
            ...prev,
            [pageNumber]: newRedo
        }));

        emitDrawingsChange(pageNumber, nextState);
    }, [canEditDrawing, emitDrawingsChange, onDrawingsChange, pageNumber, redoStack]);

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

    // Tool shortcuts: V(선택)/P(펜)/H(형광펜)/E(지우개). Plain keys only, and
    // never while typing in a field.
    useEffect(() => {
        if (!canEditDrawing) return;
        const handleToolKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            const key = e.key.toLowerCase();
            if (key === 'v') setDrawingMode('click');
            else if (key === 'p') setDrawingMode('pen');
            else if (key === 'h') setDrawingMode('highlighter');
            else if (key === 'e') setDrawingMode('eraser');
            else return;
            e.preventDefault();
        };
        window.addEventListener('keydown', handleToolKey);
        return () => window.removeEventListener('keydown', handleToolKey);
    }, [canEditDrawing]);

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

    // Parse each stored path once at the start of a stroke-erase drag. Entries with
    // pts === null (eraser masks or unparseable JSON) are never removed by stroke-erase.
    const buildEraseCache = (paths: string[]): Array<{ raw: string; pts: DrawPoint[] | null; halfWidth: number }> =>
        paths.map(raw => {
            try {
                const data = JSON.parse(raw);
                if (data.mode !== 'eraser' && Array.isArray(data.points) && data.points.length > 0) {
                    return {
                        raw,
                        pts: data.points as DrawPoint[],
                        halfWidth: typeof data.width === 'number' ? data.width / 2 : 1,
                    };
                }
            } catch {
                // fall through to a non-hittable entry
            }
            return { raw, pts: null, halfWidth: 0 };
        });

    const eraseStrokesAt = (pos: DrawPoint) => {
        if (!onDrawingsChange || !containerRef.current) return;
        const entries = eraseDragStrokesRef.current;
        if (!entries) return;
        const rect = activeStrokeRectRef.current ?? containerRef.current.getBoundingClientRect();
        const pointerX = pos.x * rect.width;
        const pointerY = pos.y * rect.height;
        const baseRadius = eraserWidth / 2;

        const kept: Array<{ raw: string; pts: DrawPoint[] | null; halfWidth: number }> = [];
        let removed = false;
        for (const entry of entries) {
            let hit = false;
            if (entry.pts) {
                const pxPts = entry.pts.map(p => ({ x: p.x * rect.width, y: p.y * rect.height }));
                hit = strokeHitTest(pointerX, pointerY, pxPts, baseRadius + entry.halfWidth);
            }
            if (hit) removed = true;
            else kept.push(entry);
        }

        if (removed) {
            eraseDragStrokesRef.current = kept;
            strokeEraseChangedRef.current = true;
            emitDrawingsChange(pageNumber, kept.map(e => e.raw));
        }
    };

    /**
     * Redraw the ENTIRE in-progress stroke on the live overlay as one smoothed
     * path. A stroke is at most a few hundred points, so a full clear+redraw
     * per frame is cheap — and it renders with exactly the geometry and alpha
     * the committed stroke will have, so nothing "snaps" on pen-up.
     */
    const renderLiveStroke = () => {
        const live = liveCanvasRef.current;
        const ctx = getLiveContext();
        const metrics = getCanvasMetrics();
        if (!live || !ctx || !metrics) return;
        prepareCanvas(live, ctx, metrics.rect, metrics.dpr);
        const mode = activeDrawingModeRef.current;
        drawSmoothPath(
            ctx,
            currentPathRef.current,
            metrics.rect,
            mode,
            getDrawingColor(mode),
            getDrawingWidth(mode),
        );
    };

    const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!shouldHandlePointer(e)) return;
        e.preventDefault();
        setActivePopupKey(null);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        activePointerIdRef.current = e.pointerId;
        activePointerTypeRef.current = e.pointerType;
        activeStrokeRectRef.current = containerRef.current?.getBoundingClientRect() ?? null;
        isDrawingRef.current = true;
        const pointerDrawingMode = drawingModeForPointer(e);
        activeDrawingModeRef.current = pointerDrawingMode;
        // NOTE: the click→pen toolbar switch is deferred to stopDrawing — a
        // setState here re-rendered (and flipped the canvas's touch-action)
        // during the first pen stroke, causing visible first-stroke jank.

        if (pointerDrawingMode === 'eraser' && eraserMode === 'stroke') {
            activeEraserModeRef.current = 'stroke';
            const baseline = latestDrawingsRef.current[pageNumber] || [];
            strokeEraseBaselineRef.current = baseline;
            eraseDragStrokesRef.current = buildEraseCache(baseline);
            strokeEraseChangedRef.current = false;
            const pos = getPos(e);
            currentPathRef.current = [pos];
            eraseStrokesAt(pos);
            return;
        }

        activeEraserModeRef.current = 'pixel';
        const capturePressure = pointerDrawingMode === 'pen' && e.pointerType === 'pen' && pressureEnabled;
        const startPos = getPos(e);
        currentPathRef.current = [capturePressure ? { ...startPos, p: normalizePressure(e.pressure) } : startPos];
        // Show the contact point immediately (a tap should leave a dot).
        if (pointerDrawingMode !== 'eraser') renderLiveStroke();
    };

    const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current || activePointerIdRef.current !== e.pointerId || !canEditDrawing || !canvasRef.current) return;
        e.preventDefault();

        if (activeDrawingModeRef.current === 'eraser' && activeEraserModeRef.current === 'stroke') {
            eraseStrokesAt(getPos(e));
            return;
        }

        // Fold in coalesced samples: browsers batch high-frequency pen input
        // (120Hz+) into one event per frame — without these, fast strokes lose
        // most of their true curvature and render angular while drawing.
        const native = e.nativeEvent;
        const coalesced = typeof native.getCoalescedEvents === "function"
            ? native.getCoalescedEvents()
            : [];
        const samples: Array<{ clientX: number; clientY: number; pressure: number }> =
            coalesced.length > 0 ? coalesced : [native];

        const path = currentPathRef.current;
        const isEraser = activeDrawingModeRef.current === 'eraser';
        const capturePressure = activeDrawingModeRef.current === 'pen'
            && activePointerTypeRef.current === 'pen'
            && pressureEnabled;
        const mainCtx = isEraser ? canvasRef.current.getContext('2d') : null;
        const metrics = isEraser ? getCanvasMetrics() : null;
        let appended = false;

        for (const sample of samples) {
            const rawPos = getPos(sample);
            const pos: DrawPoint = capturePressure
                ? { ...rawPos, p: normalizePressure(sample.pressure) }
                : rawPos;
            const last = path[path.length - 1];
            if (last && Math.hypot(pos.x - last.x, pos.y - last.y) < MIN_POINT_DISTANCE) continue;
            path.push(pos);
            appended = true;

            // The pixel eraser must apply destination-out to the MAIN canvas
            // as it moves — segment-by-segment is correct here (erasing the
            // same pixels twice is harmless, unlike double-alpha ink).
            if (isEraser && mainCtx && metrics) {
                mainCtx.save();
                mainCtx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
                drawSmoothPath(
                    mainCtx,
                    last ? [last, pos] : [pos],
                    metrics.rect,
                    'eraser',
                    getDrawingColor('eraser'),
                    getDrawingWidth('eraser'),
                );
                mainCtx.restore();
                mainCtx.globalCompositeOperation = 'source-over';
            }
        }

        if (!appended) return;
        if (!isEraser) renderLiveStroke();
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
        activeStrokeRectRef.current = null;

        if (activeDrawingModeRef.current === 'eraser' && activeEraserModeRef.current === 'stroke') {
            if (strokeEraseChangedRef.current && strokeEraseBaselineRef.current) {
                const baseline = strokeEraseBaselineRef.current;
                setUndoStack(prev => ({
                    ...prev,
                    [pageNumber]: [...(prev[pageNumber] || []), baseline],
                }));
                setRedoStack(prev => ({
                    ...prev,
                    [pageNumber]: [],
                }));
            }
            strokeEraseBaselineRef.current = null;
            eraseDragStrokesRef.current = null;
            strokeEraseChangedRef.current = false;
            currentPathRef.current = [];
            return;
        }

        const finishedPath = currentPathRef.current;
        // Save Path
        if (finishedPath.length > 0 && onDrawingsChange) {
            const pointerDrawingMode = activeDrawingModeRef.current;

            // Zero-gap handoff for ink strokes: stamp the finished stroke onto
            // the main canvas NOW (same smoothed geometry the live overlay was
            // showing), then clear the overlay. The async React effect redraw
            // that follows emitDrawingsChange repaints the identical pixels.
            if (pointerDrawingMode !== 'eraser') {
                const mainCtx = canvasRef.current?.getContext('2d');
                const metrics = getCanvasMetrics();
                if (mainCtx && metrics) {
                    mainCtx.save();
                    mainCtx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
                    drawSmoothPath(
                        mainCtx,
                        finishedPath,
                        metrics.rect,
                        pointerDrawingMode,
                        getDrawingColor(pointerDrawingMode),
                        getDrawingWidth(pointerDrawingMode),
                    );
                    mainCtx.restore();
                    mainCtx.globalCompositeOperation = 'source-over';
                    const liveCtx = getLiveContext();
                    if (liveCanvasRef.current && liveCtx) {
                        prepareCanvas(liveCanvasRef.current, liveCtx, metrics.rect, metrics.dpr);
                    }
                }
            }

            const newPath = {
                mode: pointerDrawingMode,
                color: getDrawingColor(pointerDrawingMode),
                width: getDrawingWidth(pointerDrawingMode),
                // Round on commit: full-precision floats dominate the stored
                // JSON; 4dp is visually identical (~0.1px at page scale).
                points: finishedPath.map(point => (
                    typeof point.p === 'number'
                        ? { x: roundCoord(point.x), y: roundCoord(point.y), p: Math.round(point.p * 1000) / 1000 }
                        : { x: roundCoord(point.x), y: roundCoord(point.y) }
                )),
            };
            const currentPaths = latestDrawingsRef.current[pageNumber] || [];

            // Push to Undo Stack and clear Redo Stack
            setUndoStack(prev => ({
                ...prev,
                [pageNumber]: [...(prev[pageNumber] || []), currentPaths]
            }));
            setRedoStack(prev => ({
                ...prev,
                [pageNumber]: []
            }));

            emitDrawingsChange(pageNumber, [...currentPaths, JSON.stringify(newPath)]);
        }
        currentPathRef.current = [];

        // Deferred click→pen toolbar switch (see startDrawing): now that the
        // stroke is committed, flipping mode/touch-action can't disturb it.
        if (activePointerTypeRef.current === 'pen' && drawingMode === 'click') {
            setDrawingMode('pen');
        }
    };

    const updateEraserRing = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const ring = eraserRingRef.current;
        if (!ring || !containerRef.current) return;
        const rect = activeStrokeRectRef.current ?? containerRef.current.getBoundingClientRect();
        ring.style.left = `${e.clientX - rect.left}px`;
        ring.style.top = `${e.clientY - rect.top}px`;
        ring.style.display = 'block';
    };

    const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (canEditDrawing && drawingMode === 'eraser') updateEraserRing(e);
        draw(e);
    };

    const handleCanvasPointerEnter = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (canEditDrawing && drawingMode === 'eraser') updateEraserRing(e);
    };

    const handleCanvasPointerLeave = () => {
        if (eraserRingRef.current) eraserRingRef.current.style.display = 'none';
    };

    // Accepts native PointerEvents too (coalesced events carry no React wrapper).
    const getPos = (e: { clientX: number; clientY: number }) => {
        if (!canvasRef.current) return { x: 0, y: 0 };
        const rect = activeStrokeRectRef.current ?? canvasRef.current.getBoundingClientRect();
        const normalizedX = (e.clientX - rect.left) / rect.width;
        const normalizedY = (e.clientY - rect.top) / rect.height;
        return {
            x: Math.min(1, Math.max(0, normalizedX)),
            y: Math.min(1, Math.max(0, normalizedY))
        };
    };

    const requestClearPage = () => {
        if (!onDrawingsChange) return;
        const currentPaths = latestDrawingsRef.current[pageNumber] || [];
        if (currentPaths.length === 0) {
            toast.info("삭제할 필기 없음", "현재 페이지에 저장된 필기가 없습니다.");
            return;
        }
        setClearConfirmOpen(true);
    };

    const confirmClearPage = () => {
        if (!onDrawingsChange) return;
        const currentPaths = latestDrawingsRef.current[pageNumber] || [];
        setUndoStack(prev => ({
            ...prev,
            [pageNumber]: [...(prev[pageNumber] || []), currentPaths]
        }));
        setRedoStack(prev => ({
            ...prev,
            [pageNumber]: []
        }));
        emitDrawingsChange(pageNumber, []);
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
                <div className="pdf-viewer-file" style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minWidth: 0 }}>
                    <FileText size={15} aria-hidden="true" style={{ color: file ? '#cbd5e1' : '#94a3b8', flexShrink: 0 }} />
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
                                        title="선택 (V)"
                                        aria-label="선택"
                                    >
                                        <MousePointer2 size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`pdf-tool-button has-color ${drawingMode === 'pen' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('pen')}
                                        title="펜 (P)"
                                        aria-label="펜"
                                    >
                                        <PenLine size={15} />
                                        <span className="pdf-tool-color-dot" style={{ background: penColor }} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`pdf-tool-button has-color ${drawingMode === 'highlighter' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('highlighter')}
                                        title="형광펜 (H)"
                                        aria-label="형광펜"
                                    >
                                        <Highlighter size={15} />
                                        <span className="pdf-tool-color-dot" style={{ background: highlighterColor }} />
                                    </button>
                                    <button
                                        type="button"
                                        className={`pdf-tool-button ${drawingMode === 'eraser' ? 'active' : ''}`}
                                        onClick={() => setDrawingMode('eraser')}
                                        title="지우개 (E)"
                                        aria-label="지우개"
                                    >
                                        <Eraser size={15} />
                                    </button>
                                </div>

                                {drawingMode === 'eraser' && (
                                    <div
                                        role="group"
                                        aria-label="지우개 방식"
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            height: 32,
                                            border: '1px solid #555',
                                            borderRadius: 8,
                                            overflow: 'hidden',
                                            flex: '0 0 auto',
                                        }}
                                    >
                                        {(['pixel', 'stroke'] as const).map((mode, idx) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                className="pdf-seg-button"
                                                onClick={() => setEraserMode(mode)}
                                                aria-pressed={eraserMode === mode}
                                                aria-label={mode === 'stroke' ? '획 지우기: 닿은 획 전체 삭제' : '부분 지우기'}
                                                title={mode === 'stroke' ? '획 지우기 (닿은 획 전체 삭제)' : '부분 지우기'}
                                                style={{
                                                    height: 32,
                                                    padding: '0 0.6rem',
                                                    fontSize: '0.72rem',
                                                    fontWeight: 800,
                                                    color: 'white',
                                                    background: eraserMode === mode ? '#4f46e5' : '#222',
                                                    border: 'none',
                                                    borderLeft: idx === 0 ? 'none' : '1px solid #555',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                {mode === 'stroke' ? '획' : '부분'}
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {drawingMode === 'pen' && (
                                    <div className="pdf-pen-group" role="group" aria-label="펜 옵션">
                                        <div className="pdf-color-swatches" aria-label="펜 색상">
                                            {PEN_COLORS.map(color => (
                                                <button
                                                    key={color}
                                                    type="button"
                                                    className={`pdf-color-swatch ${penColor === color ? 'active' : ''}`}
                                                    onClick={() => setPenColor(color)}
                                                    title={`펜 색상 ${color}`}
                                                    aria-label={`펜 색상 ${color}`}
                                                    aria-pressed={penColor === color}
                                                    style={{ background: color }}
                                                >
                                                    {penColor === color && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                                                </button>
                                            ))}
                                            <label className="pdf-color-custom" title="원하는 색 선택">
                                                <input
                                                    type="color"
                                                    value={penColor}
                                                    onChange={(e) => setPenColor(e.target.value)}
                                                    aria-label="원하는 색 직접 선택"
                                                />
                                                <span className="pdf-color-custom-inner" aria-hidden="true">
                                                    <Palette size={12} strokeWidth={2.25} />
                                                </span>
                                            </label>
                                        </div>
                                        <span className="pdf-pen-group-divider" aria-hidden="true" />
                                        <span className="pdf-nib-preview" title="펜 미리보기" aria-hidden="true">
                                            <span className="pdf-nib-bar" style={{ background: penColor, height: `${nibBarHeight}px`, boxShadow: `0 0 6px ${penColor}80` }} />
                                        </span>
                                        {widthControl}
                                        <button
                                            type="button"
                                            className={`pdf-tool-button ${pressureEnabled ? 'active' : ''}`}
                                            onClick={() => setPressureEnabled(value => !value)}
                                            title={pressureEnabled ? "필압 켜짐 · 펜 압력에 따라 굵기 변화" : "필압 꺼짐 · 일정한 굵기"}
                                            aria-label={pressureEnabled ? "필압 끄기" : "필압 켜기"}
                                            aria-pressed={pressureEnabled}
                                        >
                                            <Feather size={15} />
                                        </button>
                                    </div>
                                )}

                                {drawingMode === 'highlighter' && (
                                    <div className="pdf-pen-group" role="group" aria-label="형광펜 옵션">
                                        <div className="pdf-color-swatches" aria-label="형광펜 색상">
                                            {HIGHLIGHTER_COLORS.map((color, idx) => (
                                                <button
                                                    key={color}
                                                    type="button"
                                                    className={`pdf-color-swatch ${highlighterColor === color ? 'active' : ''}`}
                                                    onClick={() => setHighlighterColor(color)}
                                                    title={`형광펜 색상 ${idx + 1}`}
                                                    aria-label={`형광펜 색상 ${idx + 1}`}
                                                    aria-pressed={highlighterColor === color}
                                                    style={{ background: HIGHLIGHTER_CURSOR_COLORS[idx] ?? HIGHLIGHTER_CURSOR_COLORS[0] }}
                                                >
                                                    {highlighterColor === color && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                                                </button>
                                            ))}
                                        </div>
                                        <span className="pdf-pen-group-divider" aria-hidden="true" />
                                        {widthControl}
                                    </div>
                                )}

                                {drawingMode === 'eraser' && widthControl}

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
            {/* "safe center": plain center clips the left edge of content wider
                than the pane (left overflow is unreachable by scrolling). */}
            <div ref={wrapperRef} className="pdf-viewer-scroll scroll-custom" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'safe center', background: '#525659', position: 'relative' }}>
                <div className="pdf-viewer-page-wrap" style={{ flex: 1, display: 'flex', justifyContent: 'safe center', padding: '2rem', width: '100%' }}>
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
                                        data-testid="pdf-draw-overlay"
                                        onPointerDown={startDrawing}
                                        onPointerMove={handleCanvasPointerMove}
                                        onPointerUp={stopDrawing}
                                        onPointerCancel={stopDrawing}
                                        onPointerEnter={handleCanvasPointerEnter}
                                        onPointerLeave={handleCanvasPointerLeave}
                                        style={{
                                            position: 'absolute',
                                            top: 0, left: 0,
                                            width: '100%', height: '100%',
                                            zIndex: 10,
                                            cursor: canvasCursor,
                                            pointerEvents: canEditDrawing ? 'auto' : 'none',
                                            touchAction: fingerDrawingEnabled && drawingMode !== 'click' ? 'none' : 'pan-x pan-y pinch-zoom'
                                        }}
                                    />
                                )}
                                {/* Live-stroke overlay: input passes through to the
                                    main canvas below; this layer only displays the
                                    in-progress stroke (see renderLiveStroke). */}
                                {canEditDrawing && (
                                    <canvas
                                        ref={liveCanvasRef}
                                        data-testid="pdf-draw-live-overlay"
                                        aria-hidden="true"
                                        style={{
                                            position: 'absolute',
                                            top: 0, left: 0,
                                            width: '100%', height: '100%',
                                            zIndex: 11,
                                            pointerEvents: 'none',
                                        }}
                                    />
                                )}

                                {canEditDrawing && drawingMode === 'eraser' && (
                                    <div
                                        ref={eraserRingRef}
                                        data-testid="pdf-eraser-ring"
                                        aria-hidden="true"
                                        style={{
                                            position: 'absolute',
                                            left: 0,
                                            top: 0,
                                            width: `${eraserWidth}px`,
                                            height: `${eraserWidth}px`,
                                            transform: 'translate(-50%, -50%)',
                                            borderRadius: '50%',
                                            border: eraserMode === 'stroke'
                                                ? '1.5px dashed rgba(239,68,68,0.95)'
                                                : '1.5px solid rgba(255,255,255,0.95)',
                                            boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
                                            pointerEvents: 'none',
                                            zIndex: 15,
                                            display: 'none',
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
                                    const regionBackground = marker.kind === 'passage'
                                        ? 'rgba(15,118,110,0.09)'
                                        : markerColor === '#6366f1'
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
                                                    title={marker.kind === 'passage' ? `공통 지문 영역 ${marker.label}` : `문항 영역 ${marker.label}번`}
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
                                                        width: 'auto',
                                                        minWidth: '20px',
                                                        height: '22px',
                                                        padding: '0 4px',
                                                        background: 'rgba(255,255,255,0.92)',
                                                        color: isMarked ? '#4f46e5' : markerColor,
                                                        borderRadius: '5px',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontWeight: 900, fontSize: '0.76rem',
                                                        boxShadow: isPopupActive
                                                            ? '0 3px 12px rgba(0,0,0,0.32), 0 0 0 3px rgba(99,102,241,0.24)'
                                                            : '0 1px 5px rgba(0,0,0,0.22)',
                                                        border: `1px solid ${isMarked ? '#4f46e5' : markerColor}`,
                                                        cursor: 'pointer',
                                                        transition: 'transform 0.15s, box-shadow 0.15s',
                                                        transform: isPopupActive ? 'scale(1.06)' : 'scale(1)',
                                                        fontVariantNumeric: 'tabular-nums',
                                                    }}
                                                    title={marker.kind === 'passage'
                                                        ? `공통 지문 ${marker.label}`
                                                        : `문제 ${marker.label}번${isMarked ? ` · 현재: ${marker.currentAnswer}` : ''}`}
                                                >
                                                    {formatMarkerLabel(marker.label)}
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
                        <div
                            className="pdf-upload-empty"
                            onClick={() => document.getElementById('pdf-upload-input')?.click()}
                        >
                            <div className="pdf-upload-empty-icon">
                                <UploadCloud size={30} aria-hidden="true" />
                            </div>
                            <p>PDF 업로드</p>
                            <span>클릭하거나 파일을 드래그하세요</span>
                            <strong>문제지 · 정답지 PDF</strong>
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
