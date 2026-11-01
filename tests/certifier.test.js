// Certification service test: real program in LiteSVM, real HyperEVM adapter against a local EVM
// (ganache), Monero and Zcash adapters against mock wallet RPC servers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { FailedTransactionMetadata } = require('litesvm');
const { makeSvm } = require('../devtools/svm');
const S = require('../client/secretum');
const { runOnce, memoryStore } = require('../certifier/certifier');

const ROOT = path.join(__dirname, '..');
const sol = (x) => BigInt(Math.round(x * LAMPORTS_PER_SOL));
let svm, lp, admin, certifier, user, servers = [], evm;

function ok(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const r = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (r instanceof FailedTransactionMetadata) throw new Error(r.meta().logs().filter((l) => /Error|failed/.test(l)).join('\n'));
  return r;
}
const curve = (mint) => S.decodeCurve(svm.getAccount(lp.curvePda(mint)).data);

// Solana access for the certifier, backed by LiteSVM.
const mints = [];
const solana = {
  async fetchCurves() { return mints.map(curve); },
  async recordCertificate(mint, chain, txid) { ok([lp.recordCertificate({ certifier: certifier.publicKey, mint, chain, txid })], [certifier]); },
};

function mockRpc(handlers) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      calls.push(j);
      const h = handlers[j.method];
      res.setHeader('content-type', 'application/json');
      let out;
      try { out = h ? { id: j.id, result: h(j.params) } : { id: j.id, error: { message: 'no such method ' + j.method } }; }
      catch (e) { out = { id: j.id, error: { message: e.message } }; }
      res.end(JSON.stringify(out));
    });
  });
  servers.push(srv);
  return new Promise((r) => srv.listen(0, () => r({ url: `http://127.0.0.1:${srv.address().port}/json_rpc`, calls })));
}

before(() => {
  svm = makeSvm();
  const PROGRAM_ID = new PublicKey(require('../devtools/program-id').PROGRAM_ID);
  svm.addProgramFromFile(PROGRAM_ID, path.join(ROOT, 'target/deploy/launchpad.so'));
  lp = S.makeClient(PROGRAM_ID, 'mainnet');
  svm.addProgramFromFile(lp.RAYDIUM_CPMM, path.join(ROOT, 'vendor/raydium_cp_swap.so'));
  [admin, certifier, user] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const k of [admin, certifier, user]) svm.airdrop(k.publicKey, BigInt(1000 * LAMPORTS_PER_SOL));
  const amm = Keypair.generate().publicKey;
  const b = Buffer.alloc(236);
  require('crypto').createHash('sha256').update('account:AmmConfig').digest().subarray(0, 8).copy(b, 0);
  svm.setAccount(amm, { lamports: 10_000_000, data: b, owner: lp.RAYDIUM_CPMM, executable: false });
  ok([lp.initialize({ admin: admin.publicKey, params: {
    certifier: certifier.publicKey, buybackWallet: admin.publicKey, devWallet: admin.publicKey, raydiumAmmConfig: amm,
    devShareBps: 1000, tradeFeeBps: 100, creationFee: 0n, graduationFee: sol(1), initialVirtualSol: sol(42.5), paused: false,
  } })], [admin]);
  for (const name of ['Alpha', 'Beta']) {
    const m = Keypair.generate();
    ok([lp.createToken({ creator: user.publicKey, mint: m.publicKey, name, symbol: name.toUpperCase(), uri: '' })], [user, m]);
    mints.push(m.publicKey);
  }
  evm = ganache.provider({ logging: { quiet: true }, chain: { chainId: 999 }, wallet: { totalAccounts: 1, defaultBalance: 10 } });
});
after(() => { for (const s of servers) s.close(); });

test('certifier anchors on all three chains, records txids on-chain once, and survives failures', async () => {
  // --- HyperEVM: real EVM transactions on a local chain
  const pk = Object.values(evm.getInitialAccounts())[0].secretKey;
  const hyper = require('../certifier/chains/hyperevm')({ privateKey: pk, provider: new ethers.BrowserProvider(evm) });

  // --- Monero wallet RPC mock (fails the first transfer to prove retry/no double-send)
  let moneroFailOnce = true, moneroTx = 0;
  const xmr = await mockRpc({
    get_address: () => ({ address: '4MoneroAddr' }),
    make_integrated_address: (p) => ({ integrated_address: `4Integrated-${p.payment_id}` }),
    transfer: () => { if (moneroFailOnce) { moneroFailOnce = false; throw new Error('boom'); } moneroTx++; return { tx_hash: (moneroTx.toString(16)).padStart(64, 'a'), tx_key: 'k'.repeat(64) }; },
    get_tx_proof: (p) => ({ signature: 'OutProofV2' + p.message.length }),
  });
  const xmrAdapter = require('../certifier/chains/monero')({ rpcUrl: xmr.url });

  // --- Zcash RPC mock
  let zops = 0;
  const zec = await mockRpc({
    z_sendmany: () => `opid-${++zops}`,
    z_getoperationresult: (p) => [{ id: p[0][0], status: 'success', result: { txid: String(zops).padStart(64, 'b') } }],
  });
  const zecAdapter = require('../certifier/chains/zcash')({ rpcUrl: zec.url, fromAddress: 'zs1from', pollMs: 1 });

  const store = memoryStore();
  const quiet = { info() {}, error() {} };
  const launchTs = Number(curve(mints[0]).createdAt);

  // Round 1: before the Zcash delay. The first Monero transfer errors (wallet RPC returns an error).
  await runOnce({ solana, chains: [hyper, xmrAdapter, zecAdapter], store, nowSec: launchTs + 60, log: quiet });
  for (const m of mints) {
    const c = curve(m);
    assert.ok(c.certs.hyperevm, 'hyperevm recorded');
    assert.equal(c.certs.zcash, null, 'zcash waits for the delay');
  }
  // Round 2: Monero now works for both; Zcash still waiting
  await runOnce({ solana, chains: [hyper, xmrAdapter, zecAdapter], store, nowSec: launchTs + 120, log: quiet });
  // Round 3: past the 15 minute delay
  await runOnce({ solana, chains: [hyper, xmrAdapter, zecAdapter], store, nowSec: launchTs + 901, log: quiet });

  const prov = new ethers.BrowserProvider(evm);
  for (const m of mints) {
    const c = curve(m);
    const hashHex = S.toHex(c.launchHash);
    const payload = S.certificatePayload(hashHex);
    assert.equal(c.certFlags, 0b111, 'all three chains recorded on Solana');
    // HyperEVM: the calldata on-chain is exactly the payload
    const tx = await prov.getTransaction(c.certs.hyperevm);
    assert.equal(ethers.toUtf8String(tx.data), payload);
    // Monero: payment id = first 8 bytes of hash; proof signs the full payload
    const rec = store.get(m.toBase58());
    assert.equal(rec.chains.monero.paymentId, hashHex.slice(0, 16));
    assert.equal(rec.chains.monero.message, payload);
    assert.equal(rec.chains.monero.txid, c.certs.monero);
    // Zcash: memo is the payload (hex encoded in the RPC call)
    const zcall = zec.calls.find((x) => x.method === 'z_sendmany' && Buffer.from(x.params[1][0].memo, 'hex').toString() === payload);
    assert.ok(zcall, 'zcash memo carries payload');
  }
  // Exactly one anchor per chain per coin — retries never re-send
  assert.equal(xmr.calls.filter((x) => x.method === 'transfer').length, 3); // 1 failed + 2 ok
  assert.equal(zec.calls.filter((x) => x.method === 'z_sendmany').length, 2);
  const before = zec.calls.length + xmr.calls.length;
  await runOnce({ solana, chains: [hyper, xmrAdapter, zecAdapter], store, nowSec: launchTs + 2000, log: quiet });
  assert.equal(zec.calls.length + xmr.calls.length, before, 'nothing left to do');
});

test('certifier retries the Solana write without re-anchoring if recording fails', async () => {
  const m = Keypair.generate();
  ok([lp.createToken({ creator: user.publicKey, mint: m.publicKey, name: 'Gamma', symbol: 'GAM', uri: '' })], [user, m]);
  let anchors = 0, failRecord = true;
  const fake = { name: 'hyperevm', chain: 2, async anchor() { anchors++; return { txid: '0x' + 'c'.repeat(64), details: {} }; } };
  const flaky = {
    fetchCurves: async () => [curve(m.publicKey)],
    async recordCertificate(...a) { if (failRecord) { failRecord = false; throw new Error('rpc down'); } return solana.recordCertificate(...a); },
  };
  const store = memoryStore();
  const quiet = { info() {}, error() {} };
  await runOnce({ solana: flaky, chains: [fake], store, log: quiet });
  assert.equal(curve(m.publicKey).certs.hyperevm, null);
  assert.equal(store.get(m.publicKey.toBase58()).chains.hyperevm.recorded, false);
  await runOnce({ solana: flaky, chains: [fake], store, log: quiet });
  assert.equal(anchors, 1, 'anchored exactly once');
  assert.equal(curve(m.publicKey).certs.hyperevm, '0x' + 'c'.repeat(64));
});
