import Link from "next/link";
import { Exam } from "@/types/omr";

interface ExamListBlockProps {
    exams: Exam[];
}

export default function ExamListBlock({ exams }: ExamListBlockProps) {
    return (
        <div className="bento-card col-span-2 row-span-2">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Recent Exams</h3>
                <Link href="/create" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.9rem', color: 'var(--primary)', fontWeight: 600 }}>
                    <span style={{ fontSize: '1.2rem' }}>+</span> New Exam
                </Link>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
                {exams.length === 0 ? (
                    <div style={{
                        textAlign: 'center', padding: '3rem', color: 'var(--muted)',
                        background: 'var(--background)', borderRadius: 'var(--radius-lg)',
                        border: '1px dashed var(--border)'
                    }}>
                        No exams created yet.
                    </div>
                ) : (
                    exams.slice(0, 5).map((exam) => (
                        <div key={exam.id}
                            className="card-hover"
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                padding: '1.25rem', borderRadius: 'var(--radius-lg)',
                                border: '1px solid var(--border)',
                                background: 'var(--surface)',
                                transition: 'all 0.2s',
                                position: 'relative'
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                                <div style={{
                                    width: '48px', height: '48px', borderRadius: 'var(--radius-md)',
                                    background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: 'white', fontWeight: '800', fontSize: '1.2rem',
                                    boxShadow: '0 4px 6px -1px rgba(99, 102, 241, 0.2)'
                                }}>
                                    {exam.title.charAt(0)}
                                </div>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--foreground)', marginBottom: '0.25rem' }}>{exam.title}</div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)', display: 'flex', gap: '0.5rem' }}>
                                        <span>{new Date(exam.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>{exam.questions.length} <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--muted)' }}>Qs</span></div>
                                    <div style={{
                                        fontSize: '0.75rem', fontWeight: 600,
                                        color: exam.accessConfig?.type === 'group' ? 'var(--primary)' : 'var(--success)',
                                        background: exam.accessConfig?.type === 'group' ? 'rgba(99, 102, 241, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                                        padding: '2px 6px', borderRadius: '4px', display: 'inline-block', marginTop: '2px'
                                    }}>
                                        {exam.accessConfig?.type === 'group' ? 'Group' : 'Public'}
                                    </div>
                                </div>
                                <Link
                                    href={`/teacher/exam/${exam.id}`}
                                    className="btn btn-secondary"
                                    style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                                >
                                    Details
                                </Link>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
