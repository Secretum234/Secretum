#!/usr/bin/env node
// Local sandbox: the real Secretum + Raydium programs running in LiteSVM behind a minimal Solana
// JSON-RPC, serving the website with a burner wallet. No devnet, no real funds.
//   npm run sandbox   ->  http://localhost:8899
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require('@solana/web3.js');
const { FailedTransactionMetadata, Clock } = require('litesvm');
const bs58 = (require('bs58').default || require('bs58'));
const S = require('../client/secretum');
const { makeSvm } = require('./svm');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const PORT = Number(process.env.PORT || 8899);
const PROGRAM_ID = new PublicKey(require('../devtools/program-id').PROGRAM_ID);
const sol = (x) => BigInt(Math.round(x * LAMPORTS_PER_SOL));

const svm = makeSvm({ sigverify: false });
const lp = S.makeClient(PROGRAM_ID, 'mainnet');
svm.addProgramFromFile(PROGRAM_ID, path.join(ROOT, 'target/deploy/launchpad.so'));
svm.addProgramFromFile(lp.RAYDIUM_CPMM, path.join(ROOT, 'vendor/raydium_cp_swap.so'));

let slot = 1000n;
function tick() {
  slot += 1n;
  svm.setClock(new Clock(slot, 0n, 0n, 0n, BigInt(Math.floor(Date.now() / 1000))));
}
tick();

// ----------------------------------------------------------- bookkeeping for RPC queries
const txs = new Map(); // sig -> { slot, blockTime, raw, logs, err, cu }
const sigsByAccount = new Map(); // base58 -> [sig newest first]
const knownCurves = new Set();

function record(bytes, res) {
  const tx = Transaction.from(bytes);
  const sig = bs58.encode(tx.signature || new Uint8Array(64));
  const failed = res instanceof FailedTransactionMetadata;
  const meta = failed ? res.meta() : res;
  const entry = { slot: Number(slot), blockTime: Math.floor(Date.now() / 1000), bytes, logs: meta.logs(), err: failed ? { InstructionError: [0, 'Custom'] } : null, cu: Number(meta.computeUnitsConsumed()) };
  txs.set(sig, entry);
  for (const k of tx.compileMessage().accountKeys) {
    const key = k.toBase58();
    if (!sigsByAccount.has(key)) sigsByAccount.set(key, []);
    sigsByAccount.get(key).unshift(sig);
  }
  for (const e of S.parseEvents(entry.logs)) if (e.name === 'TokenCreated') knownCurves.add(lp.curvePda(e.mint).toBase58());
  return { sig, failed, logs: entry.logs };
}

function execute(ixs, signers, cu) {
  tick();
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const bytes = tx.serialize();
  const res = svm.sendRaw(bytes);
  svm.expireBlockhash();
  const r = record(bytes, res);
  if (r.failed) throw new Error(r.logs.filter((l) => /Error|failed/.test(l)).join('\n'));
  return r;
}

// ----------------------------------------------------------- seed data
const admin = Keypair.generate();
const certifier = Keypair.generate();
const traders = Array.from({ length: 4 }, () => Keypair.generate());
for (const k of [admin, certifier, ...traders]) svm.airdrop(k.publicKey, sol(100_000));
const amm = Keypair.generate().publicKey;
{
  const b = Buffer.alloc(236);
  crypto.createHash('sha256').update('account:AmmConfig').digest().subarray(0, 8).copy(b, 0);
  b.writeUInt8(255, 8); b.writeBigUInt64LE(2500n, 12); b.writeBigUInt64LE(150_000_000n, 36);
  svm.setAccount(amm, { lamports: 10_000_000, data: b, owner: lp.RAYDIUM_CPMM, executable: false });
  const spl = require('@solana/spl-token');
  const fee = Buffer.alloc(spl.ACCOUNT_SIZE);
  spl.AccountLayout.encode({ mint: S.WSOL_MINT, owner: admin.publicKey, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 1, isNative: 2039280n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, fee);
  svm.setAccount(S.CLUSTERS.mainnet.raydiumCreatePoolFee, { lamports: 2039280, data: fee, owner: S.TOKEN_PROGRAM_ID, executable: false });
}
execute([lp.initialize({ admin: admin.publicKey, params: {
  certifier: certifier.publicKey, buybackWallet: admin.publicKey, devWallet: admin.publicKey, raydiumAmmConfig: amm,
  devShareBps: 1000, tradeFeeBps: 100, creationFee: sol(0.02), graduationFee: sol(1), initialVirtualSol: sol(42.5), paused: false,
} })], [admin]);

const SEED = [
  { name: 'Night Archive', symbol: 'ARCH', buys: [3, 1.5, 7, 2.2, 0.8, 4], certs: 7 },
  { name: 'Quiet Ledger', symbol: 'QLED', buys: [12, 9, 6.5, 14, 3, 5.2, 8], certs: 5 },
  { name: 'Moth & Candle', symbol: 'MOTH', buys: [0.6, 0.4, 1.1], certs: 1 },
  { name: 'Ciphertext', symbol: 'CIPH', buys: [200], certs: 7, graduate: true },
  { name: 'Wax Lamb', symbol: 'LAMB', buys: [0.25], certs: 0 },
];
for (const [i, s] of SEED.entries()) {
  const creator = traders[i % traders.length];
  const mint = Keypair.generate();
  execute([lp.createToken({ creator: creator.publicKey, mint: mint.publicKey, name: s.name, symbol: s.symbol, uri: '' })], [creator, mint], 300_000);
  s.buys.forEach((amt, j) => execute([lp.buy({ user: traders[(i + j) % traders.length].publicKey, mint: mint.publicKey, maxSol: sol(amt) })], [traders[(i + j) % traders.length]]));
  if (s.buys.length > 2) {
    const seller = traders[(i + 1) % traders.length];
    const bal = svm.getAccount(lp.userAta(seller.publicKey, mint.publicKey));
    if (bal) {
      const amount = Buffer.from(bal.data).readBigUInt64LE(64) / 3n;
      if (amount > 0n) execute([lp.sell({ user: seller.publicKey, mint: mint.publicKey, tokenAmount: amount })], [seller]);
    }
  }
  if (s.graduate) execute([lp.graduate({ payer: traders[0].publicKey, mint: mint.publicKey, ammConfig: amm })], [traders[0]], 600_000);
  [0, 1, 2].forEach((chain) => {
    if (s.certs & (1 << chain)) execute([lp.recordCertificate({ certifier: certifier.publicKey, mint: mint.publicKey, chain, txid: crypto.randomBytes(32) })], [certifier]);
  });
}

// ----------------------------------------------------------- JSON-RPC
const ctx = () => ({ context: { slot: Number(slot) } });
const encAccount = (a) => a && { data: [Buffer.from(a.data).toString('base64'), 'base64'], executable: a.executable, lamports: a.lamports, owner: a.owner.toBase58(), rentEpoch: 0, space: a.data.length };
const sigStatus = (sig) => { const t = txs.get(sig); return t ? { slot: t.slot, confirmations: null, err: t.err, confirmationStatus: 'confirmed' } : null; };

function txResult(sig) {
  const t = txs.get(sig);
  if (!t) return null;
  const tx = Transaction.from(t.bytes);
  const msg = tx.compileMessage();
  return {
    slot: t.slot, blockTime: t.blockTime, version: 'legacy',
    transaction: {
      signatures: tx.signatures.map((s) => bs58.encode(s.signature || new Uint8Array(64))),
      message: {
        accountKeys: msg.accountKeys.map((k) => k.toBase58()), header: msg.header, recentBlockhash: msg.recentBlockhash,
        instructions: msg.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data })),
      },
    },
    meta: {
      err: t.err, fee: 5000, preBalances: msg.accountKeys.map(() => 0), postBalances: msg.accountKeys.map(() => 0),
      innerInstructions: [], logMessages: t.logs, preTokenBalances: [], postTokenBalances: [], rewards: [],
      loadedAddresses: { writable: [], readonly: [] }, computeUnitsConsumed: t.cu, status: t.err ? { Err: t.err } : { Ok: null },
    },
  };
}

const methods = {
  getHealth: () => 'ok',
  getVersion: () => ({ 'solana-core': 'sandbox', 'feature-set': 0 }),
  getSlot: () => Number(slot),
  getBlockHeight: () => Number(slot),
  getLatestBlockhash: () => ({ ...ctx(), value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(slot) + 150 } }),
  getBalance: ([pk]) => ({ ...ctx(), value: svm.getAccount(pk)?.lamports ?? 0 }),
  getAccountInfo: ([pk]) => ({ ...ctx(), value: encAccount(svm.getAccount(pk)) }),
  getMultipleAccounts: ([pks]) => ({ ...ctx(), value: pks.map((k) => encAccount(svm.getAccount(k))) }),
  getMinimumBalanceForRentExemption: ([n]) => Number(svm.minimumBalanceForRentExemption(n)),
  getProgramAccounts: ([prog, opts = {}]) => {
    if (prog !== PROGRAM_ID.toBase58()) return [];
    const keys = [lp.configPda().toBase58(), ...knownCurves];
    const memcmp = (opts.filters || []).filter((f) => f.memcmp).map((f) => f.memcmp);
    return keys.map((k) => ({ pubkey: k, account: svm.getAccount(k) })).filter(({ account }) => account && memcmp.every((m) => {
      const want = bs58.decode(m.bytes);
      return Buffer.from(account.data).subarray(m.offset, m.offset + want.length).equals(Buffer.from(want));
    })).map(({ pubkey, account }) => ({ pubkey, account: encAccount(account) }));
  },
  getTokenAccountBalance: ([pk]) => {
    const a = svm.getAccount(pk);
    if (!a) throw Object.assign(new Error('could not find account'), { code: -32602 });
    const amount = Buffer.from(a.data).readBigUInt64LE(64);
    return { ...ctx(), value: { amount: amount.toString(), decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) } };
  },
  simulateTransaction: ([b64]) => {
    tick();
    // Real RPCs accept any recent blockhash; LiteSVM only the latest. web3.js simulates with its
    // own cached blockhash, so swap in the current one (signatures aren't verified here).
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    tx.recentBlockhash = svm.latestBlockhash();
    const r = svm.simulateRaw(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const failed = r instanceof FailedTransactionMetadata;
    const meta = r.meta();
    if (failed && process.env.SANDBOX_DEBUG) console.error('simulate failed:', r.toString().slice(0, 600));
    return { ...ctx(), value: { err: failed ? { InstructionError: [0, 'Custom'] } : null, logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()), accounts: null, returnData: null } };
  },
  sendTransaction: ([b64]) => {
    tick();
    const bytes = Buffer.from(b64, 'base64');
    const res = svm.sendRaw(bytes);
    svm.expireBlockhash();
    const r = record(bytes, res);
    if (r.failed) throw Object.assign(new Error('Transaction simulation failed'), { code: -32002, data: { logs: r.logs } });
    return r.sig;
  },
  getSignatureStatuses: ([sigs]) => ({ ...ctx(), value: sigs.map(sigStatus) }),
  getSignaturesForAddress: ([addr, opts = {}]) => (sigsByAccount.get(addr) || []).slice(0, opts.limit || 1000).map((sig) => {
    const t = txs.get(sig);
    return { signature: sig, slot: t.slot, err: t.err, memo: null, blockTime: t.blockTime, confirmationStatus: 'confirmed' };
  }),
  getTransaction: ([sig]) => txResult(sig),
  requestAirdrop: ([pk, lamports]) => { svm.airdrop(pk, BigInt(lamports)); return bs58.encode(crypto.randomBytes(64)); },
};

function handle(req) {
  const fn = methods[req.method];
  try {
    if (!fn) throw Object.assign(new Error('Method not found: ' + req.method), { code: -32601 });
    return { jsonrpc: '2.0', id: req.id, result: fn(req.params || []) };
  } catch (e) {
    return { jsonrpc: '2.0', id: req.id, error: { code: e.code || -32000, message: e.message, data: e.data } };
  }
}

// ----------------------------------------------------------- static site + sandbox config
const burner = Keypair.generate();
svm.airdrop(burner.publicKey, sol(500));
const sandboxConfig = `
window.SECRETUM_CONFIG.cluster = 'mainnet'; // sandbox runs Raydium's mainnet build
window.SECRETUM_CONFIG.networkName = 'Sandbox';
window.SECRETUM_CONFIG.rpc = location.origin + '/rpc';
window.SECRETUM_CONFIG.sandbox = true;
window.SECRETUM_CONFIG.explorers.solanaTx = () => '#';
window.SECRETUM_CONFIG.explorers.solanaAccount = () => '#';
`;
const sandboxWallet = `
(() => {
  const kp = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(${JSON.stringify(Array.from(burner.secretKey))}));
  window.secretumSandboxWallet = {
    publicKey: kp.publicKey,
    connect: async () => ({ publicKey: kp.publicKey }),
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    on() {},
  };
})();`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let out;
      try { const j = JSON.parse(body); out = Array.isArray(j) ? j.map(handle) : handle(j); }
      catch (e) { out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/sandbox.js') { res.setHeader('content-type', 'text/javascript'); return res.end(sandboxConfig + sandboxWallet); }
  const file = path.join(APP, path.normalize(p));
  if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  let data = fs.readFileSync(file);
  if (p === '/index.html') data = Buffer.from(String(data).replace('<script src="app.js"></script>', '<script src="sandbox.js"></script>\n<script src="app.js"></script>'));
  res.end(data);
}).listen(PORT, () => {
  console.log(`Secretum sandbox running at http://localhost:${PORT}`);
  console.log(`  ${SEED.length} sample coins, burner wallet ${burner.publicKey.toBase58()} (500 SOL)`);
});
