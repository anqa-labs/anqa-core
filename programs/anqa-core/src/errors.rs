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
}
