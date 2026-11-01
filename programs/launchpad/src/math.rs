//! Bonding-curve maths. Pure functions so they can be unit-tested natively.
//!
//! The curve is constant-product over *virtual* reserves: `virtual_sol * virtual_token = k`.
//! Real SOL held by a curve always equals `virtual_sol - initial_virtual_sol`.

use crate::constants::*;

pub const BPS: u64 = 10_000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BuyQuote {
    /// Tokens the buyer receives.
    pub tokens_out: u64,
    /// SOL entering the curve (excluding fee).
    pub sol_in: u64,
    /// Protocol fee in lamports.
    pub fee: u64,
    /// New virtual reserves after the trade.
    pub new_virtual_sol: u64,
    pub new_virtual_token: u64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SellQuote {
    /// SOL the seller receives after fee.
    pub sol_out: u64,
    pub fee: u64,
    /// SOL leaving the curve (sol_out + fee).
    pub gross: u64,
    pub new_virtual_sol: u64,
    pub new_virtual_token: u64,
}

fn div_up(a: u128, b: u128) -> u128 {
    if a == 0 {
        0
    } else {
        (a - 1) / b + 1
    }
}

/// Quote a buy that spends at most `max_sol` lamports (fee included).
/// If the buy would run past the end of the curve it is capped at the remaining
/// supply and only the SOL actually needed is charged.
pub fn quote_buy(virtual_sol: u64, virtual_token: u64, tokens_sold: u64, max_sol: u64, fee_bps: u64) -> BuyQuote {
    if max_sol == 0 {
        return BuyQuote::default();
    }
    let (vs, vt) = (virtual_sol as u128, virtual_token as u128);
    let k = vs * vt;
    let mut fee = (max_sol as u128 * fee_bps as u128) / BPS as u128;
    let mut sol_in = max_sol as u128 - fee;
    let mut new_vs = vs + sol_in;
    let mut new_vt = div_up(k, new_vs);
    let mut tokens_out = vt - new_vt;

    let remaining = (CURVE_SUPPLY - tokens_sold) as u128;
    if tokens_out >= remaining {
        tokens_out = remaining;
        new_vt = vt - remaining;
        new_vs = div_up(k, new_vt);
        sol_in = new_vs - vs;
        fee = if fee_bps == 0 { 0 } else { div_up(sol_in * fee_bps as u128, (BPS - fee_bps) as u128) };
        if sol_in + fee > max_sol as u128 {
            fee = max_sol as u128 - sol_in; // rounding dust
        }
    }
    BuyQuote {
        tokens_out: tokens_out as u64,
        sol_in: sol_in as u64,
        fee: fee as u64,
        new_virtual_sol: new_vs as u64,
        new_virtual_token: new_vt as u64,
    }
}

/// Quote selling `token_amount` back to the curve. Never pays out more than `real_sol`.
pub fn quote_sell(virtual_sol: u64, virtual_token: u64, real_sol: u64, token_amount: u64, fee_bps: u64) -> SellQuote {
    if token_amount == 0 {
        return SellQuote { new_virtual_sol: virtual_sol, new_virtual_token: virtual_token, ..Default::default() };
    }
    let (vs, vt) = (virtual_sol as u128, virtual_token as u128);
    let new_vt = vt + token_amount as u128;
    let mut new_vs = div_up(vs * vt, new_vt);
    let mut gross = vs - new_vs;
    if gross > real_sol as u128 {
        gross = real_sol as u128;
        new_vs = vs - gross;
    }
    let fee = (gross * fee_bps as u128) / BPS as u128;
    SellQuote {
        sol_out: (gross - fee) as u64,
        fee: fee as u64,
        gross: gross as u64,
        new_virtual_sol: new_vs as u64,
        new_virtual_token: new_vt as u64,
    }
}

/// Tokens to pair with `liquidity_sol` so the pool opens at the curve's final price.
pub fn lp_tokens_for(liquidity_sol: u64, virtual_sol: u64, virtual_token: u64) -> u64 {
    let t = (liquidity_sol as u128 * virtual_token as u128) / virtual_sol as u128;
    t.min(LP_RESERVE as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    const VS: u64 = 42_500_000_000; // 42.5 SOL

    #[test]
    fn filling_the_curve_raises_twice_the_virtual_sol() {
        let q = quote_buy(VS, INITIAL_VIRTUAL_TOKEN, 0, u64::MAX / 4, 0);
        assert_eq!(q.tokens_out, CURVE_SUPPLY);
        // R = vS * C / (vT - C) = 42.5 * 750 / 375 = 85 SOL
        assert!((q.sol_in as i128 - 85_000_000_000).abs() <= 1, "{}", q.sol_in);
    }

    #[test]
    fn pool_price_matches_curve_end_price() {
        let q = quote_buy(VS, INITIAL_VIRTUAL_TOKEN, 0, u64::MAX / 4, 0);
        let lp = lp_tokens_for(q.sol_in, q.new_virtual_sol, q.new_virtual_token);
        // Should need (almost) exactly the LP reserve: no arbitrage gap, nothing to burn.
        assert!(LP_RESERVE - lp < 1_000_000, "lp {lp}"); // < 1 whole token
    }

    #[test]
    fn capped_buy_charges_fee_on_used_sol_only() {
        let q = quote_buy(VS, INITIAL_VIRTUAL_TOKEN, 0, 200_000_000_000, 100);
        assert_eq!(q.tokens_out, CURVE_SUPPLY);
        assert!(q.sol_in + q.fee < 200_000_000_000);
        let implied = q.fee as u128 * 9_900 / q.sol_in as u128;
        assert!((implied as i128 - 100).abs() <= 1);
    }

    #[test]
    fn round_trip_never_profits() {
        let mut vs = VS;
        let mut vt = INITIAL_VIRTUAL_TOKEN;
        let mut real = 0u64;
        let mut sold = 0u64;
        for amt in [1_000_000u64, 3_000_000_000, 17, 50_000_000_000, 999] {
            let b = quote_buy(vs, vt, sold, amt, 100);
            vs = b.new_virtual_sol; vt = b.new_virtual_token; real += b.sol_in; sold += b.tokens_out;
            let s = quote_sell(vs, vt, real, b.tokens_out, 100);
            assert!(s.sol_out + s.fee <= b.sol_in, "profit on round trip");
            vs = s.new_virtual_sol; vt = s.new_virtual_token; real -= s.gross; sold -= b.tokens_out;
            assert_eq!(vs - VS, real, "virtual/real drift");
        }
    }
}
