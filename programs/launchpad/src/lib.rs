//! Secretum launchpad.
//!
//! * Anyone launches a 1B-supply Token-2022 coin (name/ticker/image stored on the mint).
//!   Mint, freeze and metadata authorities are revoked at launch.
//! * 750M tokens trade against SOL on a constant-product bonding curve with virtual reserves.
//! * When the curve sells out it is marked complete; anyone can then call `graduate`, which
//!   creates a Raydium CPMM pool with the SOL raised and a price-matched slice of the 250M LP
//!   reserve, burns the LP tokens (liquidity locked forever) and burns any unused tokens.
//! * Every launch gets an on-chain certificate hash. A configured certifier key writes the
//!   Monero / Zcash / HyperEVM transaction ids that anchor that hash on other chains. Each
//!   entry is write-once.
//! * Protocol fees (launch, trading, graduation) accrue in the config account and are split by
//!   `distribute_fees`: dev share (default 10%) to the dev wallet, the rest to the buyback wallet.
//! * Pausing blocks launches and buys only. Selling can never be paused.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self as spl_token_cpi, Token};
use anchor_spl::token_2022::{self, spl_token_2022::instruction::AuthorityType, Token2022};
use anchor_spl::token_interface::{
    spl_pod::optional_keys::OptionalNonZeroPubkey, spl_token_metadata_interface::state::TokenMetadata,
    token_metadata_initialize, token_metadata_update_authority, Mint, TokenAccount, TokenMetadataInitialize,
    TokenMetadataUpdateAuthority,
};

pub mod math;

declare_id!("HPomwh2M3sMcD9LpTALifnT41RQYx3rq7sUn3HrvukpR");

pub mod constants {
    pub const DECIMALS: u8 = 6;
    pub const ONE_TOKEN: u64 = 1_000_000;
    pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * ONE_TOKEN;
    /// Sold on the bonding curve (75%).
    pub const CURVE_SUPPLY: u64 = 750_000_000 * ONE_TOKEN;
    /// Reserved for the Raydium pool at graduation (25%).
    pub const LP_RESERVE: u64 = TOTAL_SUPPLY - CURVE_SUPPLY;
    /// CURVE_SUPPLY² / (CURVE_SUPPLY - LP_RESERVE): makes the pool open at the curve's final price.
    pub const INITIAL_VIRTUAL_TOKEN: u64 = 1_125_000_000 * ONE_TOKEN;

    pub const MAX_TRADE_FEE_BPS: u16 = 200; // 2%
    pub const MAX_CREATION_FEE: u64 = 1_000_000_000; // 1 SOL
    /// Graduation fee must cover Raydium's pool-creation fee (0.15 SOL on mainnet) + rent.
    pub const MIN_GRADUATION_FEE: u64 = 300_000_000; // 0.3 SOL
    pub const MAX_GRADUATION_FEE: u64 = 5_000_000_000; // 5 SOL
    pub const MIN_INITIAL_VIRTUAL_SOL: u64 = 1_000_000_000; // 1 SOL
    pub const MAX_INITIAL_VIRTUAL_SOL: u64 = 1_000_000_000_000; // 1000 SOL

    pub const MAX_NAME_LEN: usize = 32;
    pub const MAX_SYMBOL_LEN: usize = 10;
    pub const MAX_URI_LEN: usize = 200;

    pub const CERT_MONERO: u8 = 0;
    pub const CERT_ZCASH: u8 = 1;
    pub const CERT_HYPEREVM: u8 = 2;

    pub const CONFIG_SEED: &[u8] = b"config";
    pub const CURVE_SEED: &[u8] = b"curve";
    /// System-owned PDA per coin: holds the SOL raised on the curve, then creates the Raydium pool.
    pub const POOL_CREATOR_SEED: &[u8] = b"pool_creator";
    pub const POOL_SEED: &[u8] = b"pool";
    pub const CERT_DOMAIN: &[u8] = b"SECRETUM-CERT-V1";
}
use constants::*;

pub mod wsol {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
}

#[program]
pub mod launchpad {
    use super::*;

    /// One-time setup. The signer becomes admin.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.bump = ctx.bumps.config;
        params.apply(c);
        check_amm_config(&ctx.accounts.raydium_amm_config, &c.raydium_amm_config)?;
        Ok(())
    }

    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        check_amm_config(&ctx.accounts.raydium_amm_config, &params.raydium_amm_config)?;
        params.apply(&mut ctx.accounts.config);
        emit!(ConfigUpdated { config: params });
        Ok(())
    }

    /// Step 1 of an admin handover; the new admin must call `accept_admin`.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require_keys_eq!(c.pending_admin, ctx.accounts.new_admin.key(), LaunchpadError::Unauthorized);
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Launch a coin. `dev_buy_lamports` (optional) is the creator's first buy, done atomically
    /// in the same transaction so it can't be sniped.
    pub fn create_token(
        ctx: Context<CreateToken>,
        name: String,
        symbol: String,
        uri: String,
        dev_buy_lamports: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, LaunchpadError::Paused);
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, LaunchpadError::InvalidMetadata);
        require!(!symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN, LaunchpadError::InvalidMetadata);
        require!(uri.len() <= MAX_URI_LEN, LaunchpadError::InvalidMetadata);

        let mint_key = ctx.accounts.mint.key();
        let curve_bump = ctx.bumps.curve;
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        let signer = &[curve_seeds];

        // --- metadata on the mint (Token-2022 metadata extension)
        let meta = TokenMetadata {
            update_authority: OptionalNonZeroPubkey::try_from(Some(ctx.accounts.curve.key()))?,
            mint: mint_key,
            name: name.clone(),
            symbol: symbol.clone(),
            uri: uri.clone(),
            additional_metadata: vec![],
        };
        let mint_info = ctx.accounts.mint.to_account_info();
        let new_len = mint_info.data_len() + meta.tlv_size_of().map_err(|_| LaunchpadError::InvalidMetadata)?;
        let need = Rent::get()?.minimum_balance(new_len).saturating_sub(mint_info.lamports());
        if need > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program::ID,
                    system_program::Transfer { from: ctx.accounts.creator.to_account_info(), to: mint_info.clone() },
                ),
                need,
            )?;
        }
        token_metadata_initialize(
            CpiContext::new_with_signer(
                token_2022::ID,
                TokenMetadataInitialize {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    metadata: mint_info.clone(),
                    update_authority: ctx.accounts.curve.to_account_info(),
                    mint_authority: ctx.accounts.curve.to_account_info(),
                    mint: mint_info.clone(),
                },
                signer,
            ),
            name.clone(),
            symbol.clone(),
            uri.clone(),
        )?;
        // Metadata is now immutable.
        token_metadata_update_authority(
            CpiContext::new_with_signer(
                token_2022::ID,
                TokenMetadataUpdateAuthority {
                    program_id: ctx.accounts.token_program.to_account_info(),
                    metadata: mint_info.clone(),
                    current_authority: ctx.accounts.curve.to_account_info(),
                    new_authority: ctx.accounts.curve.to_account_info(),
                },
                signer,
            ),
            OptionalNonZeroPubkey::default(),
        )?;

        // --- mint full supply to the curve vault, then revoke the mint authority forever
        token_2022::mint_to(
            CpiContext::new_with_signer(
                token_2022::ID,
                token_2022::MintTo {
                    mint: mint_info.clone(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                signer,
            ),
            TOTAL_SUPPLY,
        )?;
        token_2022::set_authority(
            CpiContext::new_with_signer(
                token_2022::ID,
                token_2022::SetAuthority {
                    current_authority: ctx.accounts.curve.to_account_info(),
                    account_or_mint: mint_info.clone(),
                },
                signer,
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        // --- creation fee
        let creation_fee = ctx.accounts.config.creation_fee;
        if creation_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program::ID,
                    system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.config.to_account_info(),
                    },
                ),
                creation_fee,
            )?;
        }

        // --- SOL vault: a system-owned PDA must stay rent-exempt, so seed it with the minimum.
        let vault_rent = Rent::get()?.minimum_balance(0);
        let vault_has = ctx.accounts.sol_vault.lamports();
        if vault_has < vault_rent {
            system_program::transfer(
                CpiContext::new(
                    system_program::ID,
                    system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.sol_vault.to_account_info(),
                    },
                ),
                vault_rent - vault_has,
            )?;
        }

        // --- curve state + certificate hash
        let clock = Clock::get()?;
        let creator = ctx.accounts.creator.key();
        let launch_hash = certificate_hash(&mint_key, &creator, &name, &symbol, &uri, clock.slot, clock.unix_timestamp);
        let config = &mut ctx.accounts.config;
        config.fees_accrued = config.fees_accrued.checked_add(creation_fee).unwrap();
        config.token_count += 1;
        let curve = &mut ctx.accounts.curve;
        curve.mint = mint_key;
        curve.creator = creator;
        curve.virtual_sol = config.initial_virtual_sol;
        curve.initial_virtual_sol = config.initial_virtual_sol;
        curve.virtual_token = INITIAL_VIRTUAL_TOKEN;
        curve.created_at = clock.unix_timestamp;
        curve.created_slot = clock.slot;
        curve.launch_hash = launch_hash;
        curve.index = config.token_count;
        curve.bump = curve_bump;
        curve.vault_bump = ctx.bumps.sol_vault;

        emit!(TokenCreated {
            mint: mint_key,
            creator,
            name,
            symbol,
            uri,
            launch_hash,
            slot: clock.slot,
            timestamp: clock.unix_timestamp,
        });

        if dev_buy_lamports > 0 {
            do_buy(
                &mut ctx.accounts.curve,
                &mut ctx.accounts.config,
                &ctx.accounts.creator.to_account_info(),
                &ctx.accounts.mint,
                &ctx.accounts.curve_vault.to_account_info(),
                &ctx.accounts.creator_ata.to_account_info(),
                &ctx.accounts.sol_vault.to_account_info(),
                dev_buy_lamports,
                min_tokens_out,
            )?;
        }
        Ok(())
    }

    /// Buy with up to `max_sol` lamports (fee included). If the curve would sell out, only the
    /// SOL needed for the remaining tokens is charged.
    pub fn buy(ctx: Context<Trade>, max_sol: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, LaunchpadError::Paused);
        require!(max_sol > 0, LaunchpadError::ZeroAmount);
        do_buy(
            &mut ctx.accounts.curve,
            &mut ctx.accounts.config,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.mint,
            &ctx.accounts.curve_vault.to_account_info(),
            &ctx.accounts.user_ata.to_account_info(),
            &ctx.accounts.sol_vault.to_account_info(),
            max_sol,
            min_tokens_out,
        )
    }

    /// Sell tokens back to the curve. Works even while the launchpad is paused.
    pub fn sell(ctx: Context<Trade>, token_amount: u64, min_sol_out: u64) -> Result<()> {
        require!(token_amount > 0, LaunchpadError::ZeroAmount);
        let curve = &mut ctx.accounts.curve;
        require!(!curve.complete, LaunchpadError::CurveComplete);
        let fee_bps = ctx.accounts.config.trade_fee_bps as u64;
        let q = math::quote_sell(curve.virtual_sol, curve.virtual_token, curve.real_sol, token_amount, fee_bps);
        require!(q.sol_out > 0 && q.sol_out >= min_sol_out, LaunchpadError::Slippage);

        token_2022::transfer_checked(
            CpiContext::new(
                token_2022::ID,
                token_2022::TransferChecked {
                    from: ctx.accounts.user_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_amount,
            DECIMALS,
        )?;

        let mint_key = ctx.accounts.mint.key();
        let vault_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, mint_key.as_ref(), &[curve.vault_bump]];
        let vault = ctx.accounts.sol_vault.to_account_info();
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer { from: vault.clone(), to: ctx.accounts.user.to_account_info() },
                &[vault_seeds],
            ),
            q.sol_out,
        )?;
        if q.fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    system_program::ID,
                    system_program::Transfer { from: vault.clone(), to: ctx.accounts.config.to_account_info() },
                    &[vault_seeds],
                ),
                q.fee,
            )?;
        }
        curve.virtual_sol = q.new_virtual_sol;
        curve.virtual_token = q.new_virtual_token;
        curve.real_sol -= q.gross;
        curve.tokens_sold -= token_amount;
        ctx.accounts.config.fees_accrued += q.fee;

        emit_trade(curve, ctx.accounts.user.key(), false, q.sol_out, token_amount, q.fee)?;
        Ok(())
    }

    /// Permissionless. Moves a completed curve into a Raydium CPMM pool and locks the liquidity.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.curve.complete, LaunchpadError::CurveNotComplete);
        require!(!a.curve.graduated, LaunchpadError::AlreadyGraduated);

        let mint_key = a.mint.key();
        let curve_bump = a.curve.bump;
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        let pc_seeds: &[&[u8]] = &[POOL_CREATOR_SEED, mint_key.as_ref(), &[ctx.bumps.pool_creator]];
        let pool_seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[ctx.bumps.pool_state]];

        let real_sol = a.curve.real_sol;
        let grad_fee = a.config.graduation_fee;
        require!(real_sol > grad_fee, LaunchpadError::InsufficientLiquidity);
        let liquidity_sol = real_sol - grad_fee;
        let token_liq = math::lp_tokens_for(liquidity_sol, a.curve.virtual_sol, a.curve.virtual_token);
        let to_burn = LP_RESERVE - token_liq;

        // 1. The SOL raised already sits in pool_creator (the coin's SOL vault), which pays
        //    Raydium's rent and pool-creation fee out of the graduation fee.
        let pc_info = a.pool_creator.to_account_info();
        // 2. Token side: pool_creator's Token-2022 ATA gets the LP slice; the rest is burned.
        associated_token::create(CpiContext::new_with_signer(
            associated_token::ID,
            associated_token::Create {
                payer: pc_info.clone(),
                associated_token: a.pool_creator_token.to_account_info(),
                authority: pc_info.clone(),
                mint: a.mint.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_2022_program.to_account_info(),
            },
            &[pc_seeds],
        ))?;
        token_2022::transfer_checked(
            CpiContext::new_with_signer(
                token_2022::ID,
                token_2022::TransferChecked {
                    from: a.curve_vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.pool_creator_token.to_account_info(),
                    authority: a.curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            token_liq,
            DECIMALS,
        )?;
        if to_burn > 0 {
            token_2022::burn(
                CpiContext::new_with_signer(
                    token_2022::ID,
                    token_2022::Burn {
                        mint: a.mint.to_account_info(),
                        from: a.curve_vault.to_account_info(),
                        authority: a.curve.to_account_info(),
                    },
                    &[curve_seeds],
                ),
                to_burn,
            )?;
        }

        // 3. SOL side: wrap liquidity_sol into pool_creator's WSOL ATA.
        associated_token::create(CpiContext::new_with_signer(
            associated_token::ID,
            associated_token::Create {
                payer: pc_info.clone(),
                associated_token: a.pool_creator_wsol.to_account_info(),
                authority: pc_info.clone(),
                mint: a.wsol_mint.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
            },
            &[pc_seeds],
        ))?;
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer { from: pc_info.clone(), to: a.pool_creator_wsol.to_account_info() },
                &[pc_seeds],
            ),
            liquidity_sol,
        )?;
        spl_token_cpi::sync_native(CpiContext::new(
            anchor_spl::token::ID,
            spl_token_cpi::SyncNative { account: a.pool_creator_wsol.to_account_info() },
        ))?;

        // 4. Raydium CPMM pool. pool_state is a PDA of *this* program, so nobody can create it
        //    ahead of us to block graduation.
        let token_is_0 = mint_key < wsol::ID;
        let (m0, m1, c0, c1, p0, p1, amt0, amt1) = if token_is_0 {
            (
                a.mint.to_account_info(), a.wsol_mint.to_account_info(),
                a.pool_creator_token.to_account_info(), a.pool_creator_wsol.to_account_info(),
                a.token_2022_program.to_account_info(), a.token_program.to_account_info(),
                token_liq, liquidity_sol,
            )
        } else {
            (
                a.wsol_mint.to_account_info(), a.mint.to_account_info(),
                a.pool_creator_wsol.to_account_info(), a.pool_creator_token.to_account_info(),
                a.token_program.to_account_info(), a.token_2022_program.to_account_info(),
                liquidity_sol, token_liq,
            )
        };
        // Built by hand (not via the generated cpi helper) because Raydium declares pool_state as
        // an unchecked account, so the helper would mark it non-signer; we need it to sign
        // (with our PDA seeds) so Raydium accepts a pool address other than its own default.
        let ray_accounts = raydium_cp_swap::cpi::accounts::Initialize {
                    creator: pc_info.clone(),
                    amm_config: a.amm_config.to_account_info(),
                    authority: a.raydium_authority.to_account_info(),
                    pool_state: a.pool_state.to_account_info(),
                    token_0_mint: m0,
                    token_1_mint: m1,
                    lp_mint: a.lp_mint.to_account_info(),
                    creator_token_0: c0,
                    creator_token_1: c1,
                    creator_lp_token: a.creator_lp_token.to_account_info(),
                    token_0_vault: a.token_0_vault.to_account_info(),
                    token_1_vault: a.token_1_vault.to_account_info(),
                    create_pool_fee: a.create_pool_fee.to_account_info(),
                    observation_state: a.observation_state.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    token_0_program: p0,
                    token_1_program: p1,
                    associated_token_program: a.associated_token_program.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    rent: a.rent.to_account_info(),
        };
        let mut metas = ray_accounts.to_account_metas(None);
        for m in metas.iter_mut() {
            if m.pubkey == a.pool_state.key() {
                m.is_signer = true;
            }
        }
        let ray_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: raydium_cp_swap::ID,
            accounts: metas,
            data: raydium_cp_swap::instruction::Initialize { init_amount_0: amt0, init_amount_1: amt1, open_time: 0 }.data(),
        };
        anchor_lang::solana_program::program::invoke_signed(&ray_ix, &ray_accounts.to_account_infos(), &[pc_seeds, pool_seeds])?;

        // 5. Burn every LP token: liquidity is locked forever.
        let lp_amount = {
            let data = a.creator_lp_token.try_borrow_data()?;
            anchor_spl::token::TokenAccount::try_deserialize(&mut &data[..])?.amount
        };
        spl_token_cpi::burn(
            CpiContext::new_with_signer(
                anchor_spl::token::ID,
                spl_token_cpi::Burn {
                    mint: a.lp_mint.to_account_info(),
                    from: a.creator_lp_token.to_account_info(),
                    authority: pc_info.clone(),
                },
                &[pc_seeds],
            ),
            lp_amount,
        )?;

        // 6. Close the now-empty helper accounts and sweep what's left of the graduation fee
        //    (after Raydium's fee and rent) into protocol fees.
        for (acct, prog) in [
            (a.pool_creator_wsol.to_account_info(), a.token_program.to_account_info()),
            (a.pool_creator_token.to_account_info(), a.token_2022_program.to_account_info()),
            (a.creator_lp_token.to_account_info(), a.token_program.to_account_info()),
        ] {
            let ix = if *prog.key == token_2022::ID {
                anchor_spl::token_2022::spl_token_2022::instruction::close_account(prog.key, acct.key, pc_info.key, pc_info.key, &[])?
            } else {
                anchor_spl::token::spl_token::instruction::close_account(prog.key, acct.key, pc_info.key, pc_info.key, &[])?
            };
            anchor_lang::solana_program::program::invoke_signed(&ix, &[acct, pc_info.clone(), pc_info.clone(), prog], &[pc_seeds])?;
        }
        let leftover = pc_info.lamports();
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer { from: pc_info.clone(), to: a.config.to_account_info() },
                &[pc_seeds],
            ),
            leftover,
        )?;

        let pool_key = a.pool_state.key();
        let config = &mut ctx.accounts.config;
        config.fees_accrued += leftover;
        let curve = &mut ctx.accounts.curve;
        curve.real_sol = 0;
        curve.graduated = true;
        curve.pool = pool_key;
        emit!(Graduated {
            mint: mint_key,
            pool: pool_key,
            sol_liquidity: liquidity_sol,
            token_liquidity: token_liq,
            tokens_burned: to_burn,
            protocol_fee: leftover,
        });
        Ok(())
    }

    /// Certifier-only. Records the tx id that anchored this launch's certificate hash on
    /// another chain. Each chain can be written once and never changed.
    pub fn record_certificate(ctx: Context<RecordCertificate>, chain: u8, txid: [u8; 32]) -> Result<()> {
        require!(chain <= CERT_HYPEREVM, LaunchpadError::InvalidChain);
        require!(txid != [0u8; 32], LaunchpadError::InvalidChain);
        let curve = &mut ctx.accounts.curve;
        let bit = 1u8 << chain;
        require!(curve.cert_flags & bit == 0, LaunchpadError::CertificateAlreadyRecorded);
        curve.cert_flags |= bit;
        let now = Clock::get()?.unix_timestamp;
        match chain {
            CERT_MONERO => { curve.cert_monero = txid; curve.cert_monero_at = now; }
            CERT_ZCASH => { curve.cert_zcash = txid; curve.cert_zcash_at = now; }
            _ => { curve.cert_hyperevm = txid; curve.cert_hyperevm_at = now; }
        }
        emit!(CertificateRecorded { mint: curve.mint, chain, txid, launch_hash: curve.launch_hash });
        Ok(())
    }

    /// Permissionless. Pays accrued fees out: dev share to the dev wallet, the rest to the
    /// buyback wallet.
    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let total = config.fees_accrued;
        require!(total > 0, LaunchpadError::ZeroAmount);
        let dev = (total as u128 * config.dev_share_bps as u128 / math::BPS as u128) as u64;
        let buyback = total - dev;
        config.fees_accrued = 0;
        config.sub_lamports(total)?;
        ctx.accounts.dev_wallet.add_lamports(dev)?;
        ctx.accounts.buyback_wallet.add_lamports(buyback)?;
        emit!(FeesDistributed { dev, buyback });
        Ok(())
    }
}

// ====================================================================== shared logic
#[allow(clippy::too_many_arguments)]
fn do_buy<'info>(
    curve: &mut Account<'info, Curve>,
    config: &mut Account<'info, Config>,
    user: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    curve_vault: &AccountInfo<'info>,
    user_ata: &AccountInfo<'info>,
    sol_vault: &AccountInfo<'info>,
    max_sol: u64,
    min_tokens_out: u64,
) -> Result<()> {
    require!(!curve.complete, LaunchpadError::CurveComplete);
    let q = math::quote_buy(curve.virtual_sol, curve.virtual_token, curve.tokens_sold, max_sol, config.trade_fee_bps as u64);
    require!(q.tokens_out > 0 && q.tokens_out >= min_tokens_out, LaunchpadError::Slippage);

    system_program::transfer(
        CpiContext::new(system_program::ID, system_program::Transfer { from: user.clone(), to: sol_vault.clone() }),
        q.sol_in,
    )?;
    if q.fee > 0 {
        system_program::transfer(
            CpiContext::new(system_program::ID, system_program::Transfer { from: user.clone(), to: config.to_account_info() }),
            q.fee,
        )?;
    }
    let mint_key = mint.key();
    let seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve.bump]];
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            token_2022::ID,
            token_2022::TransferChecked {
                from: curve_vault.clone(),
                mint: mint.to_account_info(),
                to: user_ata.clone(),
                authority: curve.to_account_info(),
            },
            &[seeds],
        ),
        q.tokens_out,
        DECIMALS,
    )?;

    curve.virtual_sol = q.new_virtual_sol;
    curve.virtual_token = q.new_virtual_token;
    curve.real_sol += q.sol_in;
    curve.tokens_sold += q.tokens_out;
    config.fees_accrued += q.fee;
    emit_trade(curve, user.key(), true, q.sol_in + q.fee, q.tokens_out, q.fee)?;
    if curve.tokens_sold == CURVE_SUPPLY {
        curve.complete = true;
        emit!(CurveCompleted { mint: curve.mint, real_sol: curve.real_sol });
    }
    Ok(())
}

fn emit_trade(curve: &Curve, trader: Pubkey, is_buy: bool, sol_amount: u64, token_amount: u64, fee: u64) -> Result<()> {
    emit!(TradeEvent {
        mint: curve.mint,
        trader,
        is_buy,
        sol_amount,
        token_amount,
        fee,
        virtual_sol: curve.virtual_sol,
        virtual_token: curve.virtual_token,
        real_sol: curve.real_sol,
        tokens_sold: curve.tokens_sold,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/// sha256(domain | mint | creator | len8 name | name | len8 symbol | symbol | len16 uri | uri | slot | unix_ts)
pub fn certificate_hash(mint: &Pubkey, creator: &Pubkey, name: &str, symbol: &str, uri: &str, slot: u64, ts: i64) -> [u8; 32] {
    let name_len = [name.len() as u8];
    let sym_len = [symbol.len() as u8];
    let uri_len = (uri.len() as u16).to_le_bytes();
    let slot_b = slot.to_le_bytes();
    let ts_b = ts.to_le_bytes();
    hashv(&[
        CERT_DOMAIN, mint.as_ref(), creator.as_ref(), &name_len, name.as_bytes(), &sym_len, symbol.as_bytes(),
        &uri_len, uri.as_bytes(), &slot_b, &ts_b,
    ])
    .to_bytes()
}

fn check_amm_config(info: &UncheckedAccount, expected: &Pubkey) -> Result<()> {
    require_keys_eq!(info.key(), *expected, LaunchpadError::InvalidConfig);
    require_keys_eq!(*info.owner, raydium_cp_swap::ID, LaunchpadError::InvalidConfig);
    Ok(())
}

// ====================================================================== state
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub certifier: Pubkey,
    pub buyback_wallet: Pubkey,
    pub dev_wallet: Pubkey,
    pub raydium_amm_config: Pubkey,
    pub dev_share_bps: u16,
    pub trade_fee_bps: u16,
    pub creation_fee: u64,
    pub graduation_fee: u64,
    pub initial_virtual_sol: u64,
    pub fees_accrued: u64,
    pub token_count: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub initial_virtual_sol: u64,
    pub real_sol: u64,
    pub tokens_sold: u64,
    pub complete: bool,
    pub graduated: bool,
    pub pool: Pubkey,
    pub created_at: i64,
    pub created_slot: u64,
    pub index: u64,
    pub launch_hash: [u8; 32],
    pub cert_flags: u8,
    pub cert_monero: [u8; 32],
    pub cert_monero_at: i64,
    pub cert_zcash: [u8; 32],
    pub cert_zcash_at: i64,
    pub cert_hyperevm: [u8; 32],
    pub cert_hyperevm_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ConfigParams {
    pub certifier: Pubkey,
    pub buyback_wallet: Pubkey,
    pub dev_wallet: Pubkey,
    pub raydium_amm_config: Pubkey,
    pub dev_share_bps: u16,
    pub trade_fee_bps: u16,
    pub creation_fee: u64,
    pub graduation_fee: u64,
    pub initial_virtual_sol: u64,
    pub paused: bool,
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        require!(self.dev_share_bps as u64 <= math::BPS, LaunchpadError::InvalidConfig);
        require!(self.trade_fee_bps <= MAX_TRADE_FEE_BPS, LaunchpadError::InvalidConfig);
        require!(self.creation_fee <= MAX_CREATION_FEE, LaunchpadError::InvalidConfig);
        require!(
            (MIN_GRADUATION_FEE..=MAX_GRADUATION_FEE).contains(&self.graduation_fee),
            LaunchpadError::InvalidConfig
        );
        require!(
            (MIN_INITIAL_VIRTUAL_SOL..=MAX_INITIAL_VIRTUAL_SOL).contains(&self.initial_virtual_sol),
            LaunchpadError::InvalidConfig
        );
        for k in [self.certifier, self.buyback_wallet, self.dev_wallet] {
            require!(k != Pubkey::default(), LaunchpadError::InvalidConfig);
        }
        Ok(())
    }
    fn apply(&self, c: &mut Config) {
        c.certifier = self.certifier;
        c.buyback_wallet = self.buyback_wallet;
        c.dev_wallet = self.dev_wallet;
        c.raydium_amm_config = self.raydium_amm_config;
        c.dev_share_bps = self.dev_share_bps;
        c.trade_fee_bps = self.trade_fee_bps;
        c.creation_fee = self.creation_fee;
        c.graduation_fee = self.graduation_fee;
        c.initial_virtual_sol = self.initial_virtual_sol;
        c.paused = self.paused;
    }
}

// ====================================================================== accounts
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: validated against params + owner in handler
    pub raydium_amm_config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ LaunchpadError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: validated in handler (update_config); ignored by propose_admin
    pub raydium_amm_config: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = creator,
        mint::decimals = DECIMALS,
        mint::authority = curve,
        mint::token_program = token_program,
        extensions::metadata_pointer::authority = curve,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + Curve::INIT_SPACE, seeds = [CURVE_SEED, mint.key().as_ref()], bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: system-owned PDA holding this coin's SOL
    #[account(mut, seeds = [POOL_CREATOR_SEED, mint.key().as_ref()], bump)]
    pub sol_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = curve,
        associated_token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: system-owned PDA holding this coin's SOL
    #[account(mut, seeds = [POOL_CREATOR_SEED, mint.key().as_ref()], bump = curve.vault_bump)]
    pub sol_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CURVE_SEED, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = curve,
        associated_token::token_program = token_2022_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: system-owned PDA that creates the pool; holds SOL only during this instruction.
    #[account(mut, seeds = [POOL_CREATOR_SEED, mint.key().as_ref()], bump)]
    pub pool_creator: UncheckedAccount<'info>,
    /// CHECK: pool_creator's Token-2022 ATA for `mint`, created here.
    #[account(mut)]
    pub pool_creator_token: UncheckedAccount<'info>,
    /// CHECK: pool_creator's WSOL ATA, created here.
    #[account(mut)]
    pub pool_creator_wsol: UncheckedAccount<'info>,
    /// CHECK: native mint
    #[account(address = wsol::ID)]
    pub wsol_mint: UncheckedAccount<'info>,

    // ---- Raydium CPMM (validated by Raydium itself)
    /// CHECK:
    #[account(address = raydium_cp_swap::ID)]
    pub cp_swap_program: UncheckedAccount<'info>,
    /// CHECK: must be the configured AMM config
    #[account(address = config.raydium_amm_config)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK:
    pub raydium_authority: UncheckedAccount<'info>,
    /// CHECK: PDA of this program, so only we can create the pool here
    #[account(mut, seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub creator_lp_token: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RecordCertificate<'info> {
    pub certifier: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = certifier @ LaunchpadError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CURVE_SEED, curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
}

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = dev_wallet, has_one = buyback_wallet)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: checked by has_one
    #[account(mut)]
    pub dev_wallet: UncheckedAccount<'info>,
    /// CHECK: checked by has_one
    #[account(mut)]
    pub buyback_wallet: UncheckedAccount<'info>,
}

// ====================================================================== events
#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub launch_hash: [u8; 32],
    pub slot: u64,
    pub timestamp: i64,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub fee: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub tokens_sold: u64,
    pub timestamp: i64,
}

#[event]
pub struct CurveCompleted {
    pub mint: Pubkey,
    pub real_sol: u64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub sol_liquidity: u64,
    pub token_liquidity: u64,
    pub tokens_burned: u64,
    pub protocol_fee: u64,
}

#[event]
pub struct CertificateRecorded {
    pub mint: Pubkey,
    pub chain: u8,
    pub txid: [u8; 32],
    pub launch_hash: [u8; 32],
}

#[event]
pub struct FeesDistributed {
    pub dev: u64,
    pub buyback: u64,
}

#[event]
pub struct ConfigUpdated {
    pub config: ConfigParams,
}

#[error_code]
pub enum LaunchpadError {
    #[msg("Not authorized")]
    Unauthorized,
    #[msg("Launches and buys are paused")]
    Paused,
    #[msg("Invalid name, ticker or image URI")]
    InvalidMetadata,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Price moved beyond your slippage tolerance")]
    Slippage,
    #[msg("Bonding curve is complete")]
    CurveComplete,
    #[msg("Bonding curve is not complete yet")]
    CurveNotComplete,
    #[msg("Already graduated")]
    AlreadyGraduated,
    #[msg("Not enough SOL raised to cover graduation")]
    InsufficientLiquidity,
    #[msg("Invalid certificate chain or txid")]
    InvalidChain,
    #[msg("Certificate for this chain already recorded")]
    CertificateAlreadyRecorded,
    #[msg("Invalid config")]
    InvalidConfig,
}
