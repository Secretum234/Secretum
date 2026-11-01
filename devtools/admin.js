#!/usr/bin/env node
// Secretum admin tool.
//
//   node devtools/admin.js show
//   node devtools/admin.js init   --deployer ~/.config/solana/id.json --admin-address <pubkey>
//                                 --certifier <pubkey> --dev-wallet <pubkey> --buyback-wallet <pubkey> [options]
//        (init must be signed by the program's upgrade authority, i.e. the key that deployed it)
//   node devtools/admin.js update --admin keys/admin.json [any option below]
//   node devtools/admin.js pause | unpause --admin keys/admin.json
//   node devtools/admin.js propose-admin --admin keys/admin.json --new-admin <pubkey>
//   node devtools/admin.js distribute --payer keys/any.json      (permissionless: pays out accrued fees)
//
// Options: --cluster devnet|mainnet  --rpc <url>  --program-id <id>
//          --amm-config <raydium cpmm config> (or --amm-config-index 0)  --trade-fee-bps 100  --dev-share-bps 1000
//          --creation-fee-sol 0.02  --graduation-fee-sol 1  --initial-virtual-sol 42.5  --yes
const fs = require('fs');
const web3 = require('@solana/web3.js');
const S = require('../client/secretum');
const { PROGRAM_ID } = require('./program-id');

// Raydium CPMM fee config: derived from Raydium's seeds (index 0 = 0.25% fee), so it's right on
// each cluster. Mainnet index 0 is D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2. The program also
// checks the account is owned by Raydium's CPMM, so a wrong address is rejected.
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const flag = (name) => argv.includes('--' + name);
const cluster = opt('cluster', 'devnet');
const rpc = opt('rpc', cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const conn = new web3.Connection(rpc, 'confirmed');
const lp = S.makeClient(opt('program-id', PROGRAM_ID), cluster);
const lamports = (sol) => BigInt(Math.round(Number(sol) * web3.LAMPORTS_PER_SOL));
const fmtSol = (l) => `${Number(l) / web3.LAMPORTS_PER_SOL} SOL`;
const loadKey = (f) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));

async function current() {
  const a = await conn.getAccountInfo(lp.configPda());
  return a ? S.decodeConfig(a.data) : null;
}

function show(c) {
  if (!c) return console.log(`No config yet on ${cluster} for program ${lp.PROGRAM_ID.toBase58()}. Run "init".`);
  console.log(`Secretum on ${cluster} (program ${lp.PROGRAM_ID.toBase58()})
  admin             ${c.admin.toBase58()}${c.pendingAdmin.equals(web3.PublicKey.default) ? '' : `  (pending: ${c.pendingAdmin.toBase58()})`}
  certifier         ${c.certifier.toBase58()}
  dev wallet        ${c.devWallet.toBase58()}  (${c.devShareBps / 100}% of fees)
  buyback wallet    ${c.buybackWallet.toBase58()}  (${100 - c.devShareBps / 100}% of fees)
  raydium config    ${c.raydiumAmmConfig.toBase58()}
  trading fee       ${c.tradeFeeBps / 100}%
  launch fee        ${fmtSol(c.creationFee)}
  graduation fee    ${fmtSol(c.graduationFee)}
  virtual SOL       ${fmtSol(c.initialVirtualSol)}  (curve fills at ~${fmtSol(c.initialVirtualSol * 2n)})
  fees to pay out   ${fmtSol(c.feesAccrued)}
  coins launched    ${c.tokenCount}
  paused            ${c.paused}`);
}

function params(base) {
  const pk = (name, cur) => new web3.PublicKey(opt(name, cur?.toBase58?.() ?? cur));
  return {
    certifier: pk('certifier', base?.certifier),
    devWallet: pk('dev-wallet', base?.devWallet),
    buybackWallet: pk('buyback-wallet', base?.buybackWallet),
    raydiumAmmConfig: pk('amm-config', base?.raydiumAmmConfig ?? lp.raydiumAmmConfig(Number(opt('amm-config-index', 0)))),
    devShareBps: Number(opt('dev-share-bps', base?.devShareBps ?? 1000)),
    tradeFeeBps: Number(opt('trade-fee-bps', base?.tradeFeeBps ?? 100)),
    creationFee: opt('creation-fee-sol') != null ? lamports(opt('creation-fee-sol')) : (base?.creationFee ?? lamports(0.02)),
    graduationFee: opt('graduation-fee-sol') != null ? lamports(opt('graduation-fee-sol')) : (base?.graduationFee ?? lamports(1)),
    initialVirtualSol: opt('initial-virtual-sol') != null ? lamports(opt('initial-virtual-sol')) : (base?.initialVirtualSol ?? lamports(42.5)),
    paused: base?.paused ?? false,
  };
}

async function send(ix, signer) {
  const sig = await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(ix), [signer], { commitment: 'confirmed' });
  console.log('Done:', sig);
}

async function checkAmmConfig(addr) {
  const a = await conn.getAccountInfo(addr);
  if (!a || !a.owner.equals(lp.RAYDIUM_CPMM)) {
    throw new Error(`No Raydium CPMM fee config at ${addr.toBase58()} on ${cluster}. Try another --amm-config-index (1, 2, ...) or pass --amm-config <address>.`);
  }
}

async function confirmPrompt(p) {
  console.log('About to write:');
  for (const [k, v] of Object.entries(p)) console.log(`  ${k.padEnd(18)} ${v?.toBase58?.() ?? v}`);
  if (flag('yes')) return;
  process.stdout.write('Proceed? [y/N] ');
  const answer = await new Promise((r) => process.stdin.once('data', (d) => r(String(d).trim())));
  if (!/^y/i.test(answer)) { console.log('Cancelled.'); process.exit(1); }
}

const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
if (!['show', 'init', 'update', 'pause', 'unpause', 'propose-admin', 'accept-admin', 'distribute'].includes(cmd)) { console.log(USAGE); process.exit(0); }

(async () => {
  const c = await current();
  switch (cmd) {
    case 'show': return show(c);
    case 'init': {
      if (c) throw new Error('Already initialised. Use "update".');
      const deployer = loadKey(opt('deployer', require('os').homedir() + '/.config/solana/id.json'));
      const adminAddress = new web3.PublicKey(opt('admin-address'));
      const p = params(null);
      await checkAmmConfig(p.raydiumAmmConfig);
      await confirmPrompt({ admin: adminAddress, ...p });
      return send(lp.initialize({ authority: deployer.publicKey, admin: adminAddress, params: p }), deployer);
    }
    case 'update':
    case 'pause':
    case 'unpause': {
      if (!c) throw new Error('Not initialised yet. Use "init".');
      const admin = loadKey(opt('admin'));
      const p = params(c);
      if (cmd !== 'update') p.paused = cmd === 'pause';
      await checkAmmConfig(p.raydiumAmmConfig);
      await confirmPrompt(p);
      return send(lp.updateConfig({ admin: admin.publicKey, params: p }), admin);
    }
    case 'propose-admin': {
      const admin = loadKey(opt('admin'));
      return send(lp.proposeAdmin({ admin: admin.publicKey, newAdmin: new web3.PublicKey(opt('new-admin')), raydiumAmmConfig: c.raydiumAmmConfig }), admin);
    }
    case 'accept-admin': {
      const nu = loadKey(opt('admin'));
      return send(lp.acceptAdmin({ newAdmin: nu.publicKey }), nu);
    }
    case 'distribute': {
      const payer = loadKey(opt('payer'));
      return send(lp.distributeFees({ devWallet: c.devWallet, buybackWallet: c.buybackWallet }), payer);
    }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
