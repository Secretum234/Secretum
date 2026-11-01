#!/usr/bin/env node
// Secretum certification service. Configure with environment variables (see .env.example), then:
//   node certifier/index.js
// It polls for new launches, anchors their certificate on each enabled chain, records the txids
// on Solana, and serves the public proofs at GET /certificates/<mint>.
const fs = require('fs');
const http = require('http');
const path = require('path');
const web3 = require('@solana/web3.js');
const S = require('../client/secretum');
const { runOnce, fileStore, rpcSolana } = require('./certifier');

const env = (k, d) => process.env[k] ?? d;
const on = (k) => /^(1|true|yes)$/i.test(env(k, ''));

function loadKeypair(file) {
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

function buildChains() {
  const chains = [];
  if (on('ENABLE_HYPEREVM')) {
    chains.push(require('./chains/hyperevm')({
      rpcUrl: env('HYPEREVM_RPC_URL', 'https://rpc.hyperliquid.xyz/evm'),
      chainId: Number(env('HYPEREVM_CHAIN_ID', 999)),
      privateKey: env('HYPEREVM_PRIVATE_KEY'),
    }));
  }
  if (on('ENABLE_MONERO')) {
    chains.push(require('./chains/monero')({
      rpcUrl: env('MONERO_WALLET_RPC_URL', 'http://127.0.0.1:18082/json_rpc'),
      amountPiconero: BigInt(env('MONERO_AMOUNT_PICONERO', 1_000_000)),
    }));
  }
  if (on('ENABLE_ZCASH')) {
    chains.push(require('./chains/zcash')({
      rpcUrl: env('ZCASH_RPC_URL', 'http://127.0.0.1:8232'),
      rpcUser: env('ZCASH_RPC_USER'), rpcPassword: env('ZCASH_RPC_PASSWORD'),
      fromAddress: env('ZCASH_FROM_ADDRESS'), toAddress: env('ZCASH_TO_ADDRESS'),
      amountZec: Number(env('ZCASH_AMOUNT_ZEC', 0.00001)),
      privacyPolicy: env('ZCASH_PRIVACY_POLICY', 'FullPrivacy'),
    }));
  }
  return chains;
}

async function main() {
  const cluster = env('CLUSTER', 'devnet');
  const connection = new web3.Connection(env('SOLANA_RPC_URL', web3.clusterApiUrl(cluster === 'mainnet' ? 'mainnet-beta' : 'devnet')), 'confirmed');
  const client = S.makeClient(env('PROGRAM_ID'), cluster);
  const certifier = loadKeypair(env('CERTIFIER_KEYPAIR', 'keys/certifier.json'));
  const chains = buildChains();
  if (!chains.length) throw new Error('Enable at least one chain: ENABLE_HYPEREVM / ENABLE_MONERO / ENABLE_ZCASH');

  const cfg = S.decodeConfig((await connection.getAccountInfo(client.configPda())).data);
  if (!cfg.certifier.equals(certifier.publicKey)) {
    throw new Error(`Keypair ${certifier.publicKey.toBase58()} is not the configured certifier (${cfg.certifier.toBase58()})`);
  }

  const store = fileStore(env('CERT_STORE', path.join(process.cwd(), 'certificates.json')));
  const solana = rpcSolana({ connection, client, certifier });
  const intervalMs = Number(env('POLL_SECONDS', 30)) * 1000;
  const zcashDelaySec = Number(env('ZCASH_DELAY_SECONDS', 900));
  console.log(`Certifier ${certifier.publicKey.toBase58()} on ${cluster}; chains: ${chains.map((c) => c.name).join(', ')}`);

  // Public proof server
  const publicKeys = {
    moneroAddress: env('MONERO_PUBLIC_ADDRESS', ''),
    moneroViewKey: env('MONERO_PUBLIC_VIEW_KEY', ''),
    zcashViewingKey: env('ZCASH_VIEWING_KEY', ''),
    hyperevmAddress: chains.find((c) => c.name === 'hyperevm')?.address || '',
  };
  http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    const m = req.url.match(/^\/certificates\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (m) {
      const rec = store.get(m[1]);
      res.statusCode = rec ? 200 : 404;
      return res.end(JSON.stringify(rec || { error: 'not found' }));
    }
    if (req.url === '/keys') return res.end(JSON.stringify(publicKeys));
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404; res.end('{}');
  }).listen(Number(env('PORT', 8787)), () => console.log(`Proof server on :${env('PORT', 8787)}`));

  for (;;) {
    try { await runOnce({ solana, chains, store, zcashDelaySec }); } catch (e) { console.error('round failed:', e.message); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
