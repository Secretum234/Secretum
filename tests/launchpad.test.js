// Integration tests: run the compiled Secretum program alongside Raydium's real CPMM program
// (built from source) in LiteSVM, driven by the same client library the website uses.
// Run: npm run build && npm test
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { LiteSVM, FailedTransactionMetadata, Clock } = require('litesvm');
const { makeSvm } = require('../devtools/svm');
const {
  Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../client/secretum');

const ROOT = path.join(__dirname, '..');
const PROGRAM_ID = new PublicKey(require('../devtools/program-id').PROGRAM_ID);
const RAYDIUM_SO = process.env.RAYDIUM_SO || path.join(ROOT, 'vendor/raydium_cp_swap.so');
const sol = (x) => BigInt(Math.round(x * LAMPORTS_PER_SOL));

const DEFAULTS = {
  devShareBps: 1000, // 10% of protocol fees to the dev wallet, 90% to buyback
  tradeFeeBps: 100, // 1%
  creationFee: sol(0.02),
  graduationFee: sol(1),
  initialVirtualSol: sol(42.5), // curve fills at 85 SOL
  paused: false,
};

let svm, lp, admin, certifier, devWallet, buyback, alice, bob, carol, ammConfig, params;

// ------------------------------------------------------------------ helpers
function send(ixs, signers, { cu } = {}) {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return res;
}
function ok(ixs, signers, opts) {
  const res = send(ixs, signers, opts);
  if (res instanceof FailedTransactionMetadata) {
    const logs = res.meta().logs();
    throw new Error(`tx failed: ${JSON.stringify(res.err())}\n` + logs.filter((l) => /Error|failed|Left|Right|log: [A-Z]/.test(l)).slice(-12).join('\n'));
  }
  return res;
}
function fails(ixs, signers, expected, opts) {
  const res = send(ixs, signers, opts);
  assert.ok(res instanceof FailedTransactionMetadata, `expected failure (${expected}) but tx succeeded`);
  const logs = res.meta().logs().join('\n');
  assert.ok(logs.includes(expected) || res.toString().includes(expected), `expected "${expected}", got:\n${logs.slice(-1500)}`);
}
const acct = (pk) => svm.getAccount(new PublicKey(pk));
const lamports = (pk) => BigInt(acct(pk)?.lamports ?? 0);
const config = () => S.decodeConfig(acct(lp.configPda()).data);
const curve = (mint) => S.decodeCurve(acct(lp.curvePda(mint)).data);
const rentMin = (n) => BigInt(svm.minimumBalanceForRentExemption(BigInt(n)));
function tokenBal(pk) {
  const a = acct(pk);
  if (!a) return 0n;
  return spl.unpackAccount(new PublicKey(pk), { ...a, data: Buffer.from(a.data) }, a.owner).amount;
}
function mintInfo(mint) {
  const a = acct(mint);
  return spl.unpackMint(new PublicKey(mint), { ...a, data: Buffer.from(a.data) }, a.owner);
}
const disc = (name) => crypto.createHash('sha256').update(name).digest().subarray(0, 8);
function setTime(ts) {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot + 10n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(ts)));
}
const nowTs = () => Number(svm.getClock().unixTimestamp);

function launch(creator = alice, opts = {}) {
  const mint = Keypair.generate();
  ok([lp.createToken({ creator: creator.publicKey, mint: mint.publicKey, name: opts.name ?? 'Secret Cat', symbol: opts.symbol ?? 'SCAT',
    uri: opts.uri ?? 'https://example.com/cat.json', devBuyLamports: opts.devBuy ?? 0n })], [creator, mint]);
  return mint.publicKey;
}
const buy = (user, mint, maxSol, minTokensOut = 0n) => ok([lp.buy({ user: user.publicKey, mint, maxSol, minTokensOut })], [user]);
const sell = (user, mint, tokenAmount, minSolOut = 0n) => ok([lp.sell({ user: user.publicKey, mint, tokenAmount, minSolOut })], [user]);

/** SOL vault = rent + real_sol; curve account = rent only; config = rent + fees_accrued. */
function assertSolvent(mint) {
  const c = curve(mint);
  if (!c.graduated) assert.equal(lamports(lp.solVault(mint)) - rentMin(0), c.realSol, 'SOL vault != rent + real_sol');
  assert.equal(lamports(lp.curvePda(mint)), rentMin(acct(lp.curvePda(mint)).data.length), 'curve holds only rent');
  if (!c.graduated) assert.equal(c.virtualSol - c.initialVirtualSol, c.realSol, 'virtual/real SOL drift');
  const cfg = config();
  assert.equal(lamports(lp.configPda()) - rentMin(acct(lp.configPda()).data.length), cfg.feesAccrued, 'config lamports != rent + fees');
}

// Raydium AmmConfig account, as on mainnet (index 0: 0.25% fee, 0.15 SOL pool creation fee).
function injectAmmConfig(pk) {
  const b = Buffer.alloc(236);
  disc('account:AmmConfig').copy(b, 0);
  let o = 8;
  b.writeUInt8(255, o); o += 1; // bump
  b.writeUInt8(0, o); o += 1; // disable_create_pool
  b.writeUInt16LE(0, o); o += 2; // index
  b.writeBigUInt64LE(2500n, o); o += 8; // trade_fee_rate
  b.writeBigUInt64LE(120000n, o); o += 8; // protocol_fee_rate
  b.writeBigUInt64LE(40000n, o); o += 8; // fund_fee_rate
  b.writeBigUInt64LE(150_000_000n, o); o += 8; // create_pool_fee
  Keypair.generate().publicKey.toBuffer().copy(b, o); o += 32;
  Keypair.generate().publicKey.toBuffer().copy(b, o); o += 32;
  svm.setAccount(pk, { lamports: Number(rentMin(236)), data: b, owner: lp.RAYDIUM_CPMM, executable: false });
}
// Raydium's fixed pool-creation-fee receiver: a WSOL token account.
function injectCreatePoolFeeAccount() {
  const b = Buffer.alloc(spl.ACCOUNT_SIZE);
  const rent = rentMin(spl.ACCOUNT_SIZE);
  spl.AccountLayout.encode({
    mint: S.WSOL_MINT, owner: Keypair.generate().publicKey, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 1, isNative: rent, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, b);
  svm.setAccount(S.CLUSTERS.mainnet.raydiumCreatePoolFee, { lamports: Number(rent), data: b, owner: S.TOKEN_PROGRAM_ID, executable: false });
}

// Raw Raydium CPMM instructions (used to test the pool works, and to attack graduation).
function raydiumSwapIx({ payer, mint, inputIsSol, amountIn, minOut = 0n }) {
  const r = lp.raydium(mint);
  const userWsol = S.ata(payer, S.WSOL_MINT, S.TOKEN_PROGRAM_ID);
  const userTok = S.ata(payer, mint, S.TOKEN_2022_PROGRAM_ID);
  const solVault = r.tokenIs0 ? r.token1Vault : r.token0Vault;
  const tokVault = r.tokenIs0 ? r.token0Vault : r.token1Vault;
  const [inAcc, outAcc, inVault, outVault, inProg, outProg, inMint, outMint] = inputIsSol
    ? [userWsol, userTok, solVault, tokVault, S.TOKEN_PROGRAM_ID, S.TOKEN_2022_PROGRAM_ID, S.WSOL_MINT, mint]
    : [userTok, userWsol, tokVault, solVault, S.TOKEN_2022_PROGRAM_ID, S.TOKEN_PROGRAM_ID, mint, S.WSOL_MINT];
  const data = Buffer.alloc(24);
  disc('global:swap_base_input').copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minOut), 16);
  const m = (pubkey, w = false, s = false) => ({ pubkey: new PublicKey(pubkey), isWritable: w, isSigner: s });
  return new (require('@solana/web3.js').TransactionInstruction)({
    programId: lp.RAYDIUM_CPMM, data,
    keys: [m(payer, true, true), m(r.authority), m(ammConfig), m(r.poolState, true), m(inAcc, true), m(outAcc, true),
      m(inVault, true), m(outVault, true), m(inProg), m(outProg), m(inMint), m(outMint), m(r.observation, true)],
  });
}
function wrapSolIxs(owner, amount) {
  const wsolAta = S.ata(owner, S.WSOL_MINT, S.TOKEN_PROGRAM_ID);
  return [
    spl.createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, S.WSOL_MINT, S.TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: amount }),
    spl.createSyncNativeInstruction(wsolAta, S.TOKEN_PROGRAM_ID),
  ];
}

// ------------------------------------------------------------------ setup
before(() => {
  svm = makeSvm();
  svm.addProgramFromFile(PROGRAM_ID, path.join(ROOT, 'target/deploy/launchpad.so'));
  lp = S.makeClient(PROGRAM_ID, 'mainnet');
  svm.addProgramFromFile(lp.RAYDIUM_CPMM, RAYDIUM_SO);
  [admin, certifier, devWallet, buyback, alice, bob, carol] = Array.from({ length: 7 }, () => Keypair.generate());
  for (const k of [admin, certifier, alice, bob, carol]) svm.airdrop(k.publicKey, BigInt(10_000 * LAMPORTS_PER_SOL));
  for (const k of [devWallet, buyback]) svm.airdrop(k.publicKey, BigInt(LAMPORTS_PER_SOL)); // fee wallets must exist (rent-exempt)
  setTime(1_780_000_000);
  ammConfig = Keypair.generate().publicKey;
  injectAmmConfig(ammConfig);
  injectCreatePoolFeeAccount();
  params = { ...DEFAULTS, certifier: certifier.publicKey, buybackWallet: buyback.publicKey, devWallet: devWallet.publicKey, raydiumAmmConfig: ammConfig };
});

// ------------------------------------------------------------------ tests
test('initialize: rejects bad params, stores config', () => {
  fails([lp.initialize({ admin: admin.publicKey, params: { ...params, tradeFeeBps: 201 } })], [admin], 'InvalidConfig');
  fails([lp.initialize({ admin: admin.publicKey, params: { ...params, graduationFee: sol(0.1) } })], [admin], 'InvalidConfig');
  fails([lp.initialize({ admin: admin.publicKey, params: { ...params, raydiumAmmConfig: Keypair.generate().publicKey } })], [admin], 'InvalidConfig');
  ok([lp.initialize({ admin: admin.publicKey, params })], [admin]);
  const c = config();
  assert.ok(c.admin.equals(admin.publicKey));
  assert.ok(c.devWallet.equals(devWallet.publicKey));
  assert.equal(c.devShareBps, 1000);
  assert.equal(c.tradeFeeBps, 100);
  assert.equal(c.initialVirtualSol, sol(42.5));
});

test('create_token: Token-2022 mint with on-chain metadata, all authorities revoked, full supply in curve, certificate hash matches', async () => {
  const before = config().feesAccrued;
  const mint = launch(alice, { name: 'Secret Cat', symbol: 'SCAT', uri: 'https://example.com/cat.json' });
  const m = mintInfo(mint);
  assert.equal(m.supply, S.TOTAL_SUPPLY);
  assert.equal(m.decimals, 6);
  assert.equal(m.mintAuthority, null, 'mint authority must be revoked');
  assert.equal(m.freezeAuthority, null, 'no freeze authority');
  const meta = S.decodeMintMetadata(acct(mint).data);
  assert.equal(meta.name, 'Secret Cat');
  assert.equal(meta.symbol, 'SCAT');
  assert.equal(meta.uri, 'https://example.com/cat.json');
  assert.ok(meta.updateAuthority.equals(PublicKey.default), 'metadata must be immutable');
  assert.equal(tokenBal(lp.curveVault(mint)), S.TOTAL_SUPPLY);
  const c = curve(mint);
  assert.ok(c.creator.equals(alice.publicKey));
  assert.equal(c.tokensSold, 0n);
  assert.equal(c.virtualToken, S.INITIAL_VIRTUAL_TOKEN);
  assert.equal(config().feesAccrued - before, sol(0.02));
  // Anyone can recompute the certificate from public data
  const h = await S.certificateHash({ mint, creator: alice.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri, slot: c.createdSlot, timestamp: c.createdAt });
  assert.equal(h, S.toHex(c.launchHash));
  // Starting market cap ≈ 37.8 SOL
  console.log(`      start mcap: ${(S.marketCapLamports(c) / 1e9).toFixed(2)} SOL`);
  assertSolvent(mint);
});

test('create_token rejects bad metadata', () => {
  for (const [name, symbol] of [['', 'X'], ['x'.repeat(33), 'X'], ['ok', ''], ['ok', 'TOOLONGTICKER']]) {
    const mint = Keypair.generate();
    fails([lp.createToken({ creator: alice.publicKey, mint: mint.publicKey, name, symbol })], [alice, mint], 'InvalidMetadata');
  }
});

test('create_token with a dev buy buys atomically for the creator', () => {
  const mint = launch(bob, { devBuy: sol(1) });
  const c = curve(mint);
  const bal = tokenBal(lp.userAta(bob.publicKey, mint));
  assert.ok(bal > 0n);
  assert.equal(c.tokensSold, bal);
  assertSolvent(mint);
});

test('buy: matches client quote, charges 1% fee, price rises, slippage enforced', () => {
  const mint = launch();
  const c0 = curve(mint);
  const q = S.quoteBuy(c0, sol(2), 100);
  const fees0 = config().feesAccrued;
  const solBefore = lamports(bob.publicKey);
  buy(bob, mint, sol(2), q.tokensOut);
  assert.equal(tokenBal(lp.userAta(bob.publicKey, mint)), q.tokensOut);
  assert.equal(config().feesAccrued - fees0, q.fee);
  assert.equal(q.fee, sol(0.02));
  const spent = solBefore - lamports(bob.publicKey);
  assert.ok(spent >= q.total && spent < q.total + sol(0.01), 'spent = quote + ATA rent + tx fee');
  assert.ok(curve(mint).price > c0.price);
  fails([lp.buy({ user: carol.publicKey, mint, maxSol: sol(2), minTokensOut: q.tokensOut })], [carol], 'Slippage');
  fails([lp.buy({ user: carol.publicKey, mint, maxSol: 0n })], [carol], 'ZeroAmount');
  assertSolvent(mint);
});

test('sell: matches quote, round trip only loses fees, slippage enforced', () => {
  const mint = launch();
  buy(carol, mint, sol(5));
  const bal = tokenBal(lp.userAta(carol.publicKey, mint));
  const q = S.quoteSell(curve(mint), bal, 100);
  assert.ok(q.solOut < sol(5) && q.solOut > sol(4.89), `round trip returned ${q.solOut}`);
  fails([lp.sell({ user: carol.publicKey, mint, tokenAmount: bal, minSolOut: q.solOut + 1n })], [carol], 'Slippage');
  const before = lamports(carol.publicKey);
  sell(carol, mint, bal, q.solOut);
  assert.equal(lamports(carol.publicKey) - before + 5000n, q.solOut); // + tx fee
  assert.equal(tokenBal(lp.userAta(carol.publicKey, mint)), 0n);
  assert.equal(curve(mint).tokensSold, 0n);
  assertSolvent(mint);
});

test('pause blocks launches and buys, never sells', () => {
  const mint = launch();
  buy(bob, mint, sol(1));
  ok([lp.updateConfig({ admin: admin.publicKey, params: { ...params, paused: true } })], [admin]);
  fails([lp.buy({ user: bob.publicKey, mint, maxSol: sol(1) })], [bob], 'Paused');
  const m2 = Keypair.generate();
  fails([lp.createToken({ creator: bob.publicKey, mint: m2.publicKey, name: 'x', symbol: 'X' })], [bob, m2], 'Paused');
  sell(bob, mint, tokenBal(lp.userAta(bob.publicKey, mint)));
  ok([lp.updateConfig({ admin: admin.publicKey, params })], [admin]);
  assertSolvent(mint);
});

test('admin: only admin can update; two-step handover', () => {
  fails([lp.updateConfig({ admin: alice.publicKey, params })], [alice], 'Unauthorized');
  const newAdmin = Keypair.generate();
  svm.airdrop(newAdmin.publicKey, BigInt(LAMPORTS_PER_SOL));
  ok([lp.proposeAdmin({ admin: admin.publicKey, newAdmin: newAdmin.publicKey, raydiumAmmConfig: ammConfig })], [admin]);
  fails([lp.acceptAdmin({ newAdmin: alice.publicKey })], [alice], 'Unauthorized');
  ok([lp.acceptAdmin({ newAdmin: newAdmin.publicKey })], [newAdmin]);
  assert.ok(config().admin.equals(newAdmin.publicKey));
  ok([lp.proposeAdmin({ admin: newAdmin.publicKey, newAdmin: admin.publicKey, raydiumAmmConfig: ammConfig })], [newAdmin]);
  ok([lp.acceptAdmin({ newAdmin: admin.publicKey })], [admin]);
});

test('certificates: certifier only, valid chains only, write-once per chain', () => {
  const mint = launch();
  const tx = 'ab'.repeat(32);
  fails([lp.recordCertificate({ certifier: alice.publicKey, mint, chain: S.CERT.MONERO, txid: tx })], [alice], 'Unauthorized');
  fails([lp.recordCertificate({ certifier: certifier.publicKey, mint, chain: 3, txid: tx })], [certifier], 'InvalidChain');
  ok([lp.recordCertificate({ certifier: certifier.publicKey, mint, chain: S.CERT.MONERO, txid: tx })], [certifier]);
  ok([lp.recordCertificate({ certifier: certifier.publicKey, mint, chain: S.CERT.HYPEREVM, txid: '0x' + 'cd'.repeat(32) })], [certifier]);
  fails([lp.recordCertificate({ certifier: certifier.publicKey, mint, chain: S.CERT.MONERO, txid: 'ef'.repeat(32) })], [certifier], 'CertificateAlreadyRecorded');
  const c = curve(mint);
  assert.equal(c.certs.monero, tx);
  assert.equal(c.certs.hyperevm, '0x' + 'cd'.repeat(32));
  assert.equal(c.certs.zcash, null);
});

let gradMint;
test('filling the curve: capped buy charges only what is needed, then trading closes', () => {
  const mint = launch();
  gradMint = mint;
  const q = S.quoteBuy(curve(mint), sol(200), 100);
  assert.equal(q.tokensOut, S.CURVE_SUPPLY);
  assert.ok(q.capped);
  const before = lamports(bob.publicKey);
  const res = buy(bob, mint, sol(200));
  const spent = before - lamports(bob.publicKey);
  assert.ok(spent < sol(87), `spent ${spent}`);
  const c = curve(mint);
  assert.equal(c.complete, true);
  assert.ok(c.realSol >= sol(84.99) && c.realSol <= sol(85.01), `raised ${c.realSol}`);
  console.log(`      SOL raised to fill the curve: ${(Number(c.realSol) / 1e9).toFixed(4)}`);
  assert.ok(S.parseEvents(res.logs()).some((e) => e.name === 'CurveCompleted'));
  fails([lp.buy({ user: carol.publicKey, mint, maxSol: sol(1) })], [carol], 'CurveComplete');
  fails([lp.sell({ user: bob.publicKey, mint, tokenAmount: 1n })], [bob], 'CurveComplete');
  assertSolvent(mint);
});

test('graduate: blocked before completion; anyone can graduate a full curve into a locked Raydium pool', () => {
  const early = launch();
  buy(carol, early, sol(1));
  fails([lp.graduateComputeIx(), lp.graduate({ payer: carol.publicKey, mint: early, ammConfig })], [carol], 'CurveNotComplete');

  const mint = gradMint;
  const c = curve(mint);
  const fees0 = config().feesAccrued;
  const res = ok([lp.graduate({ payer: carol.publicKey, mint, ammConfig })], [carol], { cu: 600_000 });
  console.log(`      graduate compute units: ${res.computeUnitsConsumed()}`);
  const ev = S.parseEvents(res.logs()).find((e) => e.name === 'Graduated');
  assert.ok(ev, 'Graduated event');
  const r = lp.raydium(mint);
  const solVault = r.tokenIs0 ? r.token1Vault : r.token0Vault;
  const tokVault = r.tokenIs0 ? r.token0Vault : r.token1Vault;
  const poolSol = tokenBal(solVault), poolTok = tokenBal(tokVault);
  console.log(`      pool: ${(Number(poolSol) / 1e9).toFixed(4)} SOL / ${(Number(poolTok) / 1e6).toLocaleString()} tokens, burned ${(Number(ev.tokensBurned) / 1e6).toLocaleString()}`);
  assert.equal(poolSol, c.realSol - params.graduationFee);
  // Pool opens at the curve's final price (within 0.01%)
  const curvePx = Number(c.virtualSol) / Number(c.virtualToken);
  const poolPx = Number(poolSol) / Number(poolTok);
  assert.ok(Math.abs(poolPx / curvePx - 1) < 1e-4, `pool ${poolPx} vs curve ${curvePx}`);
  // All LP burned: only Raydium's 100 locked units remain in supply; helper accounts closed
  const lp_ = mintInfo(r.lpMint);
  assert.equal(lp_.supply, 0n, 'all LP tokens burned');
  assert.equal(acct(r.creatorLpToken), null, 'LP account closed');
  assert.equal(lamports(lp.poolCreatorPda(mint)), 0n, 'pool creator swept');
  // Supply: holders + pool + burned = 1B; curve vault empty
  assert.equal(tokenBal(lp.curveVault(mint)), 0n);
  assert.equal(mintInfo(mint).supply + ev.tokensBurned, S.TOTAL_SUPPLY);
  // Graduation fee leftover (after Raydium's 0.15 SOL fee + rent) becomes protocol fees
  const gained = config().feesAccrued - fees0;
  assert.equal(gained, ev.protocolFee);
  assert.ok(gained > sol(0.7) && gained < sol(1), `graduation fee kept ${gained}`);
  const g = curve(mint);
  assert.equal(g.graduated, true);
  assert.ok(g.pool.equals(r.poolState));
  fails([lp.graduate({ payer: carol.publicKey, mint, ammConfig })], [carol], 'AlreadyGraduated', { cu: 600_000 });
  assertSolvent(mint);
});

test('graduated token trades on Raydium in both directions', () => {
  const mint = gradMint;
  setTime(nowTs() + 60); // past pool open_time
  const tokAta = lp.userAta(carol.publicKey, mint);
  ok([
    ...wrapSolIxs(carol.publicKey, Number(sol(1))),
    spl.createAssociatedTokenAccountIdempotentInstruction(carol.publicKey, tokAta, carol.publicKey, mint, S.TOKEN_2022_PROGRAM_ID),
    raydiumSwapIx({ payer: carol.publicKey, mint, inputIsSol: true, amountIn: sol(1) }),
  ], [carol]);
  const got = tokenBal(tokAta);
  assert.ok(got > 0n, 'bought on Raydium');
  ok([raydiumSwapIx({ payer: carol.publicKey, mint, inputIsSol: false, amountIn: got })], [carol]);
  assert.equal(tokenBal(tokAta), 0n);
});

test('attack: pre-creating the canonical Raydium pool and pre-funding our pool address cannot block graduation', () => {
  const mint = launch();
  buy(carol, mint, sol(2));
  const r = lp.raydium(mint);
  // 1) Attacker creates the standard Raydium pool for this mint at a silly price.
  const canonical = PublicKey.findProgramAddressSync([Buffer.from('pool'), ammConfig.toBuffer(), r.token0Mint.toBuffer(), r.token1Mint.toBuffer()], lp.RAYDIUM_CPMM)[0];
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), canonical.toBuffer()], lp.RAYDIUM_CPMM)[0];
  const v = (m) => PublicKey.findProgramAddressSync([Buffer.from('pool_vault'), canonical.toBuffer(), m.toBuffer()], lp.RAYDIUM_CPMM)[0];
  const obs = PublicKey.findProgramAddressSync([Buffer.from('observation'), canonical.toBuffer()], lp.RAYDIUM_CPMM)[0];
  const carolTok = lp.userAta(carol.publicKey, mint);
  const carolWsol = S.ata(carol.publicKey, S.WSOL_MINT, S.TOKEN_PROGRAM_ID);
  const tokAmt = 1_000_000n * S.ONE_TOKEN, solAmt = sol(0.01);
  const [a0, a1, c0, c1, p0, p1] = r.tokenIs0
    ? [tokAmt, solAmt, carolTok, carolWsol, S.TOKEN_2022_PROGRAM_ID, S.TOKEN_PROGRAM_ID]
    : [solAmt, tokAmt, carolWsol, carolTok, S.TOKEN_PROGRAM_ID, S.TOKEN_2022_PROGRAM_ID];
  const data = Buffer.alloc(32);
  disc('global:initialize').copy(data, 0);
  data.writeBigUInt64LE(a0, 8); data.writeBigUInt64LE(a1, 16); data.writeBigUInt64LE(0n, 24);
  const m = (pubkey, w = false, s = false) => ({ pubkey: new PublicKey(pubkey), isWritable: w, isSigner: s });
  const { TransactionInstruction, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
  ok([
    ...wrapSolIxs(carol.publicKey, Number(solAmt)),
    new TransactionInstruction({ programId: lp.RAYDIUM_CPMM, data, keys: [
      m(carol.publicKey, true, true), m(ammConfig), m(r.authority), m(canonical, true), m(r.token0Mint), m(r.token1Mint), m(lpMint, true),
      m(c0, true), m(c1, true), m(S.ata(carol.publicKey, lpMint, S.TOKEN_PROGRAM_ID), true), m(v(r.token0Mint), true), m(v(r.token1Mint), true),
      m(r.createPoolFee, true), m(obs, true), m(S.TOKEN_PROGRAM_ID), m(p0), m(p1), m(S.ASSOCIATED_TOKEN_PROGRAM_ID), m(SystemProgram.programId), m(SYSVAR_RENT_PUBKEY),
    ] }),
  ], [carol], { cu: 400_000 });
  assert.ok(acct(canonical), 'attacker pool exists');
  // 2) Attacker also sends lamports to our pool_state / pool_creator addresses.
  ok([
    SystemProgram.transfer({ fromPubkey: carol.publicKey, toPubkey: r.poolState, lamports: 1_000_000 }),
    SystemProgram.transfer({ fromPubkey: carol.publicKey, toPubkey: lp.poolCreatorPda(mint), lamports: 1_000_000 }),
  ], [carol]);
  // Fill and graduate anyway.
  buy(bob, mint, sol(200));
  ok([lp.graduate({ payer: bob.publicKey, mint, ammConfig })], [bob], { cu: 600_000 });
  assert.equal(curve(mint).graduated, true);
  assert.ok(curve(mint).pool.equals(r.poolState));
  assertSolvent(mint);
});

test('distribute_fees: 10% to dev wallet, 90% to buyback wallet', () => {
  const total = config().feesAccrued;
  assert.ok(total > 0n);
  const d0 = lamports(devWallet.publicKey), b0 = lamports(buyback.publicKey);
  fails([lp.distributeFees({ devWallet: alice.publicKey, buybackWallet: buyback.publicKey })], [carol], 'ConstraintHasOne');
  ok([lp.distributeFees({ devWallet: devWallet.publicKey, buybackWallet: buyback.publicKey })], [carol]); // permissionless
  const dev = lamports(devWallet.publicKey) - d0, bb = lamports(buyback.publicKey) - b0;
  assert.equal(dev + bb, total);
  assert.equal(dev, (total * 1000n) / 10000n);
  console.log(`      distributed ${(Number(total) / 1e9).toFixed(4)} SOL: dev ${(Number(dev) / 1e9).toFixed(4)}, buyback ${(Number(bb) / 1e9).toFixed(4)}`);
  assert.equal(config().feesAccrued, 0n);
  fails([lp.distributeFees({ devWallet: devWallet.publicKey, buybackWallet: buyback.publicKey })], [carol], 'ZeroAmount');
});

test('fuzz: 150 random buys/sells keep every curve solvent and nobody profits from round trips', () => {
  const mint = launch();
  const users = [alice, bob, carol];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const flows = new Map(users.map((u) => [u.publicKey.toBase58(), 0n]));
  for (let i = 0; i < 150 && !curve(mint).complete; i++) {
    const u = users[Math.floor(rnd() * 3)];
    const bal = tokenBal(lp.userAta(u.publicKey, mint));
    const k = u.publicKey.toBase58();
    if (rnd() < 0.55 || bal === 0n) {
      const amt = sol(rnd() * 3 + 0.001);
      const q = S.quoteBuy(curve(mint), amt, 100);
      buy(u, mint, amt);
      flows.set(k, flows.get(k) - q.total);
    } else {
      const amt = (bal * BigInt(Math.floor(rnd() * 100) + 1)) / 100n;
      const q = S.quoteSell(curve(mint), amt, 100);
      sell(u, mint, amt);
      flows.set(k, flows.get(k) + q.solOut);
    }
    if (i % 15 === 0) assertSolvent(mint);
  }
  if (!curve(mint).complete) {
    for (const u of users) {
      const bal = tokenBal(lp.userAta(u.publicKey, mint));
      if (bal > 0n) { const q = S.quoteSell(curve(mint), bal, 100); sell(u, mint, bal); flows.set(u.publicKey.toBase58(), flows.get(u.publicKey.toBase58()) + q.solOut); }
    }
    const net = [...flows.values()].reduce((a, b) => a + b, 0n);
    assert.ok(net <= 0n, `traders extracted ${net} lamports`);
    const c = curve(mint);
    assert.equal(c.tokensSold, 0n);
    console.log(`      fuzz: traders net ${(Number(net) / 1e9).toFixed(4)} SOL (fees), dust left in curve ${c.realSol} lamports`);
  }
  assertSolvent(mint);
});
