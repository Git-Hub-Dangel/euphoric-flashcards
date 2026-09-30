// Target group size. Groups may be shorter when pools run dry, never larger.
export const LEARN_GROUP_SIZE = 8;

// Threshold on min-across-faces FSRS stability separating mature from young
// cards. Stability, not scheduled_days (plan §B3): the interval a card happens
// to be sitting on is a consequence of the last answer, while stability is the
// model's estimate of how well the card is actually known.
export const LEARN_MATURE_STABILITY = 21;

// Group progress at which the first sentence task fires.
export const LEARN_SENTENCE_TRIGGER = 0.7;

// After an Again on a face, the reinsertion sits at least this many items
// past the current index in the group queue.
export const LEARN_AGAIN_MIN_LAG = 3;

// A card must have hit Again at least this many times to be eligible for
// carryover into the next group.
export const LEARN_CARRYOVER_MIN_AGAINS = 2;

// Floor on min-across-faces stability for sentence anchors. Lower than maturity
// so the anchor pool spans semi mature words too and no single word can dominate
// it. The 12/21 overlap band is deliberate and load-bearing for invariant 33.
export const LEARN_ANCHOR_MIN_STABILITY = 12;

// Stability scoring one on the anchor tilt. Less stable anchors score above it,
// more stable ones below, within the clamp.
export const LEARN_ANCHOR_REF_STABILITY = 30;

// Clamp on the anchor tilt, bounding the spread between the most and least
// favoured anchor at four times.
export const LEARN_ANCHOR_TILT_MIN = 0.5;
export const LEARN_ANCHOR_TILT_MAX = 2;

// Multiplicative jitter on an anchor weight, drawn per candidate per draw.
// 0.35 yields a factor in [0.65, 1.35], enough that neighbouring stabilities
// reorder freely between draws.
export const LEARN_ANCHOR_FUZZ = 0.35;
