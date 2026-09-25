// Target group size. Groups may be shorter when pools run dry, never larger.
export const LEARN_GROUP_SIZE = 8;

// Threshold on min-seen interval separating mature from young cards.
export const LEARN_MATURE_INTERVAL_DAYS = 21;

// Group progress at which the first sentence task fires.
export const LEARN_SENTENCE_TRIGGER = 0.7;

// After an Again on a face, the reinsertion sits at least this many items
// past the current index in the group queue.
export const LEARN_AGAIN_MIN_LAG = 3;

// A card must have hit Again at least this many times to be eligible for
// carryover into the next group.
export const LEARN_CARRYOVER_MIN_AGAINS = 2;

// Floor on min-seen interval for sentence anchors. Lower than maturity so the
// anchor pool spans semi mature words too and no single word can dominate it.
export const LEARN_ANCHOR_MIN_INTERVAL_DAYS = 12;

// Interval scoring one on the anchor tilt. Shorter intervals score above it,
// longer ones below, within the clamp.
export const LEARN_ANCHOR_REF_DAYS = 30;

// Clamp on the anchor tilt, bounding the spread between the most and least
// favoured anchor at four times.
export const LEARN_ANCHOR_TILT_MIN = 0.5;
export const LEARN_ANCHOR_TILT_MAX = 2;

// Multiplicative jitter on an anchor weight, drawn per candidate per draw.
// 0.35 yields a factor in [0.65, 1.35], enough that neighbouring intervals
// reorder freely between draws.
export const LEARN_ANCHOR_FUZZ = 0.35;
