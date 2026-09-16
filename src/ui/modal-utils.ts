// Obsidian modals close when the user taps the dimmed background around them.
// For fullscreen review/sentence-builder modals on mobile that means an
// accidental tap near the screen edge can wipe out an in-progress session.
// Blocking taps that land outside the modal (i.e. on `.modal-bg` or the raw
// container) prevents that. Users still have the built-in close button and the
// custom `.ef-back-btn` for intentional dismissal.
export function preventBgTapDismiss(containerEl: HTMLElement): void {
    const block = (e: Event): void => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (!target.closest(".modal")) e.stopImmediatePropagation();
    };
    containerEl.addEventListener("click", block, { capture: true });
    containerEl.addEventListener("mousedown", block, { capture: true });
    containerEl.addEventListener("touchstart", block, { capture: true });
}
