import Link from "next/link";
import { Exam } from "@/types/omr";

interface AssignmentBlockProps {
    exams: Exam[];
    type: 'todo' | 'done';
}

export default function AssignmentBlock({ exams, type }: AssignmentBlockProps) {
    const isTodo = type === 'todo';

    return (
        <div className={`bento-card ${isTodo ? 'col-span-2 row-span-2' : 'col-span-2 row-span-1'}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {isTodo ? '📚 To-Do Assignments' : '✅ Completed History'}
                    {isTodo && exams.length > 0 && (
                        <span style={{
                            background: 'var(--error)', color: 'white',
                            fontSize: '0.75rem', fontWeight: 700,
                            padding: '2px 8px', borderRadius: 'var(--radius-full)'
                        }}>
                            {exams.length}
                        </span>
                    )}
                </h3>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', flex: 1, paddingRight: '0.5rem' }}>
                {exams.length === 0 ? (
                    <div style={{
                        textAlign: 'center', padding: '3rem', color: 'var(--muted)',
                        background: 'var(--background)', borderRadius: 'var(--radius-lg)',
                        border: '1px dashed var(--border)'
                    }}>
                        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>{isTodo ? '🎉' : '📂'}</div>
                        {isTodo ? "No pending assignments! You're all caught up." : "No history yet."}
                    </div>
                ) : (
                    exams.map((exam) => (
                        <div key={exam.id}
                            className={isTodo ? "card-hover" : ""}
                            style={{
                                padding: '1.25rem', borderRadius: 'var(--radius-lg)',
                                border: '1px solid var(--border)',
                                background: isTodo ? 'var(--surface)' : 'rgba(241, 245, 249, 0.5)',
                                display: 'flex', alignItems: 'center', gap: '1rem',
                                transition: 'all 0.2s',
                                opacity: isTodo ? 1 : 0.8
                            }}
                        >
                            <div style={{
                                width: '48px', height: '48px', borderRadius: 'var(--radius-md)',
                                background: isTodo ? 'linear-gradient(135deg, var(--primary), var(--secondary))' : 'var(--muted)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: 'white', fontWeight: '800', fontSize: '1.2rem',
                                boxShadow: isTodo ? '0 4px 6px -1px rgba(99, 102, 241, 0.3)' : 'none'
                            }}>
                                {exam.title.substring(0, 1)}
                            </div>

                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--foreground)', marginBottom: '0.2rem' }}>{exam.title}</div>
                                <div style={{ fontSize: '0.85rem', color: 'var(--muted)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <span>{exam.questions.length} Questions</span>
                                    <span style={{ width: '4px', height: '4px', background: 'var(--muted)', borderRadius: '50%' }}></span>
                                    <span style={{
                                        background: exam.accessConfig?.type === 'group' ? 'rgba(99, 102, 241, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                                        color: exam.accessConfig?.type === 'group' ? 'var(--primary)' : 'var(--success)',
                                        padding: '1px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600
                                    }}>
                                        {exam.accessConfig?.type === 'group' ? 'Class' : 'Public'}
                                    </span>
                                </div>
                            </div>

                            {isTodo ? (
                                <Link
                                    href={`/solve/${exam.id}`}
                                    className="btn btn-primary"
                                    style={{ padding: '0.6rem 1.2rem', fontSize: '0.9rem' }}
                                >
                                    Start
                                </Link>
                            ) : (
                                <Link
                                    href={`/student/review/${exam.id}`}
                                    className="btn btn-secondary"
                                    style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                                >
                                    Review
                                </Link>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
