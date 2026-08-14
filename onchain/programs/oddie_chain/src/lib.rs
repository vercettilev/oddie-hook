//! Oddie's pari-mutuel market program, v0.2.
//!
//! WHY THIS EXISTS. A program with this shape is already deployed on devnet at
//! Ao8tBMVCUMMYAm8cbq2qehP78RCK5xNAPyaXv9TH5FZT, but its source never landed in
//! this repo. Its `Market` account has no creator field and it has no
//! fee-taking instruction, so there is nowhere to record who the 3% is owed to
//! and no way to pay it. That is exactly why `economy.ts` has to describe
//! CREATOR_FEE_BPS_REAL as a proposed rate that is "logged as an intended fee"
//! and never actually charged. The creator fee is the whole reason a stranger
//! bothers to tag a market into existence, so a program that cannot pay it
//! cannot carry this product's economics. This one is ours and it can.
//!
//! THE ONE ECONOMIC DIFFERENCE FROM THE PLAY ECONOMY, STATED UP FRONT. Off
//! chain, `creatorFeePlay` is an ADDITIVE grant: the house funds it, and it
//! structurally cannot make anyone's payout smaller (see economy.ts). On chain
//! there is no house. The vault holds exactly what was staked and not one
//! lamport more, so the fee necessarily comes OUT of the pool and winners are
//! paid from what is left. Anyone porting the off-chain copy to a real-money
//! market has to change the words as well as the numbers: here the fee is a
//! deduction, and the UI must say so.
//!
//! SAFETY PROPERTIES THE TESTS PIN:
//!   1. The vault can always cover every claim. The fee is computed ONCE, at
//!      resolve, and reserved on the market account; payouts are computed
//!      against pool-minus-fee, so a winner and the creator can never be
//!      promised the same lamport.
//!   2. Integer division truncates every payout, so the sum of claims is always
//!      at most the distributable amount. The remainder is dust that stays in
//!      the vault. Never round up here: rounding up is how a pari-mutuel pool
//!      ends up one lamport short for the last claimant.
//!   3. Nothing can drain the vault below rent exemption, which would delete
//!      the account and strand every unclaimed position.
//!   4. Every claim is idempotent. `claimed` / `creator_fee_claimed` are set
//!      before the transfer, and a second attempt is a hard error rather than a
//!      silent no-op, so a double-submitted transaction cannot pay twice.
//!
//! NOT DEPLOYED AND NOT WIRED. Nothing in src/ imports this. The server still
//! gates every on-chain path behind ONCHAIN_ENABLED, which defaults to false.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu");

/// Sides. Kept as a raw u8 across the instruction boundary to match the
/// deployed program's ABI, so the existing client (`preparePositionTx` passes a
/// u8) does not have to change shape.
pub const SIDE_YES: u8 = 0;
pub const SIDE_NO: u8 = 1;

/// Matches the 180-character ceiling the off-chain create route already
/// enforces, so a question that passes validation there can never fail here.
pub const MAX_QUESTION_LEN: usize = 180;

/// Ceiling on the creator fee, enforced by the program rather than trusted from
/// the caller. The rate is an argument so it can be tuned per market, but a
/// market that could be created with a 90% creator fee is a rug with extra
/// steps, and "the admin would never" is not a property. 10% is well above the
/// 2% economy.ts proposes and well below anything predatory.
pub const MAX_CREATOR_FEE_BPS: u16 = 1_000;

#[program]
pub mod oddie_chain {
    use super::*;

    /// Open a market. `creator` is passed explicitly rather than taken from the
    /// signer: markets are minted by Oddie's admin key on behalf of whoever
    /// tagged the argument on X, and that person is very often not present and
    /// has no wallet yet. Recording them here is what makes the fee payable to
    /// them later, and it is the on-chain half of `market_surfacer`.
    ///
    /// A creator who never connects a wallet simply never claims; the fee stays
    /// in the vault as dust rather than being redirected to the house, because
    /// silently rerouting someone's fee to ourselves is worse than leaving it
    /// unclaimed.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        question: String,
        close_time: i64,
        creator: Pubkey,
        creator_fee_bps: u16,
    ) -> Result<()> {
        require!(question.len() <= MAX_QUESTION_LEN, OddieError::QuestionTooLong);
        require!(creator_fee_bps <= MAX_CREATOR_FEE_BPS, OddieError::FeeTooHigh);
        let clock = Clock::get()?;
        require!(close_time > clock.unix_timestamp, OddieError::CloseTimeInPast);

        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.creator = creator;
        m.market_id = market_id;
        m.question = question;
        m.close_time = close_time;
        m.resolved = false;
        m.winning_side = 0;
        m.total_yes = 0;
        m.total_no = 0;
        m.creator_fee_bps = creator_fee_bps;
        m.creator_fee_lamports = 0;
        m.creator_fee_claimed = false;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;

        let v = &mut ctx.accounts.vault;
        v.market = m.key();
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Stake on a side. One position account per (market, user), so a second
    /// call from the same wallet ADDS to the existing stake rather than opening
    /// a rival one: two positions for one person on one market would make the
    /// payout maths ambiguous and the UI worse.
    ///
    /// Switching sides is refused rather than silently re-staking. Someone who
    /// wants the other side of their own call is asking for something this
    /// program does not do, and quietly moving their money is the wrong answer
    /// to that.
    pub fn take_position(ctx: Context<TakePosition>, side: u8, amount: u64) -> Result<()> {
        require!(side == SIDE_YES || side == SIDE_NO, OddieError::BadSide);
        require!(amount > 0, OddieError::ZeroAmount);

        let clock = Clock::get()?;
        require!(!ctx.accounts.market.resolved, OddieError::AlreadyResolved);
        require!(clock.unix_timestamp < ctx.accounts.market.close_time, OddieError::MarketClosed);

        let pos = &mut ctx.accounts.position;
        if pos.amount == 0 {
            pos.market = ctx.accounts.market.key();
            pos.owner = ctx.accounts.user.key();
            pos.side = side;
            pos.claimed = false;
            pos.bump = ctx.bumps.position;
        } else {
            require!(pos.side == side, OddieError::SideAlreadyTaken);
            require!(!pos.claimed, OddieError::AlreadyClaimed);
        }

        // Move the lamports BEFORE crediting the totals. A failed transfer must
        // not leave a market claiming stake it never received.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        pos.amount = pos.amount.checked_add(amount).ok_or(OddieError::MathOverflow)?;
        let m = &mut ctx.accounts.market;
        if side == SIDE_YES {
            m.total_yes = m.total_yes.checked_add(amount).ok_or(OddieError::MathOverflow)?;
        } else {
            m.total_no = m.total_no.checked_add(amount).ok_or(OddieError::MathOverflow)?;
        }
        Ok(())
    }

    /// Settle, and fix the creator fee for good.
    ///
    /// The fee is computed HERE and stored, not recomputed per claim. If each
    /// claim recomputed it from live totals it would be a moving number, and
    /// the last claimant would be the one who absorbs the drift. Fixing it once
    /// at resolve makes every subsequent payout a pure function of numbers that
    /// can no longer change.
    ///
    /// NO FEE WHEN THERE ARE NO WINNERS. If nobody backed the winning side the
    /// market pays refunds instead of winnings (see claim_winnings), and taking
    /// a cut of a refund would mean charging people to be given their own money
    /// back.
    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: u8) -> Result<()> {
        require!(outcome == SIDE_YES || outcome == SIDE_NO, OddieError::BadSide);
        let m = &mut ctx.accounts.market;
        require!(!m.resolved, OddieError::AlreadyResolved);

        m.resolved = true;
        m.winning_side = outcome;

        let winning_total = if outcome == SIDE_YES { m.total_yes } else { m.total_no };
        let pool = m.total_yes.checked_add(m.total_no).ok_or(OddieError::MathOverflow)?;

        m.creator_fee_lamports = if winning_total == 0 {
            0
        } else {
            // u128 for the intermediate: pool * 1000 overflows u64 at ~1.8e16
            // lamports, which is only ~18M SOL, and a program that is correct
            // only below a certain pool size is not correct.
            let fee = (pool as u128)
                .checked_mul(m.creator_fee_bps as u128)
                .ok_or(OddieError::MathOverflow)?
                / 10_000u128;
            u64::try_from(fee).map_err(|_| OddieError::MathOverflow)?
        };
        Ok(())
    }

    /// Take what you are owed: a share of the pool if you were right, or your
    /// stake back if nobody was.
    ///
    /// The refund branch is not a courtesy. A pari-mutuel pool with no winners
    /// has no formula, and the alternatives are keeping the money or inventing
    /// a rule; returning it is the only one of the three that is not a
    /// confiscation.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(m.resolved, OddieError::NotResolved);

        let pos = &mut ctx.accounts.position;
        require!(!pos.claimed, OddieError::AlreadyClaimed);
        require!(pos.amount > 0, OddieError::ZeroAmount);

        let winning_total = if m.winning_side == SIDE_YES { m.total_yes } else { m.total_no };
        let pool = m.total_yes.checked_add(m.total_no).ok_or(OddieError::MathOverflow)?;

        let payout: u64 = if winning_total == 0 {
            pos.amount // nobody won: everyone is refunded, no fee was taken
        } else if pos.side != m.winning_side {
            0
        } else {
            let distributable = pool
                .checked_sub(m.creator_fee_lamports)
                .ok_or(OddieError::MathOverflow)?;
            // Truncating division, deliberately: see the header. The dust this
            // leaves is what guarantees the last claimant is payable.
            let share = (pos.amount as u128)
                .checked_mul(distributable as u128)
                .ok_or(OddieError::MathOverflow)?
                / winning_total as u128;
            u64::try_from(share).map_err(|_| OddieError::MathOverflow)?
        };

        // Marked before the transfer. If the transfer fails the whole
        // instruction reverts and the flag goes with it, so this cannot strand
        // a position as claimed-but-unpaid; what it does prevent is any
        // re-entrant path paying twice.
        pos.claimed = true;

        if payout > 0 {
            pay_from_vault(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.owner.to_account_info(),
                payout,
            )?;
        }
        Ok(())
    }

    /// The 3%, pulled by the person it belongs to.
    ///
    /// PULL, NOT PUSH, and that is the substantive design choice here. Pushing
    /// at resolve would mean the market cannot settle until the creator has a
    /// funded, rent-exempt account to receive into, which makes settlement for
    /// everybody else depend on a third party who may never have opened a
    /// wallet. It would also hand the resolve transaction a lamport transfer to
    /// an address the resolver does not control. A claim the creator signs
    /// themselves keeps settlement independent of them and proves ownership of
    /// the wallet at the moment of payment.
    pub fn claim_creator_fee(ctx: Context<ClaimCreatorFee>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.resolved, OddieError::NotResolved);
        require!(!m.creator_fee_claimed, OddieError::AlreadyClaimed);
        require!(m.creator_fee_lamports > 0, OddieError::NoFeeOwed);

        let amount = m.creator_fee_lamports;
        m.creator_fee_claimed = true;

        pay_from_vault(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            amount,
        )?;
        Ok(())
    }
}

/// Move lamports out of the vault PDA.
///
/// Not a system_program::transfer: the vault carries data, and the system
/// program refuses to move lamports out of an account it does not own. Direct
/// lamport arithmetic is the supported path for a PDA the program owns.
///
/// The rent-exempt floor is the important part. Draining a data account to zero
/// hands it to the runtime for collection, and a deleted vault strands every
/// position that had not claimed yet. So the vault keeps its own rent, and the
/// balance available to claimants is everything above that.
fn pay_from_vault(vault: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(vault.data_len());
    let available = vault.lamports().saturating_sub(rent);
    require!(available >= amount, OddieError::VaultUnderfunded);

    **vault.try_borrow_mut_lamports()? -= amount;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

// --- accounts ---------------------------------------------------------------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TakePosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    /// Only the key that opened the market can settle it. This is the oracle
    /// and it is a human decision; see the note in the repo about what putting
    /// a market on chain does and does not prove.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = authority @ OddieError::WrongAuthority
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner @ OddieError::WrongOwner
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFee<'info> {
    /// The creator recorded at create time, signing for themselves. `has_one`
    /// is what makes the fee unstealable: no other key can satisfy it.
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = creator @ OddieError::WrongCreator
    )]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, Vault>,
}

// --- state ------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    /// Who the creator fee is owed to. The field the deployed program does not
    /// have, and the reason this one exists.
    pub creator: Pubkey,
    pub market_id: u64,
    #[max_len(180)]
    pub question: String,
    pub close_time: i64,
    pub resolved: bool,
    pub winning_side: u8,
    pub total_yes: u64,
    pub total_no: u64,
    /// Stored per market, so changing the rate later cannot reprice a market
    /// people have already staked into.
    pub creator_fee_bps: u16,
    /// Fixed at resolve. Zero until then, and zero forever if nobody won.
    pub creator_fee_lamports: u64,
    pub creator_fee_claimed: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub market: Pubkey,
    pub bump: u8,
}

// --- errors -----------------------------------------------------------------

#[error_code]
pub enum OddieError {
    #[msg("question exceeds the 180-character limit")]
    QuestionTooLong,
    #[msg("creator fee exceeds the maximum allowed")]
    FeeTooHigh,
    #[msg("close time must be in the future")]
    CloseTimeInPast,
    #[msg("side must be 0 (yes) or 1 (no)")]
    BadSide,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("market is already resolved")]
    AlreadyResolved,
    #[msg("market is not resolved yet")]
    NotResolved,
    #[msg("market is closed to new positions")]
    MarketClosed,
    #[msg("this wallet already holds the other side of this market")]
    SideAlreadyTaken,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("no creator fee is owed on this market")]
    NoFeeOwed,
    #[msg("vault cannot cover this payout without breaking rent exemption")]
    VaultUnderfunded,
    #[msg("signer is not this market's authority")]
    WrongAuthority,
    #[msg("signer is not this position's owner")]
    WrongOwner,
    #[msg("signer is not this market's creator")]
    WrongCreator,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
