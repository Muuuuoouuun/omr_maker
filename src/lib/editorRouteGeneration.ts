export interface EditorRouteGenerationController {
    slot(): string;
    generation(): number;
    commit(slot: string): void;
    isCurrent(generation: number): boolean;
}

/** Route ownership advances only after React commits the corresponding slot. */
export function createEditorRouteGenerationController(initialSlot: string): EditorRouteGenerationController {
    let currentSlot = initialSlot;
    let currentGeneration = 0;

    return {
        slot: () => currentSlot,
        generation: () => currentGeneration,
        commit: (slot) => {
            if (currentSlot === slot) return;
            currentSlot = slot;
            currentGeneration += 1;
        },
        isCurrent: (generation) => currentGeneration === generation,
    };
}
