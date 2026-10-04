// Easy is never emitted by a button. It holds position 0 for historical reasons
// only. The quality ordering lives in QUALITY_RANK (src/learn/group-state.ts),
// which is what isWorseThan and worstOf read, so these numbers are not load
// bearing and must never be compared directly.
export enum ReviewResponse {
    Easy,
    Good,
    Hard,
    Again,
}
