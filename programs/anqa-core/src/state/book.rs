//! The order book.
//!
//! A Phoenix-style central limit order book: strict price-time priority, FIFO
//! order identifiers, and **crankless** execution — a taker crosses the resting
//! book synchronously during its own instruction, so a fill is final the moment
//! the transaction lands. There is no separate match crank and no settlement
//! step to wait on.
//!
//! ## Zero-copy, and why it is not optional
//!
//! The book is **zero-copy** (`bytemuck` Pod, accessed through `AccountLoader`).
//! A borsh `Account<'info, Book>` deserializes the entire book onto the BPF
//! stack, which blows Solana's 4KB stack frame limit the moment the book holds
//! a realistic number of orders — the compiler reports frames of ~10KB. Phoenix
//! is zero-copy for this reason, and so is the Percolator risk kernel this
//! program will drive. Every type below is therefore `#[repr(C)]` with explicit
//! padding: no `bool`, no enums, no `Option` inside persisted state.
//!
//! ## Structure
//!
//! Each side is a fixed-capacity arena of `RestingOrder` slots woven into two
//! intrusive singly-linked lists — one holding live orders in priority order
//! (best first), one holding free slots. O(1) top-of-book, O(depth) insertion,
//! no memory movement, fixed account size that a rollup can commit cheaply.
//!
//! The book is the account delegated into the PER. While delegated, everything
//! here is invisible from base chain; only `Fill` events escape.

use anchor_lang::prelude::*;

use crate::constants::{MAX_FILLS_PER_ORDER, NIL, ORDERS_PER_SIDE};
use crate::errors::AnqaError;

/// Side of the book. An instruction argument only — never stored in Pod state,
/// where it is a `u8`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    pub fn opposite(&self) -> Side {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }

    pub fn as_u8(&self) -> u8 {
        match self {
            Side::Bid => 0,
            Side::Ask => 1,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum OrderType {
    /// Rest whatever does not immediately cross.
    Limit,
    /// Never take: abort if any part would cross.
    PostOnly,
    /// Take what is available now; discard the remainder.
    ImmediateOrCancel,
    /// All or nothing.
    FillOrKill,
}

/// Phoenix-style FIFO identifier: price first, then arrival sequence. Two orders
/// at the same price are ranked by who arrived earlier, forever.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct FifoOrderId {
    pub price_in_ticks: u64,
    pub seq: u64,
}

/// One resting order. 72 bytes, 8-aligned, no implicit padding.
#[zero_copy]
#[derive(Debug)]
pub struct RestingOrder {
    pub client_order_id: u64,
    pub price_in_ticks: u64,
    pub base_lots: u64,
    pub seq: u64,
    pub trader: Pubkey,
    /// Next slot in whichever list this slot belongs to (live or free).
    pub next: u16,
    /// 1 when this slot holds a live order.
    pub active: u8,
    pub _pad: [u8; 5],
}

/// What a match produced. Ephemeral — returned to the instruction layer, which
/// credits seats and emits the public tape. Never persisted, so it may be a
/// normal Rust type.
#[derive(Clone, Copy, Debug)]
pub struct FillRecord {
    pub maker: Pubkey,
    pub maker_client_order_id: u64,
    pub price_in_ticks: u64,
    pub base_lots: u64,
    /// True when this fill fully consumed the maker's resting order.
    pub maker_order_closed: bool,
}

/// One side of the book: the arena plus its two list heads.
#[zero_copy]
#[derive(Debug)]
pub struct BookSide {
    pub orders: [RestingOrder; ORDERS_PER_SIDE],
    /// Best order, or NIL when empty.
    pub head: u16,
    /// First free slot, or NIL when full.
    pub free_head: u16,
    pub count: u16,
    pub _pad: [u8; 2],
}

impl BookSide {
    /// Thread every slot onto the free list.
    pub fn init(&mut self) {
        self.head = NIL;
        self.count = 0;
        for i in 0..ORDERS_PER_SIDE {
            self.orders[i] = RestingOrder {
                client_order_id: 0,
                price_in_ticks: 0,
                base_lots: 0,
                seq: 0,
                trader: Pubkey::default(),
                next: if i + 1 < ORDERS_PER_SIDE {
                    (i + 1) as u16
                } else {
                    NIL
                },
                active: 0,
                _pad: [0; 5],
            };
        }
        self.free_head = 0;
    }

    pub fn is_empty(&self) -> bool {
        self.head == NIL
    }

    /// Top of book.
    pub fn best(&self) -> Option<&RestingOrder> {
        if self.head == NIL {
            None
        } else {
            Some(&self.orders[self.head as usize])
        }
    }

    pub fn best_price(&self) -> Option<u64> {
        self.best().map(|o| o.price_in_ticks)
    }

    /// Does an order at (price, seq) rank ahead of the order in `slot`?
    fn ranks_ahead(&self, side: Side, price: u64, seq: u64, slot: u16) -> bool {
        let other = &self.orders[slot as usize];
        let price_better = match side {
            Side::Bid => price > other.price_in_ticks,
            Side::Ask => price < other.price_in_ticks,
        };
        price_better || (price == other.price_in_ticks && seq < other.seq)
    }

    fn alloc_slot(&mut self) -> Result<u16> {
        let slot = self.free_head;
        require!(slot != NIL, AnqaError::BookSideFull);
        self.free_head = self.orders[slot as usize].next;
        Ok(slot)
    }

    fn free_slot(&mut self, slot: u16) {
        self.orders[slot as usize] = RestingOrder {
            client_order_id: 0,
            price_in_ticks: 0,
            base_lots: 0,
            seq: 0,
            trader: Pubkey::default(),
            next: self.free_head,
            active: 0,
            _pad: [0; 5],
        };
        self.free_head = slot;
    }

    /// Insert into priority position. Walks the live list; O(depth), no movement.
    pub fn insert(
        &mut self,
        side: Side,
        trader: Pubkey,
        client_order_id: u64,
        price_in_ticks: u64,
        base_lots: u64,
        seq: u64,
    ) -> Result<u16> {
        let slot = self.alloc_slot()?;
        self.orders[slot as usize] = RestingOrder {
            client_order_id,
            price_in_ticks,
            base_lots,
            seq,
            trader,
            next: NIL,
            active: 1,
            _pad: [0; 5],
        };

        if self.head == NIL || self.ranks_ahead(side, price_in_ticks, seq, self.head) {
            self.orders[slot as usize].next = self.head;
            self.head = slot;
        } else {
            let mut cursor = self.head;
            loop {
                let next = self.orders[cursor as usize].next;
                if next == NIL || self.ranks_ahead(side, price_in_ticks, seq, next) {
                    self.orders[slot as usize].next = next;
                    self.orders[cursor as usize].next = slot;
                    break;
                }
                cursor = next;
            }
        }
        self.count = self.count.saturating_add(1);
        Ok(slot)
    }

    /// Unlink the head and return it to the free list.
    fn pop_head(&mut self) {
        if self.head == NIL {
            return;
        }
        let slot = self.head;
        self.head = self.orders[slot as usize].next;
        self.free_slot(slot);
        self.count = self.count.saturating_sub(1);
    }

    /// Remove a specific order owned by `trader`.
    pub fn cancel(&mut self, trader: &Pubkey, client_order_id: u64) -> Result<u64> {
        let mut prev = NIL;
        let mut cursor = self.head;
        while cursor != NIL {
            let active = self.orders[cursor as usize].active == 1;
            let coid = self.orders[cursor as usize].client_order_id;
            let owner = self.orders[cursor as usize].trader;
            let next = self.orders[cursor as usize].next;
            let lots = self.orders[cursor as usize].base_lots;

            if active && coid == client_order_id {
                require_keys_eq!(owner, *trader, AnqaError::NotOrderOwner);
                if prev == NIL {
                    self.head = next;
                } else {
                    self.orders[prev as usize].next = next;
                }
                self.free_slot(cursor);
                self.count = self.count.saturating_sub(1);
                return Ok(lots);
            }
            prev = cursor;
            cursor = next;
        }
        Err(AnqaError::OrderNotFound.into())
    }

    /// Base lots resting at or better than `limit`, within the cross budget.
    /// `self` is the resting side.
    fn liquidity_within(&self, resting_side: Side, limit: u64) -> u64 {
        let mut cursor = self.head;
        let mut total: u64 = 0;
        let mut visited = 0usize;
        while cursor != NIL && visited < MAX_FILLS_PER_ORDER {
            let o = &self.orders[cursor as usize];
            let crosses = match resting_side {
                Side::Ask => o.price_in_ticks <= limit,
                Side::Bid => o.price_in_ticks >= limit,
            };
            if !crosses {
                break;
            }
            total = total.saturating_add(o.base_lots);
            cursor = o.next;
            visited += 1;
        }
        total
    }
}

#[account(zero_copy)]
#[derive(Debug)]
pub struct Book {
    pub market_id: u64,
    /// Monotonic arrival counter — the "time" in price-time priority.
    pub seq: u64,
    pub fill_count: u64,
    pub last_fill_price_in_ticks: u64,
    pub last_fill_base_lots: u64,
    pub bids: BookSide,
    pub asks: BookSide,
    pub bump: u8,
    pub _pad: [u8; 7],
}

impl Book {
    pub fn init(&mut self, market_id: u64, bump: u8) {
        self.market_id = market_id;
        self.bump = bump;
        self.seq = 1;
        self.fill_count = 0;
        self.last_fill_price_in_ticks = 0;
        self.last_fill_base_lots = 0;
        self.bids.init();
        self.asks.init();
    }

    fn next_seq(&mut self) -> u64 {
        let s = self.seq;
        self.seq = self.seq.saturating_add(1);
        s
    }

    pub fn side_mut(&mut self, side: Side) -> &mut BookSide {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    pub fn side(&self, side: Side) -> &BookSide {
        match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        }
    }

    /// Would an order at this price cross the resting book at all?
    pub fn would_cross(&self, side: Side, limit_price: u64) -> bool {
        match self.side(side.opposite()).best_price() {
            None => false,
            Some(best) => match side {
                Side::Bid => limit_price >= best,
                Side::Ask => limit_price <= best,
            },
        }
    }

    /// Place an order: cross first, rest the remainder.
    ///
    /// Returns the fills produced and the lots left resting. Fills are priced at
    /// the **maker's** price — the resting order named its terms and time
    /// priority earns it.
    pub fn place(
        &mut self,
        side: Side,
        order_type: OrderType,
        limit_price: u64,
        base_lots: u64,
        trader: Pubkey,
        client_order_id: u64,
    ) -> Result<(Vec<FillRecord>, u64)> {
        require!(limit_price > 0, AnqaError::InvalidPrice);
        require!(base_lots > 0, AnqaError::InvalidSize);

        if order_type == OrderType::PostOnly {
            require!(
                !self.would_cross(side, limit_price),
                AnqaError::PostOnlyWouldCross
            );
        }

        if order_type == OrderType::FillOrKill {
            let resting = side.opposite();
            let available = self.side(resting).liquidity_within(resting, limit_price);
            require!(available >= base_lots, AnqaError::FillOrKillUnfilled);
        }

        let mut remaining = base_lots;
        let mut fills: Vec<FillRecord> = Vec::new();

        if order_type != OrderType::PostOnly {
            let resting_side = side.opposite();
            while remaining > 0 && fills.len() < MAX_FILLS_PER_ORDER {
                let head = self.side(resting_side).head;
                if head == NIL {
                    break;
                }

                let maker_price = self.side(resting_side).orders[head as usize].price_in_ticks;
                let maker_lots = self.side(resting_side).orders[head as usize].base_lots;
                let maker_trader = self.side(resting_side).orders[head as usize].trader;
                let maker_coid = self.side(resting_side).orders[head as usize].client_order_id;

                let crosses = match side {
                    Side::Bid => maker_price <= limit_price,
                    Side::Ask => maker_price >= limit_price,
                };
                if !crosses {
                    break;
                }

                // Self-trade prevention: drop the resting order, keep matching.
                if maker_trader == trader {
                    self.side_mut(resting_side).pop_head();
                    continue;
                }

                let traded = remaining.min(maker_lots);
                let closes = traded == maker_lots;

                if closes {
                    self.side_mut(resting_side).pop_head();
                } else {
                    self.side_mut(resting_side).orders[head as usize].base_lots =
                        maker_lots - traded;
                }

                remaining -= traded;
                self.fill_count = self.fill_count.saturating_add(1);
                self.last_fill_price_in_ticks = maker_price;
                self.last_fill_base_lots = traded;

                fills.push(FillRecord {
                    maker: maker_trader,
                    maker_client_order_id: maker_coid,
                    price_in_ticks: maker_price,
                    base_lots: traded,
                    maker_order_closed: closes,
                });
            }
        }

        let rests = matches!(order_type, OrderType::Limit | OrderType::PostOnly);
        if remaining > 0 && rests {
            let seq = self.next_seq();
            self.side_mut(side)
                .insert(side, trader, client_order_id, limit_price, remaining, seq)?;
        } else {
            remaining = 0;
        }

        Ok((fills, remaining))
    }
}
