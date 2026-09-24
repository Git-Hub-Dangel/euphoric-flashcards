import { Modal, Platform, setIcon } from "obsidian";

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

// Applies the user's `animationDurationMs` setting to a modal's container
// via a CSS custom property, or toggles a kill-switch class when disabled.
// prefers-reduced-motion is handled purely in CSS.
export function applyAnimationDuration(containerEl: HTMLElement, ms: number): void {
    if (ms <= 0) {
        containerEl.addClass("ef-anim-off");
        return;
    }
    containerEl.setCssProps({ "--ef-anim-dur": `${ms}ms` });
    // On mobile, Obsidian slides the modal up from the bottom over ~200 ms.
    // Offset every stagger by a pre-roll so our initial fade-ins wait for
    // the modal to settle. This offset MUST be cleared after the initial
    // render batch — otherwise every later interaction (reveal, next card,
    // deck expand, redraw) would also wait for the pre-roll, producing a
    // sluggish 300 ms lag after every tap. The first user touch/click on
    // the container is a reliable "first render is done" signal: the initial
    // batch of `.ef-anim-in` elements has already had its animation-delay
    // computed by the browser, so zeroing the variable now only affects
    // future elements.
    if (Platform.isMobile) {
        containerEl.setCssProps({ "--ef-anim-preroll": "300ms" });
        const clearPreroll = (): void => {
            containerEl.setCssProps({ "--ef-anim-preroll": "0ms" });
        };
        containerEl.addEventListener("touchstart", clearPreroll, { capture: true, once: true });
        containerEl.addEventListener("click", clearPreroll, { capture: true, once: true });
    }
}

// Marks an element to fade-and-rise on next paint. `index` picks one of the
// pre-baked stagger classes (0..14) so successive rows begin their animation
// a fixed step apart. Wrap-around at 15 caps the total delay.
export function staggerIn(el: HTMLElement, index: number): void {
    el.addClass("ef-anim-in");
    el.addClass(`ef-stagger-${index % 15}`);
}

// Triggers the leaving fade-out on a modal, then invokes `next` after the
// animation duration. Used to bridge close-then-open transitions between our
// modals so the swap doesn't flash.
export function fadeOutThen(modal: Modal, next: () => void): void {
    modal.modalEl.addClass("ef-modal-leaving");
    window.setTimeout(next, 120);
}

// True when a key event came from a text entry field. Modal key handlers use
// it so typing a digit into an input does not also fire a response button.
export function isTextEntryEvent(evt: KeyboardEvent): boolean {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return false;
    return target.closest('input, textarea, [contenteditable="true"]') !== null;
}

// On screen keyboard height, in CSS pixels, or 0 when it is closed.
// A mobile WebView can report this on three different channels depending on
// how it handles the keyboard, and a channel that does not apply stays silent
// at 0. Reading all of them and keeping the largest plausible value is what
// makes the result independent of that configuration.
let keyboardHeight = 0;
let capacitorHeight = 0;
const keyboardSubscribers = new Set<(height: number) => void>();

const MIN_PLAUSIBLE_KEYBOARD_PX = 120;
const MAX_PLAUSIBLE_KEYBOARD_RATIO = 0.8;

export function getKeyboardHeight(): number {
    return keyboardHeight;
}

// Subscribe to height changes. Returns an unsubscribe function.
export function onKeyboardChange(cb: (height: number) => void): () => void {
    keyboardSubscribers.add(cb);
    return () => { keyboardSubscribers.delete(cb); };
}

function recomputeKeyboardHeight(): void {
    const inner = window.innerHeight;
    const candidates = [capacitorHeight, inner - document.body.clientHeight];
    const vv = window.visualViewport;
    if (vv) candidates.push(inner - (vv.height + vv.offsetTop));

    let best = 0;
    for (const c of candidates) {
        if (c < MIN_PLAUSIBLE_KEYBOARD_PX) continue;
        if (c > inner * MAX_PLAUSIBLE_KEYBOARD_RATIO) continue;
        if (c > best) best = c;
    }
    if (Math.abs(best - keyboardHeight) < 1) return;
    keyboardHeight = best;
    for (const cb of keyboardSubscribers) cb(best);
}

// Reads the keyboard height off every channel the host WebView might use.
// Returns a disposer the modal calls in onClose.
export function trackKeyboard(): () => void {
    const onCapacitorShow = (e: Event): void => {
        const detail = e as Event & { keyboardHeight?: number; detail?: { keyboardHeight?: number } };
        capacitorHeight = detail.keyboardHeight ?? detail.detail?.keyboardHeight ?? 0;
        recomputeKeyboardHeight();
    };
    const onCapacitorHide = (): void => {
        capacitorHeight = 0;
        recomputeKeyboardHeight();
    };
    const onViewport = (): void => { recomputeKeyboardHeight(); };

    window.addEventListener("keyboardWillShow", onCapacitorShow);
    window.addEventListener("keyboardDidShow", onCapacitorShow);
    window.addEventListener("keyboardWillHide", onCapacitorHide);
    window.addEventListener("keyboardDidHide", onCapacitorHide);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onViewport);
    vv?.addEventListener("scroll", onViewport);
    window.addEventListener("resize", onViewport);

    return () => {
        window.removeEventListener("keyboardWillShow", onCapacitorShow);
        window.removeEventListener("keyboardDidShow", onCapacitorShow);
        window.removeEventListener("keyboardWillHide", onCapacitorHide);
        window.removeEventListener("keyboardDidHide", onCapacitorHide);
        vv?.removeEventListener("resize", onViewport);
        vv?.removeEventListener("scroll", onViewport);
        window.removeEventListener("resize", onViewport);
        capacitorHeight = 0;
        keyboardHeight = 0;
        keyboardSubscribers.clear();
    };
}

// Some hosts report the keyboard only after it has finished animating and
// emit no event at all. A few delayed samples after a focus cover that case.
export function sampleKeyboardSoon(): void {
    window.setTimeout(recomputeKeyboardHeight, 150);
    window.setTimeout(recomputeKeyboardHeight, 400);
    window.setTimeout(recomputeKeyboardHeight, 800);
}
