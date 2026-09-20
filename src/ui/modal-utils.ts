import { Modal, setIcon } from "obsidian";

// custom close button pinned top-right of the modal, mirroring `.ef-back-btn`.
// obsidian's native `.modal-close-button` sits under the iOS notch on
// fullscreen modals and its position is hard to override reliably across
// obsidian versions, so we hide it (via css) and render our own that
// respects `env(safe-area-inset-top)`.
export function addCloseButton(modal: Modal): void {
    const btn = modal.modalEl.createEl("button", {
        cls: "ef-close-btn",
        attr: { "aria-label": "Close", tabindex: "-1" },
    });
    setIcon(btn, "x");
    btn.addEventListener("click", () => modal.close());
}

// obsidian modals close when the user taps the dimmed background around them.
// for fullscreen review and conjure sentences modals on mobile that means an
// accidental tap near the screen edge can wipe out an in-progress session.
// blocking taps that land outside the modal prevents that. users still have
// the close button and `.ef-back-btn` for intentional dismissal.
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
