// Quality ordering is load-bearing: worstOf (src/learn/group-state.ts) takes the
// largest enum value seen. Easy is never emitted by any button, but it holds
// position 0 so Good=1 / Hard=2 / Again=3 keep their values.
export enum ReviewResponse {
    Easy,
    Good,
    Hard,
    Again,
}
