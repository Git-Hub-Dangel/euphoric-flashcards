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
