//! Program errors.

use anchor_lang::prelude::*;

#[error_code]
pub enum AnqaError {
    #[msg("price in ticks must be non-zero")]
    InvalidPrice,
    #[msg("size in base lots must be non-zero")]
    InvalidSize,
    #[msg("book side is full")]
    BookSideFull,
    #[msg("order not found")]
    OrderNotFound,
    #[msg("caller does not own this order")]
    NotOrderOwner,
    #[msg("post-only order would have crossed the book")]
    PostOnlyWouldCross,
    #[msg("fill-or-kill order could not be fully filled")]
    FillOrKillUnfilled,
    #[msg("market is paused")]
    MarketPaused,
    #[msg("seat does not belong to this market")]
    WrongMarket,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("risk engine rejected the operation")]
    RiskEngine,
    #[msg("insufficient margin for this order")]
    InsufficientMargin,
    #[msg("maker portfolio account missing or mismatched")]
    MakerPortfolioMissing,
    #[msg("book side full: pass the evicted owner's portfolio to place here")]
    EvictedPortfolioMissing,
    #[msg("all trigger slots are in use; cancel one first")]
    TriggerSlotsFull,
    #[msg("a trigger with this id is already armed")]
    DuplicateTriggerId,
    #[msg("asset index out of range")]
    BadAssetIndex,
    #[msg("cancel resting orders before withdrawing")]
    WithdrawWithRestingOrders,
    #[msg("oracle price unavailable or stale")]
    OracleUnavailable,
    #[msg("oracle confidence interval too wide to mark positions")]
    OracleConfidenceTooWide,
    #[msg("price update account does not match this market's feed")]
    WrongPriceFeed,
    #[msg("oracle sources disagree beyond tolerance")]
    OracleSourcesDisagree,
    #[msg("mark moved more than the permitted band; breaker tripped")]
    OracleMoveTooLarge,
    #[msg("oracle circuit breaker is active")]
    OracleFrozen,
    #[msg("market is not paused")]
    MarketNotPaused,
    #[msg("only the market authority may do that")]
    Unauthorized,
    #[msg("this action is timelocked and not yet due")]
    TimelockPending,
    #[msg("insurance fund has insufficient balance")]
    InsuranceInsufficient,
    #[msg("account is not eligible for auto-deleveraging")]
    NotAdlEligible,
    #[msg("book is still delegated to the rollup")]
    BookDelegated,
    #[msg("too many accounts supplied")]
    TooManyAccounts,
    #[msg("price is outside the oracle band")]
    PriceOutsideBand,
    #[msg("tick size and lot size must be non-zero")]
    InvalidTickSize,
    #[msg("nothing available to claim or reserve")]
    NothingToClaim,
    #[msg("withdraw receipt already authorized")]
    ReceiptAlreadyProcessed,
    #[msg("withdraw receipt has not been authorized by the risk engine")]
    ReceiptNotAuthorized,
    #[msg("no open position on this market")]
    NoOpenPosition,
    #[msg("close could not be filled at the given price")]
    CloseUnfilled,
    #[msg("trigger price has not been reached")]
    TriggerNotArmed,
}

/// Bridge Percolator's error type into Anchor's, preserving the kernel's reason
/// in the program log. The kernel refuses far more than it accepts — stale
/// oracle, margin gate, unproven backing — and losing which gate fired would
/// make failures impossible to debug.
pub fn map_risk<T>(r: percolator::V16Result<T>) -> anchor_lang::Result<T> {
    r.map_err(|e| {
        anchor_lang::prelude::msg!("anqa: risk engine rejected: {:?}", e);
        AnqaError::RiskEngine.into()
    })
}
