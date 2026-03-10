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
    markers?: { page: number; x: number; y: number; w?: number; h?: number; label: string | number; color?: string; type?: 'question' | 'choice'; onClick?: () => void }[];
    viewerMode?: 'teacher' | 'student';
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
    forcePage,
    viewerMode = 'teacher'
}: PDFViewerProps & { forcePage?: number }) {
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState<number>(1);
    const [inputPage, setInputPage] = useState<string>("1");
    const [scale, setScale] = useState<number>(1.0);
    const [isDragging, setIsDragging] = useState(false);

    // Drawing State
    const [isDrawing, setIsDrawing] = useState(false);
    const [currentPath, setCurrentPath] = useState<{ x: number, y: number }[]>([]);
    const [drawingMode, setDrawingMode] = useState<'pen' | 'eraser' | 'pan'>('pan'); // Default pan for student
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
        if (!enableDrawing) return;
        if (drawingMode === 'eraser' || drawingMode === 'pan') return;
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

    // Drag to Pan Logic
    const panState = useRef({ isDragging: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });

    const handleWrapperPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (drawingMode !== 'pan') return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        panState.current = {
            isDragging: true,
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: wrapper.scrollLeft,
            scrollTop: wrapper.scrollTop
        };
        wrapper.style.cursor = 'grabbing';
    };

    const handleWrapperPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!panState.current.isDragging || drawingMode !== 'pan') return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const dx = e.clientX - panState.current.startX;
        const dy = e.clientY - panState.current.startY;
        wrapper.scrollLeft = panState.current.scrollLeft - dx;
        wrapper.scrollTop = panState.current.scrollTop - dy;
    }

    const handleWrapperPointerUp = () => {
        if (drawingMode !== 'pan') return;
        panState.current.isDragging = false;
        if (wrapperRef.current) {
            wrapperRef.current.style.cursor = 'grab';
        }
    }

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
                background: viewerMode === 'teacher' ? '#525659' : '#f8fafc',
                borderRight: viewerMode === 'teacher' ? '1px solid #333' : 'none',
                position: 'relative', overflow: 'hidden'
            }}
        >
            {/* ... Drag Overlay ... */}
            {isDragging && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(99, 102, 241, 0.2)', border: '3px dashed #6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold', fontSize: '1.5rem', backdropFilter: 'blur(4px)' }}>PDF 파일을 여기에 놓으세요</div>
            )}

            {/* Teacher Top Toolbar */}
            {viewerMode === 'teacher' && (
                <div style={{ padding: '0.5rem 1rem', background: '#323639', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.9rem', borderBottom: '1px solid #000' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>{file ? file.name : 'PDF 없음'}</span>
                    </div>

                    {file && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {/* Drawing Tools */}
                            {enableDrawing && (
                                <div style={{ display: 'flex', gap: '5px', marginRight: '1rem', paddingRight: '1rem', borderRight: '1px solid #666' }}>
                                    <button onClick={() => setDrawingMode('pen')} style={{ background: drawingMode === 'pen' ? '#6366f1' : 'transparent', border: '1px solid #666', borderRadius: '4px', padding: '2px 6px', color: 'white' }}>
                                        ✏️ 그리기
                                    </button>
                                    <button onClick={() => setDrawingMode('pan')} style={{ background: drawingMode === 'pan' ? '#6366f1' : 'transparent', border: '1px solid #666', borderRadius: '4px', padding: '2px 6px', color: 'white' }}>
                                        🖐 이동
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
                            <button onClick={() => setScale(s => Math.max(0.5, s - 0.1))} style={{ color: 'white', cursor: 'pointer', padding: '0 5px', background: 'transparent', border: 'none' }}>-</button>
                            <span>{Math.round(scale * 100)}%</span>
                            <button onClick={() => setScale(s => Math.min(2.5, s + 0.1))} style={{ color: 'white', cursor: 'pointer', padding: '0 5px', background: 'transparent', border: 'none' }}>+</button>
                        </div>
                    )}
                </div>
            )}

            {/* PDF Content */}
            <div
                ref={wrapperRef}
                onPointerDown={handleWrapperPointerDown}
                onPointerMove={handleWrapperPointerMove}
                onPointerUp={handleWrapperPointerUp}
                onPointerLeave={handleWrapperPointerUp}
                style={{
                    flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center',
                    background: viewerMode === 'teacher' ? '#525659' : '#f1f5f9',
                    position: 'relative',
                    cursor: drawingMode === 'pan' ? 'grab' : 'default',
                    touchAction: drawingMode === 'pan' ? 'none' : 'auto', // disable pull to refresh on pan
                    paddingBottom: viewerMode === 'student' ? '120px' : '0' // Room for floating toolbar
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'center', padding: viewerMode === 'teacher' ? '2rem' : '3rem 1rem', width: '100%' }}>
                    {file ? (
                        <Document file={file} onLoadSuccess={onDocumentLoadSuccess} loading={<div style={{ color: viewerMode === 'teacher' ? 'white' : '#64748b' }}>시험지 로딩 중...</div>}>
                            <div
                                ref={containerRef}
                                onClick={handlePageClick}
                                style={{
                                    position: 'relative',
                                    boxShadow: viewerMode === 'student' ? '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)' : '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                                    borderRadius: viewerMode === 'student' ? '8px' : '0',
                                    overflow: 'hidden',
                                    background: 'white'
                                }}
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
                                            pointerEvents: drawingMode === 'pen' ? 'auto' : 'none' // Allow click through to markers/pan if not drawing
                                        }}
                                    />
                                )}

                                {/* Markers Overlay */}
                                {markers.filter(m => m.page === pageNumber).map((marker, i) => {
                                    const isBbox = marker.w !== undefined && marker.h !== undefined;
                                    const isChoice = marker.type === 'choice';

                                    if (isChoice) {
                                        return (
                                            <div
                                                key={i}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (marker.onClick) marker.onClick();
                                                }}
                                                className="pdf-choice-marker"
                                                style={{
                                                    position: 'absolute',
                                                    left: `${marker.x * 100}%`,
                                                    top: `${marker.y * 100}%`,
                                                    width: `${marker.w! * 100}%`,
                                                    height: `${marker.h! * 100}%`,
                                                    zIndex: 25,
                                                    cursor: 'pointer',
                                                    background: marker.color ? `${marker.color}40` : 'transparent', // 25% opacity when selected
                                                    border: marker.color ? `2px solid ${marker.color}` : 'none',
                                                    borderRadius: '4px',
                                                    transition: 'all 0.1s',
                                                }}
                                                title={`Select Choice ${marker.label}`}
                                                onMouseEnter={(e) => {
                                                    if (!marker.color) {
                                                        e.currentTarget.style.background = 'rgba(16, 185, 129, 0.2)'; // Subtle green highlight
                                                        e.currentTarget.style.border = '2px solid rgba(16, 185, 129, 0.5)';
                                                    }
                                                }}
                                                onMouseLeave={(e) => {
                                                    if (!marker.color) {
                                                        e.currentTarget.style.background = 'transparent';
                                                        e.currentTarget.style.border = 'none';
                                                    }
                                                }}
                                            />
                                        );
                                    }

                                    return (
                                        <div
                                            key={i}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (marker.onClick) marker.onClick();
                                            }}
                                            style={isBbox ? {
                                                position: 'absolute',
                                                left: `${marker.x * 100}%`,
                                                top: `${marker.y * 100}%`,
                                                width: `${marker.w! * 100}%`,
                                                height: `${marker.h! * 100}%`,
                                                zIndex: 20,
                                                cursor: 'pointer',
                                                background: (marker.color || '#ef4444') + '33', // 20% opacity
                                                border: `2px solid ${marker.color || '#ef4444'}`,
                                                borderRadius: '4px',
                                                display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start',
                                                padding: '2px',
                                                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                                transition: 'all 0.2s',
                                            } : {
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
                                            {isBbox ? (
                                                <div style={{
                                                    background: marker.color || '#ef4444',
                                                    color: 'white',
                                                    borderRadius: '4px',
                                                    padding: '2px 6px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 'bold',
                                                    marginTop: '-24px', // Float above
                                                    marginLeft: '-2px'
                                                }}>
                                                    Q{marker.label}
                                                </div>
                                            ) : (
                                                marker.label
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </Document>
                    ) : (
                        <div onClick={() => viewerMode === 'teacher' && document.getElementById('pdf-upload-input')?.click()} style={{ color: '#aaa', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', cursor: viewerMode === 'teacher' ? 'pointer' : 'default', border: '2px dashed #ccc', margin: '1rem', borderRadius: '1rem', minHeight: '400px', background: 'white' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📄</div>
                            <p style={{ fontWeight: 600 }}>선생님이 아직 문제지를 등록하지 않았습니다.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Student Floating Toolbar */}
            {viewerMode === 'student' && file && (
                <div style={{
                    position: 'absolute',
                    bottom: '2rem',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'white',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '9999px',
                    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1.5rem',
                    zIndex: 100,
                    border: '1px solid #e2e8f0'
                }}>
                    {/* Pagination */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1} style={{ background: '#f8fafc', border: 'none', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#334155' }}>◀</button>
                        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#475569', minWidth: '40px', textAlign: 'center' }}>
                            {pageNumber} / {numPages}
                        </span>
                        <button onClick={() => setPageNumber(p => Math.min(numPages, p + 1))} disabled={pageNumber >= numPages} style={{ background: '#f8fafc', border: 'none', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#334155' }}>▶</button>
                    </div>

                    <div style={{ width: '1px', height: '24px', background: '#e2e8f0' }}></div>

                    {/* Scale */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <button onClick={() => setScale(s => Math.max(0.5, s - 0.2))} style={{ background: 'transparent', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#475569' }}>-</button>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#475569', width: '45px', textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
                        <button onClick={() => setScale(s => Math.min(2.5, s + 0.2))} style={{ background: 'transparent', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#475569' }}>+</button>
                    </div>

                    {enableDrawing && (
                        <>
                            <div style={{ width: '1px', height: '24px', background: '#e2e8f0' }}></div>
                            {/* Tools */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <button
                                    onClick={() => setDrawingMode('pan')}
                                    style={{ background: drawingMode === 'pan' ? '#e0e7ff' : 'transparent', color: drawingMode === 'pan' ? '#4f46e5' : '#64748b', border: 'none', padding: '0.5rem 0.75rem', borderRadius: '8px', cursor: 'pointer', fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
                                    title="이동 모드"
                                >
                                    🖐
                                </button>
                                <button
                                    onClick={() => setDrawingMode('pen')}
                                    style={{ background: drawingMode === 'pen' ? '#fee2e2' : 'transparent', color: drawingMode === 'pen' ? '#ef4444' : '#64748b', border: 'none', padding: '0.5rem 0.75rem', borderRadius: '8px', cursor: 'pointer', fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
                                    title="그리기 모드"
                                >
                                    🖍️
                                    {drawingMode === 'pen' && (
                                        <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)} style={{ width: '20px', height: '20px', padding: 0, border: 'none', background: 'none' }} />
                                    )}
                                </button>
                                {drawingMode === 'pen' && (
                                    <button onClick={clearPage} style={{ background: 'white', border: '1px solid #e2e8f0', padding: '0.4rem 0.6rem', borderRadius: '8px', cursor: 'pointer', fontSize: '0.8rem', color: '#64748b', marginLeft: '0.2rem' }}>
                                        지우기
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Teacher Bottom Pagination Toolbar (Only visible if file exists & in teacher mode) */}
            {viewerMode === 'teacher' && file && (
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
    );
}
