// Buyback keeper: spends the buyback wallet's SOL on $SECRETUM and burns it, on the curve before
// graduation and through Raydium after.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { FailedTransactionMetadata, Clock } = require('litesvm');
const { makeSvm, setUpgradeAuthority } = require('../devtools/svm');
const { planBuyback } = require('../devtools/buyback');
const S = require('../client/secretum');

const ROOT = path.join(__dirname, '..');
const sol = (x) => BigInt(Math.round(x * LAMPORTS_PER_SOL));
let svm, lp, admin, buyback, whale, amm, secretum;

function ok(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const r = svm.sendTransaction(tx); svm.expireBlockhash();
  if (r instanceof FailedTransactionMetadata) throw new Error(r.toString().slice(0, 300) + '\n' + r.meta().logs().filter((l) => /Error|failed/.test(l)).join('\n'));
}
const read = {
  balance: async (pk) => svm.getAccount(pk)?.lamports ?? 0,
  data: async (pk) => svm.getAccount(pk).data,
  tokenBalance: async (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data).readBigUInt64LE(64) : 0n; },
};
const supply = () => spl.unpackMint(secretum, { ...svm.getAccount(secretum), data: Buffer.from(svm.getAccount(secretum).data) }, S.TOKEN_2022_PROGRAM_ID).supply;

before(() => {
  svm = makeSvm();
  const PROGRAM_ID = new PublicKey(require('../devtools/program-id').PROGRAM_ID);
  svm.addProgramFromFile(PROGRAM_ID, path.join(ROOT, 'target/deploy/launchpad.so'));
  lp = S.makeClient(PROGRAM_ID, 'mainnet');
  svm.addProgramFromFile(lp.RAYDIUM_CPMM, path.join(ROOT, 'vendor/raydium_cp_swap.so'));
  svm.setClock(new Clock(100n, 0n, 0n, 0n, 1_780_000_000n));
  [admin, buyback, whale] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const k of [admin, whale]) svm.airdrop(k.publicKey, sol(10_000));
  svm.airdrop(buyback.publicKey, sol(3));
  amm = Keypair.generate().publicKey;
  const b = Buffer.alloc(236);
  crypto.createHash('sha256').update('account:AmmConfig').digest().subarray(0, 8).copy(b, 0);
  b.writeUInt8(255, 8); b.writeBigUInt64LE(2500n, 12); b.writeBigUInt64LE(150_000_000n, 36);
  svm.setAccount(amm, { lamports: 10_000_000, data: b, owner: lp.RAYDIUM_CPMM, executable: false });
  const fee = Buffer.alloc(spl.ACCOUNT_SIZE);
  spl.AccountLayout.encode({ mint: S.WSOL_MINT, owner: admin.publicKey, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 1, isNative: 2039280n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, fee);
  svm.setAccount(S.CLUSTERS.mainnet.raydiumCreatePoolFee, { lamports: 2039280, data: fee, owner: S.TOKEN_PROGRAM_ID, executable: false });
  setUpgradeAuthority(svm, lp.PROGRAM_ID, admin.publicKey);
  ok([lp.initialize({ authority: admin.publicKey, admin: admin.publicKey, params: { certifier: admin.publicKey, buybackWallet: buyback.publicKey, devWallet: admin.publicKey,
    raydiumAmmConfig: amm, devShareBps: 1000, tradeFeeBps: 100, creationFee: sol(0.02), graduationFee: sol(1), initialVirtualSol: sol(42.5), paused: false } })], [admin]);
  const m = Keypair.generate();
  ok([lp.createToken({ creator: admin.publicKey, mint: m.publicKey, name: 'Secretum', symbol: 'SECRETUM', uri: '' })], [admin, m]);
  secretum = m.publicKey;
});

test('buyback on the curve: buys $SECRETUM with spare SOL, keeps the reserve, burns what it bought', async () => {
  const s0 = supply();
  const plan = await planBuyback({ lp, read, wallet: buyback.publicKey, mint: secretum, reserveLamports: sol(0.5) });
  assert.equal(plan.route, 'curve');
  ok(plan.ixs, [buyback]);
  const burned = s0 - supply();
  assert.ok(burned > 0n && burned <= plan.expectedTokens);
  assert.ok(BigInt(await read.balance(buyback.publicKey)) >= sol(0.49), 'reserve kept');
  assert.equal(await planBuyback({ lp, read, wallet: buyback.publicKey, mint: secretum, reserveLamports: sol(0.5) }), null, 'nothing more to spend');
});

test('buyback after graduation: swaps through the Raydium pool and burns', async () => {
  ok([lp.buy({ user: whale.publicKey, mint: secretum, maxSol: sol(200) })], [whale]);
  ok([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), lp.graduate({ payer: whale.publicKey, mint: secretum, ammConfig: amm })], [whale]);
  svm.setClock(new Clock(200n, 0n, 0n, 0n, 1_780_000_100n));
  svm.airdrop(buyback.publicKey, sol(2));
  const s0 = supply();
  const plan = await planBuyback({ lp, read, wallet: buyback.publicKey, mint: secretum, reserveLamports: sol(0.5), maxLamports: sol(1) });
  assert.equal(plan.route, 'raydium');
  assert.equal(plan.spend, sol(1));
  ok(plan.ixs, [buyback]);
  const burned = s0 - supply();
  assert.ok(burned > 0n, 'burned');
  assert.ok(burned >= (plan.expectedTokens * 97n) / 100n, 'burned at least the slippage-protected minimum');
});
