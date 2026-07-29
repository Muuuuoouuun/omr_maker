interface SkipToMainContentProps {
    targetId?: string;
}

export default function SkipToMainContent({ targetId = "main-content" }: SkipToMainContentProps) {
    return (
        <a className="skip-to-main" href={`#${targetId}`}>
            본문으로 건너뛰기
        </a>
    );
}
