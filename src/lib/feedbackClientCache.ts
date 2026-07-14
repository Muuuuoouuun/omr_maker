import { saveLocalAttemptFeedback } from "@/lib/feedbackPersistence";
import type { FeedbackEnvelope } from "@/lib/feedbackServerGateway";
import type { AttemptFeedback, PdfDrawings } from "@/types/omr";
import { saveJsonRecord } from "@/utils/blobStore";

function pageCount(drawings: PdfDrawings): number {
    return Object.values(drawings).filter(paths => paths.length > 0).length;
}

function strokeCount(drawings: PdfDrawings): number {
    return Object.values(drawings).reduce((sum, paths) => sum + paths.length, 0);
}

export async function cacheFeedbackEnvelope(envelope: FeedbackEnvelope): Promise<AttemptFeedback> {
    let feedback = envelope.feedback;
    if (envelope.markupDrawings && Object.keys(envelope.markupDrawings).length) {
        const ref = await saveJsonRecord(`feedback:${feedback.id}:markup`, envelope.markupDrawings);
        if (ref) {
            feedback = {
                ...feedback,
                markup: {
                    schemaVersion: 1,
                    strokesRef: ref,
                    pageCount: pageCount(envelope.markupDrawings),
                    strokeCount: strokeCount(envelope.markupDrawings),
                    storage: "indexeddb",
                },
            };
        }
    }
    saveLocalAttemptFeedback(feedback);
    return feedback;
}
