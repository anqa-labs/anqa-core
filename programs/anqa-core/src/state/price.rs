//! Exponent-aware price arithmetic.
//!
//! A price is a `(mantissa, exponent)` pair — deterministic integer arithmetic
//! standing in for the floating point that BPF will not give us. Oracles publish
//! this shape natively (Pyth's `Price` is exactly `price` + `exponent`), so
//! carrying it rather than flattening it immediately means a feed can change its
//! scale without silently repricing every position in the venue.
//!
//! Two forces pull against each other in all of this:
//!
//! - **Truncation.** Integer division discards the remainder, so `3 / 4 == 0`.
//!   Divide before scaling and small quantities — funding rates, fee shares —
//!   round to nothing.
//! - **Overflow.** Scale up too eagerly and a `u64` multiply wraps.
//!
//! Every operation below is written to sit between those two failures rather
//! than pick one.

use anchor_lang::prelude::*;

use crate::errors::AnqaError;

/// Working scale for division results: 10^-9.
pub const PRICE_SCALE_EXPONENT: i32 = -9;
pub const PRICE_SCALE: u64 = 1_000_000_000;

/// Largest mantissa permitted before a multiply.
///
/// Two values below 2^28 multiply to under 2^56, comfortably inside `u64`.
/// `normalize` trades low-order digits for exponent to get under this ceiling —
/// losing precision we can afford in order to avoid an overflow we cannot.
pub const MAX_MANTISSA: u64 = (1 << 28) - 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Price {
    pub mantissa: u64,
    pub exponent: i32,
}

impl Price {
    pub const ZERO: Price = Price {
        mantissa: 0,
        exponent: 0,
    };

    pub fn new(mantissa: u64, exponent: i32) -> Self {
        Self { mantissa, exponent }
    }

    /// A token amount read as a price-shaped value: `amount * 10^-decimals`.
    pub fn from_token_amount(amount: u64, decimals: u8) -> Self {
        Self::new(amount, -(decimals as i32))
    }

    pub fn is_zero(&self) -> bool {
        self.mantissa == 0
    }

    /// Restate at a different exponent.
    ///
    /// Moving to a *larger* exponent divides and therefore truncates; moving to
    /// a smaller one multiplies and may overflow. Both are checked.
    pub fn scale_to(&self, target_exponent: i32) -> Result<Price> {
        if target_exponent == self.exponent {
            return Ok(*self);
        }
        let delta = target_exponent
            .checked_sub(self.exponent)
            .ok_or(AnqaError::MathOverflow)?;
        let pow = 10u64
            .checked_pow(u32::try_from(delta.abs()).map_err(|_| AnqaError::MathOverflow)?)
            .ok_or(AnqaError::MathOverflow)?;

        let mantissa = if delta > 0 {
            self.mantissa / pow
        } else {
            self.mantissa
                .checked_mul(pow)
                .ok_or(AnqaError::MathOverflow)?
        };
        Ok(Price::new(mantissa, target_exponent))
    }

    /// Shrink the mantissa below `MAX_MANTISSA`, raising the exponent to match.
    pub fn normalize(&self) -> Result<Price> {
        let mut m = self.mantissa;
        let mut e = self.exponent;
        while m > MAX_MANTISSA {
            m /= 10;
            e = e.checked_add(1).ok_or(AnqaError::MathOverflow)?;
        }
        Ok(Price::new(m, e))
    }

    /// Multiply. Exponents add; both mantissas are normalized first.
    pub fn checked_mul(&self, other: &Price) -> Result<Price> {
        let a = self.normalize()?;
        let b = other.normalize()?;
        Ok(Price::new(
            a.mantissa
                .checked_mul(b.mantissa)
                .ok_or(AnqaError::MathOverflow)?,
            a.exponent
                .checked_add(b.exponent)
                .ok_or(AnqaError::MathOverflow)?,
        ))
    }

    /// Divide, pre-scaling the dividend so the result keeps its fraction.
    ///
    /// Without the `PRICE_SCALE` multiply first, any quotient below one becomes
    /// zero — which is how a perps venue ends up charging no funding and no fees.
    pub fn checked_div(&self, other: &Price) -> Result<Price> {
        require!(!other.is_zero(), AnqaError::MathOverflow);
        let a = self.normalize()?;
        let b = other.normalize()?;
        Ok(Price::new(
            a.mantissa
                .checked_mul(PRICE_SCALE)
                .ok_or(AnqaError::MathOverflow)?
                / b.mantissa,
            a.exponent
                .checked_add(PRICE_SCALE_EXPONENT)
                .ok_or(AnqaError::MathOverflow)?
                .checked_sub(b.exponent)
                .ok_or(AnqaError::MathOverflow)?,
        ))
    }

    pub fn checked_add(&self, other: &Price) -> Result<Price> {
        let o = other.scale_to(self.exponent)?;
        Ok(Price::new(
            self.mantissa
                .checked_add(o.mantissa)
                .ok_or(AnqaError::MathOverflow)?,
            self.exponent,
        ))
    }

    pub fn checked_sub(&self, other: &Price) -> Result<Price> {
        let o = other.scale_to(self.exponent)?;
        Ok(Price::new(
            self.mantissa
                .checked_sub(o.mantissa)
                .ok_or(AnqaError::MathOverflow)?,
            self.exponent,
        ))
    }

    /// Restate as an integer count of `decimals`-decimal atoms.
    pub fn to_atoms(&self, decimals: u8) -> Result<u64> {
        let scaled = self.scale_to(-(decimals as i32))?;
        Ok(scaled.mantissa)
    }

    /// Absolute difference from `other`, in basis points of `self`.
    pub fn deviation_bps(&self, other: &Price) -> Result<u64> {
        require!(!self.is_zero(), AnqaError::OracleUnavailable);
        let common = self.exponent.min(other.exponent);
        let a = self.scale_to(common)?.mantissa as u128;
        let b = other.scale_to(common)?.mantissa as u128;
        require!(a > 0, AnqaError::OracleUnavailable);
        Ok((a.abs_diff(b)
            .checked_mul(10_000)
            .ok_or(AnqaError::MathOverflow)?
            / a) as u64)
    }

    /// Compare across differing exponents by moving both to the finer of the two,
    /// so the comparison is not decided by truncation.
    pub fn lt(&self, other: &Price) -> Result<bool> {
        let common = self.exponent.min(other.exponent);
        Ok(self.scale_to(common)?.mantissa < other.scale_to(common)?.mantissa)
    }

    /// Conservative quote for an asset pegged to one unit of account.
    ///
    /// Never value a stablecoin above par: an upward depeg must not credit a
    /// trader with collateral that will not be there tomorrow. A downward depeg
    /// is passed through in full, because that loss is real.
    pub fn capped_at_par(&self) -> Result<Price> {
        if self.exponent > 0 {
            return Ok(*self);
        }
        let one = 10u64
            .checked_pow(u32::try_from(-self.exponent).map_err(|_| AnqaError::MathOverflow)?)
            .ok_or(AnqaError::MathOverflow)?;
        if self.mantissa > one {
            Ok(Price::new(one, self.exponent))
        } else {
            Ok(*self)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaling_round_trips_and_truncates_predictably() {
        let p = Price::new(12_300, -3); // 12.300
        assert_eq!(p.scale_to(-6).unwrap().mantissa, 12_300_000);
        assert_eq!(p.scale_to(-1).unwrap().mantissa, 123);
        assert_eq!(p.scale_to(1).unwrap().mantissa, 1); // 12.3 -> 1 (x10)
    }

    #[test]
    fn division_keeps_the_fraction() {
        // 3 / 4 must not be zero.
        let q = Price::new(3, 0).checked_div(&Price::new(4, 0)).unwrap();
        assert_eq!(q.to_atoms(2).unwrap(), 75); // 0.75
    }

    #[test]
    fn normalize_prevents_multiply_overflow() {
        let big = Price::new(u64::MAX / 2, -9);
        let n = big.normalize().unwrap();
        assert!(n.mantissa <= MAX_MANTISSA);
        assert!(n.checked_mul(&n).is_ok());
    }

    #[test]
    fn pyth_style_rescale_matches_hand_arithmetic() {
        // BTC at 6390781770600 x 10^-8 -> USDC atoms (6dp)
        let p = Price::new(6_390_781_770_600, -8);
        assert_eq!(p.to_atoms(6).unwrap(), 63_907_817_706);
    }

    #[test]
    fn stablecoin_is_capped_above_par_only() {
        let over = Price::new(1_003_000, -6); // $1.003
        assert_eq!(over.capped_at_par().unwrap().mantissa, 1_000_000);
        let under = Price::new(970_000, -6); // $0.97 depeg
        assert_eq!(under.capped_at_par().unwrap().mantissa, 970_000);
    }
}
