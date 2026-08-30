//! Oddie's pari-mutuel market program, v0.2.
//!
//! WHY THIS EXISTS. A program with this shape is already deployed on devnet at
//! Ao8tBMVCUMMYAm8cbq2qehP78RCK5xNAPyaXv9TH5FZT, but its source never landed in
//! this repo. Its `Market` account has no creator field and it has no
//! fee-taking instruction, so there is nowhere to record who the 3% is owed to
//! and no way to pay the creator. That is exactly why `economy.ts` has to describe
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
//!      silent no-op, so a double-submitted transaction cannot pay twice. A
//!      claimed Position is also CLOSED, which returns its rent and makes the
//!      second attempt stronger still: the account is gone, so there is nothing
//!      left to pay from. The error shape changes with it, from AlreadyClaimed
//!      to a missing account, and callers must read it as "already collected"
//!      rather than "never staked".
//!
//! NOT DEPLOYED AND NOT WIRED. Nothing in src/ imports this. The server still
//! gates every on-chain path behind ONCHAIN_ENABLED, which defaults to false.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;
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
/// Oddie's own cut has the same 10% ceiling as the creator's, and for the same
/// reason: a rate is a promise to people whose money is already in the vault,
/// so the program should refuse to encode one nobody would have staked into.
pub const MAX_PROTOCOL_FEE_BPS: u16 = 1_000;
/// The ceiling that actually protects a staker. Two 10% fees are a 20% takeout,
/// which is horse-racing territory and not what anyone thinks they are agreeing
/// to. 10% total, whatever the split.
pub const MAX_TOTAL_FEE_BPS: u16 = 1_000;

/// How long after close a market may sit unresolved before anyone may take
/// their own stake back.
///
/// Every other exit here runs through the authority: only it can resolve, and
/// claim_winnings requires a resolution. So an authority that stops signing,
/// for any reason at all, locks every staker's money forever with no
/// instruction that can free it. "Non-custodial" is not true of a vault whose
/// only door is one key that may never turn again.
///
/// Thirty days is deliberately long. It is not a dispute window and it is not
/// a way to duck a verdict you dislike: it is far past any honest settlement,
/// so reaching it means nobody settled at all. Anything shorter would let a
/// staker walk out of a market that is merely late.
pub const REFUND_AFTER_CLOSE_SECS: i64 = 30 * 24 * 60 * 60;

#[program]
pub mod oddie_chain {
    use super::*;

    /// Open a market. `creator` is passed explicitly rather than taken from the
    /// signer: markets are minted by Oddie's admin key on behalf of whoever
    /// tagged the argument on X, and that person is very often not present and
    /// has no wallet yet. Recording them here is what makes the fee payable to
    /// them later, and it is the on-chain half of `market_surfacer`.
    ///
    /// Pass `Pubkey::default()` when the tagger has no wallet yet, which is the
    /// normal case at tag time, and name them later with `set_creator`. That is
    /// a one-way fill, so an unnamed market stays claimable by the right person
    /// whenever they turn up, while a named one can never be redirected.
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
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(question.len() <= MAX_QUESTION_LEN, OddieError::QuestionTooLong);
        require!(creator_fee_bps <= MAX_CREATOR_FEE_BPS, OddieError::FeeTooHigh);
        require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, OddieError::FeeTooHigh);
        // The cap that matters is the TOTAL. Two individually reasonable rates
        // still add up to a takeout, and the number a staker actually loses is
        // the sum, so that is the number with a ceiling on it.
        require!(
            (creator_fee_bps as u32) + (protocol_fee_bps as u32) <= MAX_TOTAL_FEE_BPS as u32,
            OddieError::FeeTooHigh
        );
        let clock = Clock::get()?;
        require!(close_time > clock.unix_timestamp, OddieError::CloseTimeInPast);

        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.creator = creator;
        m.market_id = market_id;
        m.question_hash = hash(question.as_bytes()).to_bytes();
        m.close_time = close_time;
        m.resolved = false;
        m.winning_side = 0;
        m.total_yes = 0;
        m.total_no = 0;
        m.creator_fee_bps = creator_fee_bps;
        m.creator_fee_lamports = 0;
        m.creator_fee_claimed = false;
        m.protocol_fee_bps = protocol_fee_bps;
        m.protocol_fee_lamports = 0;
        m.protocol_fee_claimed = false;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;

        let v = &mut ctx.accounts.vault;
        v.market = m.key();
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Name the creator of a market that was opened without one.
    ///
    /// Markets are minted the moment someone tags the argument on X, and that
    /// person usually has no wallet at that moment. `create_market` therefore
    /// accepts `Pubkey::default()` as "not named yet", and this fills it in
    /// once they connect one. Without this the fee has no payable address and
    /// "being loud pays" is not true in real money, which is the whole point.
    ///
    /// ONE WAY, and that is the only security property here. A creator can be
    /// named, never renamed and never cleared, so a fee already promised to
    /// somebody cannot be redirected. It deliberately does NOT require the
    /// market to be unresolved: a tagger who connects a wallet a week after
    /// their market settled should still get paid, and gating on resolution
    /// would only strand them. That costs nothing in trust, because the
    /// authority can already name any creator at create time and can already
    /// resolve any market. This adds no power it did not have; it only moves
    /// when the name can be supplied.
    ///
    /// The unset sentinel is safe to leave in place indefinitely: no private
    /// key exists for the all-zero pubkey, so `claim_creator_fee`'s
    /// `has_one = creator` on a Signer can never be satisfied while unset.
    pub fn set_creator(ctx: Context<SetCreator>, creator: Pubkey) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.creator == Pubkey::default(), OddieError::CreatorAlreadySet);
        require!(creator != Pubkey::default(), OddieError::CreatorNotNamed);
        m.creator = creator;
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
        // NO CLOSE-TIME GUARD HERE, DELIBERATELY, and it is not an oversight
        // even though take_position has one. A review flagged the asymmetry, I
        // added `clock >= close_time`, and twelve tests broke for the right
        // reason: they open a market and settle it at once, which is what real
        // early resolution looks like. A question with a close in October can be
        // decided in August, and holding the pool until October then locks real
        // money for two months to protect against nothing the outcome changes.
        // The risk the guard was aimed at, an authority settling a live market,
        // is a process and key-custody problem; a compromised authority can do
        // far worse than resolve early.

        m.resolved = true;
        m.winning_side = outcome;

        let winning_total = if outcome == SIDE_YES { m.total_yes } else { m.total_no };
        let pool = m.total_yes.checked_add(m.total_no).ok_or(OddieError::MathOverflow)?;

        // Both fees are fixed here and both are zero when nobody won, because a
        // pool with no winners is refunded in full and taking a cut of a refund
        // would be charging people for our own inability to price the question.
        let bps_to_lamports = |bps: u16| -> Result<u64> {
            if winning_total == 0 {
                return Ok(0);
            }
            // NOBODY TOOK THE OTHER SIDE, so there is nothing to win and nothing
            // to take a cut of. pool == winning_total means every lamport in the
            // vault belongs to somebody who was right, and charging them is
            // charging winners on their own returned stake: they would get 96%
            // of their money back for a market that never had a counterparty.
            // Same principle as the refund case directly above.
            if pool == winning_total {
                return Ok(0);
            }
            // u128 for the intermediate: pool * 1000 overflows u64 at ~1.8e16
            // lamports, which is only ~18M SOL, and a program that is correct
            // only below a certain pool size is not correct.
            let fee = (pool as u128)
                .checked_mul(bps as u128)
                .ok_or(OddieError::MathOverflow)?
                / 10_000u128;
            u64::try_from(fee).map_err(|_| OddieError::MathOverflow.into())
        };
        m.creator_fee_lamports = bps_to_lamports(m.creator_fee_bps)?;
        m.protocol_fee_lamports = bps_to_lamports(m.protocol_fee_bps)?;
        Ok(())
    }

    /// Take what you are owed: a share of the pool if you were right, or your
    /// stake back if nobody was.
    ///
    /// The refund branch is not a courtesy. A pari-mutuel pool with no winners
    /// has no formula, and the alternatives are keeping the money or inventing
    /// a rule; returning it is the only one of the three that is not a
    /// confiscation.
    /// Take your own stake back from a market nobody ever settled.
    ///
    /// PERMISSIONLESS AND ONLY OVER YOUR OWN POSITION. The authority is not a
    /// signer here and cannot be: this instruction exists precisely for the
    /// case where the authority is gone, so requiring it would be requiring the
    /// thing that failed. Every account is derived from seeds, so a caller can
    /// only ever reach their own position, and the refund is exactly what they
    /// put in.
    ///
    /// It cannot be used to escape a verdict. `!m.resolved` is checked first,
    /// so the moment a market HAS an outcome this door closes and
    /// claim_winnings is the only way out, whether you won or lost. The window
    /// opens thirty days after close, which is far past any honest settlement.
    ///
    /// No fee is taken. A fee is the price of a market working; this is the
    /// path for one that did not.
    pub fn refund_after_deadline(ctx: Context<RefundAfterDeadline>) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(!m.resolved, OddieError::AlreadyResolved);

        let clock = Clock::get()?;
        let opens_at = m
            .close_time
            .checked_add(REFUND_AFTER_CLOSE_SECS)
            .ok_or(OddieError::MathOverflow)?;
        require!(clock.unix_timestamp > opens_at, OddieError::RefundNotYetOpen);

        let pos = &mut ctx.accounts.position;
        require!(!pos.claimed, OddieError::AlreadyClaimed);
        require!(pos.amount > 0, OddieError::ZeroAmount);

        // Marked before the transfer, exactly as claim_winnings does: if the
        // transfer fails the whole instruction reverts and the flag goes with
        // it, so this can never strand a position as refunded-but-unpaid.
        pos.claimed = true;
        let amount = pos.amount;
        pay_from_vault(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            amount,
        )?;
        Ok(())
    }

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
                .ok_or(OddieError::MathOverflow)?
                .checked_sub(m.protocol_fee_lamports)
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
        // re-entrant path paying twice. Kept even though `close = owner` makes
        // it unreadable afterwards: it is the guard that holds WITHIN this
        // instruction, before the account goes anywhere.
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

    /// Give back the rent on a market nobody ever used.
    ///
    /// Opening a market costs oddie a rent deposit for the Market and Vault
    /// accounts and NOTHING gives it back, so every market that was opened and
    /// then ignored is a permanent loss. This returns it.
    ///
    /// THE CONDITION IS NARROW ON PURPOSE, and the reason is worth stating
    /// because a wider one looks obviously better and is not. `claim_winnings`
    /// carries `close = owner`, so a LOSER still has a reason to call it: the
    /// payout is zero but their position's own rent comes back. That claim needs
    /// this market account to exist. Closing a market that anyone ever staked
    /// into would therefore strand somebody else's rent to recover our own,
    /// which is a trade we do not get to make on their behalf.
    ///
    /// So: only a market with an empty pool, and only once it is over. Nobody
    /// staked, so there is no position to strand, no payout to owe and no fee to
    /// pay. That is precisely the residue that lazy minting leaves behind, which
    /// is the case this exists for.
    ///
    /// A market WITH stakes stays open forever until everyone has claimed. That
    /// is not an oversight; it is the same rule as everywhere else here, that
    /// the house does not get to close a door somebody else is still standing in.
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        let m = &ctx.accounts.market;

        // THE MONEY IS CHECKED, NOT A DECODED CLAIM ABOUT THE MONEY.
        //
        // total_yes and total_no come out of the Market account, and this
        // instruction closes accounts written by OTHER versions of this
        // program. Anchor derives a discriminator from the struct NAME, so an
        // account laid out by an older version passes the gate and is then read
        // at the wrong offsets: fields land on each other's bytes and a pool
        // with real SOL in it can decode as empty. Guarding an irreversible
        // `close = authority` on those bytes means the guard is evaluated
        // against exactly the corruption it exists to catch, and the failure
        // mode is draining somebody else's stake into the admin wallet.
        //
        // The vault's lamport balance cannot be misread. It is the runtime's
        // own number, it is what would actually be swept, and it is above its
        // own rent if and only if somebody staked. So it is the load-bearing
        // check, and the decoded totals stay only as a cheap early-out for the
        // ordinary case.
        let vault_ai = ctx.accounts.vault.to_account_info();
        let vault_rent = Rent::get()?.minimum_balance(vault_ai.data_len());
        require!(vault_ai.lamports() <= vault_rent, OddieError::MarketHasStakes);
        require!(m.total_yes == 0 && m.total_no == 0, OddieError::MarketHasStakes);
        // Over, so nobody is going to stake now: resolved, or simply past its
        // close. Either is enough, and the second matters because an ignored
        // market is usually one nobody bothered to resolve either.
        let clock = Clock::get()?;
        require!(m.resolved || clock.unix_timestamp > m.close_time, OddieError::MarketStillOpen);
        Ok(())
    }

    /// The creator's cut, pulled by the person it belongs to.
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

    /// Oddie's cut, pulled by the authority that opened the market.
    ///
    /// Pull rather than push, mirroring claim_creator_fee, and the reason is
    /// the same one: resolve should move no money at all. A settlement that
    /// carries a transfer is a settlement that can fail for a reason unrelated
    /// to the outcome, and everyone waiting on that market pays for it.
    ///
    /// `has_one = authority` over a Signer is what makes this ours and only
    /// ours. It is the same key that created and resolved the market, so this
    /// grants no power that did not already exist.
    pub fn claim_protocol_fee(ctx: Context<ClaimProtocolFee>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.resolved, OddieError::NotResolved);
        require!(!m.protocol_fee_claimed, OddieError::AlreadyClaimed);
        require!(m.protocol_fee_lamports > 0, OddieError::NoFeeOwed);

        let amount = m.protocol_fee_lamports;
        m.protocol_fee_claimed = true;

        pay_from_vault(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
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
pub struct SetCreator<'info> {
    /// `has_one = authority` is what keeps this instruction the house's own:
    /// nobody but the key that opened the market can name its creator.
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
pub struct RefundAfterDeadline<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// Seeded on the caller's own key, so nobody can refund anybody else, and
    /// closed to them like every other exit so the position rent comes back too.
    #[account(
        mut,
        close = owner,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner @ OddieError::WrongOwner
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    /// Rent goes back to whoever put it up, which `has_one` below pins to the
    /// key that opened the market. Nobody else can call this and nobody else
    /// can be paid by it.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = authority @ OddieError::WrongAuthority
    )]
    pub market: Account<'info, Market>,
    /// Closed in the same instruction. With an empty pool it holds nothing but
    /// its own rent, and leaving it behind would strand most of what this
    /// instruction exists to recover.
    #[account(
        mut,
        close = authority,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump
    )]
    pub vault: Account<'info, Vault>,
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
        // THE RENT COMES BACK. A Position costs its owner about 0.00147 SOL to
        // open and nothing ever returned it: the account outlived the market it
        // belonged to, holding somebody's money for a market that had finished.
        // Closing it on claim hands that back, to LOSERS as well as winners,
        // which is also the first reason a loser has ever had to come back and
        // press the button.
        close = owner,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner @ OddieError::WrongOwner
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct ClaimProtocolFee<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = authority @ OddieError::WrongAuthority
    )]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, Vault>,
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
    /// SHA-256 of the question, not the question.
    ///
    /// The full text is still on chain and still permanent: it is an argument to
    /// `create_market`, so it lives in that transaction's instruction data
    /// forever. Storing a second copy in account state meant paying rent for the
    /// rest of time for bytes the ledger already had, and it was 184 of this
    /// account's 306: 59% of the struct, for a field NO INSTRUCTION READS.
    ///
    /// The hash keeps the only property that copy actually bought. Anyone can
    /// check that the question oddie shows for a market is the question the
    /// market was opened with, and 184 bytes did not make that check stronger
    /// than 32 do.
    pub question_hash: [u8; 32],
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
    /// Oddie's own cut, and stored per market for exactly the same reason the
    /// creator's is: a rate change must never reprice a pool people already
    /// staked into. Markets opened while this was zero settle at zero forever.
    pub protocol_fee_bps: u16,
    pub protocol_fee_lamports: u64,
    pub protocol_fee_claimed: bool,
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
    #[msg("this market's creator is already named and cannot be changed")]
    CreatorAlreadySet,
    #[msg("creator cannot be set to the unnamed address")]
    CreatorNotNamed,
    #[msg("arithmetic overflow")]
    MathOverflow,
    // Appended, never inserted: this enum is positional, and putting a variant
    // in the middle silently renumbers every error after it for any client
    // built against the old order.
    #[msg("a market that anyone staked into cannot be closed")]
    MarketHasStakes,
    #[msg("market is neither resolved nor past its close time")]
    MarketStillOpen,
    #[msg("the refund window has not opened yet")]
    RefundNotYetOpen,
}
