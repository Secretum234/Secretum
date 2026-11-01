#!/usr/bin/env node
// Buyback-and-burn keeper for the 90% fee share.
//
// Spends the buyback wallet's SOL (above a reserve) on $SECRETUM and burns what it buys:
//   - while $SECRETUM is on its Secretum bonding curve: buys on the curve
//   - after it graduates: buys through its Raydium CPMM pool
//
//   node devtools/buyback.js --wallet keys/buyback.json --mint <SECRETUM mint> [--cluster devnet|mainnet]
//        [--rpc url] [--reserve-sol 0.05] [--max-sol 5] [--slippage-bps 300] [--yes]
//
// Run it by hand, or on a schedule (cron) once fees have built up.
const fs = require('fs');
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../client/secretum');
const { PROGRAM_ID } = require('./program-id');

/**
 * Builds the buyback transaction(s). Pure planning given chain reads, so it can run against
 * any connection-like object (used by the tests with LiteSVM).
 * @returns { route, spend, expectedTokens, ixs } or null when there's nothing to spend
 */
async function planBuyback({ lp, read, wallet, mint, reserveLamports, maxLamports, slippageBps = 300 }) {
  const mintPk = new web3.PublicKey(mint);
  const balance = BigInt(await read.balance(wallet));
  let spend = balance > reserveLamports ? balance - reserveLamports : 0n;
  if (maxLamports && spend > maxLamports) spend = maxLamports;
  if (spend < 10_000n) return null;

  const curve = S.decodeCurve(await read.data(lp.curvePda(mintPk)));
  const cfg = S.decodeConfig(await read.data(lp.configPda()));
  const tokAta = lp.userAta(wallet, mintPk);
  const burnAll = (amount) => spl.createBurnCheckedInstruction(tokAta, mintPk, wallet, amount, S.DECIMALS, [], S.TOKEN_2022_PROGRAM_ID);
  // Burn anything left from a previous run (we only burn the guaranteed minimum each time).
  const leftover = BigInt(await read.tokenBalance(tokAta));
  const sweep = leftover > 0n ? [burnAll(leftover)] : [];

  if (!curve.graduated) {
    if (curve.complete) return { route: 'curve-complete', spend: 0n, ixs: [] }; // waiting for someone to graduate it
    const q = S.quoteBuy(curve, spend, cfg.tradeFeeBps);
    const minOut = (q.tokensOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return {
      route: 'curve', spend: q.total, expectedTokens: q.tokensOut,
      ixs: [...sweep, lp.buy({ user: wallet, mint: mintPk, maxSol: spend, minTokensOut: minOut }), burnAll(minOut)],
    };
  }

  // Raydium: constant-product quote from the pool vaults (0.25% fee assumed for min-out).
  const r = lp.raydium(mintPk);
  const vaultAmt = async (pk) => spl.AccountLayout.decode(Buffer.from(await read.data(pk))).amount;
  const solRes = await vaultAmt(r.tokenIs0 ? r.token1Vault : r.token0Vault);
  const tokRes = await vaultAmt(r.tokenIs0 ? r.token0Vault : r.token1Vault);
  const inAfterFee = (spend * 9975n) / 10_000n;
  const expected = (tokRes * inAfterFee) / (solRes + inAfterFee);
  const minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
  const wsol = S.ata(wallet, S.WSOL_MINT, S.TOKEN_PROGRAM_ID);
  return {
    route: 'raydium', spend, expectedTokens: expected,
    ixs: [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      spl.createAssociatedTokenAccountIdempotentInstruction(wallet, wsol, wallet, S.WSOL_MINT, S.TOKEN_PROGRAM_ID),
      spl.createAssociatedTokenAccountIdempotentInstruction(wallet, tokAta, wallet, mintPk, S.TOKEN_2022_PROGRAM_ID),
      web3.SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsol, lamports: spend }),
      spl.createSyncNativeInstruction(wsol, S.TOKEN_PROGRAM_ID),
      ...sweep,
      lp.raydiumSwap({ payer: wallet, mint: mintPk, ammConfig: cfg.raydiumAmmConfig, inputIsSol: true, amountIn: spend, minOut }),
      burnAll(minOut),
      spl.createCloseAccountInstruction(wsol, wallet, wallet, [], S.TOKEN_PROGRAM_ID),
    ],
  };
}

module.exports = { planBuyback };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const cluster = opt('cluster', 'devnet');
  const conn = new web3.Connection(opt('rpc', cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'), 'confirmed');
  const lp = S.makeClient(opt('program-id', PROGRAM_ID), cluster);
  const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opt('wallet'), 'utf8'))));
  const sol = (x) => BigInt(Math.round(Number(x) * web3.LAMPORTS_PER_SOL));
  (async () => {
    const read = {
      balance: (pk) => conn.getBalance(pk),
      data: async (pk) => (await conn.getAccountInfo(pk)).data,
      tokenBalance: (pk) => conn.getTokenAccountBalance(pk).then((r) => r.value.amount).catch(() => 0),
    };
    const plan = await planBuyback({ lp, read, wallet: kp.publicKey, mint: opt('mint'), reserveLamports: sol(opt('reserve-sol', 0.05)),
      maxLamports: opt('max-sol') ? sol(opt('max-sol')) : 0n, slippageBps: Number(opt('slippage-bps', 300)) });
    if (!plan || !plan.ixs.length) return console.log(plan ? 'Curve is full and waiting to graduate; nothing to do.' : 'Not enough SOL above the reserve; nothing to do.');
    console.log(`Buying back via ${plan.route}: ${Number(plan.spend) / 1e9} SOL for ~${Number(plan.expectedTokens) / 1e6} tokens, then burning them.`);
    if (!argv.includes('--yes')) {
      process.stdout.write('Proceed? [y/N] ');
      const a = await new Promise((r) => process.stdin.once('data', (d) => r(String(d).trim())));
      if (!/^y/i.test(a)) return console.log('Cancelled.');
    }
    const sig = await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(...plan.ixs), [kp], { commitment: 'confirmed' });
    console.log('Done:', sig);
    process.exit(0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
