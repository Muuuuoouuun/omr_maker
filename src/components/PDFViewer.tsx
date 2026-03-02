"use client";

import { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Worker setup for Next.js
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
    file: File | null;
    onLoadSuccess: (numPages: number) => void;
    onPageClick?: (page: number, x: number, y: number) => void;
    onFileDrop?: (file: File) => void;
    // Drawing Props
    enableDrawing?: boolean;
    drawings?: Record<number, string[]>; // per page, array of path strings
    onDrawingsChange?: (page: number, newPaths: string[]) => void;
    // Markers Props
    markers?: { page: number; x: number; y: number; label: string | number; color?: string; onClick?: () => void }[];
}

export default function PDFViewer({
    file,
    onLoadSuccess,
    onPageClick,
    onFileDrop,
    enableDrawing = false,
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
    const [drawingMode, setDrawingMode] = useState<'pen' | 'eraser'>('pen');
    const [penColor, setPenColor] = useState('#ef4444'); // Default Red

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
        if (!enableDrawing || !canvasRef.current || !containerRef.current) return;
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
            const pathData = JSON.parse(pathStr);
            if (pathData.points && pathData.points.length > 0) {
                ctx.beginPath();
                ctx.strokeStyle = pathData.color;
                ctx.lineWidth = 2;
                ctx.moveTo(pathData.points[0].x * canvas.width, pathData.points[0].y * canvas.height);
                for (let i = 1; i < pathData.points.length; i++) {
                    ctx.lineTo(pathData.points[i].x * canvas.width, pathData.points[i].y * canvas.height);
                }
                ctx.stroke();
            }
        });

    }, [pageNumber, drawings, enableDrawing, scale, file]); // Re-render on these changes

    const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
        if (!enableDrawing || drawingMode === 'eraser') return;
        setIsDrawing(true);
        const pos = getPos(e);
        setCurrentPath([pos]);
    };

    const draw = (e: React.MouseEvent | React.TouchEvent) => {
        if (!isDrawing || !enableDrawing || !canvasRef.current) return;
        const pos = getPos(e);
        setCurrentPath(prev => [...prev, pos]);

        // Real-time visual feedback
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            const rect = canvasRef.current.getBoundingClientRect();
            ctx.lineTo(pos.x * rect.width, pos.y * rect.height);
            ctx.stroke();
            // Note: This is a hacky visual update, real render happens on useEffect usually.
            // Better: draw single segment.
            ctx.beginPath();
            const last = currentPath[currentPath.length - 1];
            if (last) ctx.moveTo(last.x * rect.width, last.y * rect.height);
            ctx.lineTo(pos.x * rect.width, pos.y * rect.height);
            ctx.strokeStyle = penColor;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    };

    const stopDrawing = () => {
        if (!isDrawing) return;
        setIsDrawing(false);

        // Save Path
        if (currentPath.length > 1 && onDrawingsChange) {
            const newPath = {
                color: penColor,
                points: currentPath
            };
            const currentPaths = drawings[pageNumber] || [];
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
                onDrawingsChange(pageNumber, []);
            }
        }
    };

    // --- End Drawing Logic ---


    function handlePageClick(event: React.MouseEvent<HTMLDivElement>) {
        // ... (Existing click logic, maybe disable if drawing?)
        if (enableDrawing && drawingMode === 'pen') return; // Don't trigger link click while drawing
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
            <div style={{ padding: '0.5rem 1rem', background: '#323639', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.9rem', borderBottom: '1px solid #000' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>{file ? file.name : 'PDF 없음'}</span>
                </div>

                {file && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {/* Drawing Tools */}
                        {enableDrawing && (
                            <div style={{ display: 'flex', gap: '5px', marginRight: '1rem', paddingRight: '1rem', borderRight: '1px solid #666' }}>
                                <button onClick={() => setDrawingMode(drawingMode === 'pen' ? 'eraser' : 'pen')} style={{ background: drawingMode === 'pen' ? '#6366f1' : 'transparent', border: '1px solid #666', borderRadius: '4px', padding: '2px 6px', color: 'white' }}>
                                    {drawingMode === 'pen' ? '✏️ 그리기' : '👆 클릭모드'}
                                </button>
                                {drawingMode === 'pen' && (
                                    <>
                                        <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)} style={{ width: '24px', height: '24px', padding: 0, border: 'none', background: 'none' }} />
                                        <button onClick={clearPage} style={{ fontSize: '0.8rem', padding: '2px 6px', background: '#ef4444', border: 'none', borderRadius: '4px', color: 'white' }}>삭제</button>
                                    </>
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
            <div ref={wrapperRef} style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#525659', position: 'relative' }}>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '2rem', width: '100%' }}>
                    {file ? (
                        <Document file={file} onLoadSuccess={onDocumentLoadSuccess} loading={<div style={{ color: 'white' }}>문서 로딩 중...</div>}>
                            <div
                                ref={containerRef}
                                onClick={handlePageClick}
                                style={{ position: 'relative', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                            >
                                <Page pageNumber={pageNumber} scale={scale} width={containerWidth > 0 ? containerWidth : undefined} renderTextLayer={true} renderAnnotationLayer={true} />{/* Canvas Overlay */}
                                {enableDrawing && (
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
                                            cursor: drawingMode === 'pen' ? 'crosshair' : 'default',
                                            pointerEvents: drawingMode === 'pen' ? 'auto' : 'none' // Allow click through if not drawing
                                        }}
                                    />
                                )}

                                {/* Markers Overlay */}
                                {markers.filter(m => m.page === pageNumber).map((marker, i) => (
                                    <div
                                        key={i}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (marker.onClick) marker.onClick();
                                        }}
                                        style={{
                                            position: 'absolute',
                                            left: `${marker.x * 100}%`,
                                            top: `${marker.y * 100}%`,
                                            transform: 'translate(-50%, -50%)',
                                            zIndex: 20,
                                            cursor: 'pointer',
                                            width: '24px', height: '24px',
                                            background: marker.color || '#ef4444',
                                            color: 'white',
                                            borderRadius: '50%',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontWeight: 'bold', fontSize: '0.75rem',
                                            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                                            border: '2px solid white'
                                        }}
                                        title={`Question ${marker.label}`}
                                    >
                                        {marker.label}
                                    </div>
                                ))}
                            </div>
                        </Document>
                    ) : (
                        <div onClick={() => document.getElementById('pdf-upload-input')?.click()} style={{ color: '#aaa', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', cursor: 'pointer', border: '2px dashed #666', margin: '1rem', borderRadius: '1rem' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📄</div>
                            <p style={{ fontWeight: 600 }}>PDF 업로드</p>
                            <p style={{ fontSize: '0.8rem', opacity: 0.7 }}>클릭하거나 파일을 드래그하세요</p>
                        </div>
                    )}
                </div>

                {/* Bottom Pagination Toolbar (Only visible if file exists) */}
                {file && (
                    <div style={{
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
