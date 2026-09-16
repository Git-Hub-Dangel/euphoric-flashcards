// obsidian modals close when the user taps the dimmed background around them.
// for fullscreen review and sentence builder modals on mobile that means an
// accidental tap near the screen edge can wipe out an in-progress session.
// blocking taps that land outside the modal prevents that. users still have
// the built-in close button and `.ef-back-btn` for intentional dismissal.
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
