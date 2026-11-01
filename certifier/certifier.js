// Core certification loop, independent of how Solana is reached (RPC in production, LiteSVM in
// tests). For every launch missing a certificate on an enabled chain it:
//   1. anchors "SECRETUM1:<launch hash>" on that chain (once — remembered in the store), then
//   2. writes the chain's txid into the coin's on-chain record via record_certificate.
// If step 2 fails the txid is kept and step 2 is retried next round, so nothing is double-sent.
const fs = require('fs');
const S = require('../client/secretum');

/** JSON file store. Doubles as the public proof file served over HTTP. */
function fileStore(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    get: (mint) => data[mint],
    all: () => data,
    put(mint, v) {
      data[mint] = v;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file); // atomic
    },
  };
}

function memoryStore() {
  const data = {};
  return { get: (m) => data[m], all: () => data, put: (m, v) => { data[m] = v; } };
}

/**
 * @param solana  { fetchCurves(): Promise<Curve[]>, recordCertificate(mint, chain, txid): Promise<void> }
 * @param chains  adapters from ./chains (each { name, chain, anchor({payload, hashHex}) })
 * @param zcashDelaySec  wait this long after launch before anchoring on Zcash (Origo-style stagger)
 */
async function runOnce({ solana, chains, store, nowSec = Math.floor(Date.now() / 1000), zcashDelaySec = 900, log = console }) {
  const curves = await solana.fetchCurves();
  const done = [];
  for (const c of curves) {
    const mint = c.mint.toBase58();
    const hashHex = S.toHex(c.launchHash);
    const payload = S.certificatePayload(hashHex);
    for (const adapter of chains) {
      const bit = 1 << adapter.chain;
      if (c.certFlags & bit) continue;
      if (adapter.name === 'zcash' && nowSec - Number(c.createdAt) < zcashDelaySec) continue;
      const rec = store.get(mint) || { mint, launchHash: hashHex, payload, chains: {} };
      try {
        let entry = rec.chains[adapter.name];
        if (!entry) {
          log.info?.(`[${adapter.name}] anchoring ${mint}`);
          const r = await adapter.anchor({ payload, hashHex, mint });
          entry = { txid: r.txid, ...r.details, anchoredAt: new Date().toISOString(), recorded: false };
          rec.chains[adapter.name] = entry;
          store.put(mint, rec); // remember before touching Solana, so we never anchor twice
        }
        await solana.recordCertificate(c.mint, adapter.chain, entry.txid);
        entry.recorded = true;
        store.put(mint, rec);
        done.push({ mint, chain: adapter.name, txid: entry.txid });
        log.info?.(`[${adapter.name}] recorded ${mint} -> ${entry.txid}`);
      } catch (e) {
        log.error?.(`[${adapter.name}] ${mint}: ${e.message}`);
      }
    }
  }
  return done;
}

/** Production Solana access over RPC. */
function rpcSolana({ connection, client, certifier }) {
  const web3 = require('@solana/web3.js');
  const bs58 = require('bs58');
  const enc = (bs58.default || bs58).encode;
  return {
    async fetchCurves() {
      const accts = await connection.getProgramAccounts(client.PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: enc(S.ACC_DISC.Curve) } }],
      });
      return accts.map((a) => S.decodeCurve(a.account.data));
    },
    async recordCertificate(mint, chain, txid) {
      const tx = new web3.Transaction().add(client.recordCertificate({ certifier: certifier.publicKey, mint, chain, txid }));
      await web3.sendAndConfirmTransaction(connection, tx, [certifier], { commitment: 'confirmed' });
    },
  };
}

module.exports = { runOnce, fileStore, memoryStore, rpcSolana };
