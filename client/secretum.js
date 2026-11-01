/*
 * Secretum client library — instruction builders, account decoders, curve maths and
 * certificate hashing for the Secretum launchpad program.
 *
 * Works in Node (require('./secretum')) and in the browser (<script> after the
 * @solana/web3.js IIFE bundle; exposes window.Secretum). Only depends on @solana/web3.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('@solana/web3.js'));
  else root.Secretum = factory(root.solanaWeb3);
})(typeof self !== 'undefined' ? self : this, function (web3) {
  'use strict';
  const { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } = web3;
  // web3.js wants Buffer for instruction data; its browser bundle ships a Buffer polyfill.
  const Buf = typeof Buffer !== 'undefined' ? Buffer : (web3.Buffer || null);
  const toBuf = (u8) => (Buf ? Buf.from(u8) : u8);

  // ------------------------------------------------------------------ constants
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
  const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

  const DECIMALS = 6;
  const ONE_TOKEN = 1_000_000n;
  const TOTAL_SUPPLY = 1_000_000_000n * ONE_TOKEN;
  const CURVE_SUPPLY = 750_000_000n * ONE_TOKEN;
  const LP_RESERVE = TOTAL_SUPPLY - CURVE_SUPPLY;
  const INITIAL_VIRTUAL_TOKEN = 1_125_000_000n * ONE_TOKEN;
  const BPS = 10_000n;
  const CERT = { MONERO: 0, ZCASH: 1, HYPEREVM: 2 };
  const CERT_DOMAIN = 'SECRETUM-CERT-V1';
  /** What the certifier writes on Monero / Zcash / HyperEVM: this prefix + hex hash. */
  const CERT_PAYLOAD_PREFIX = 'SECRETUM1:';

  /** Per-cluster addresses. Raydium's CPMM has different ids on devnet vs mainnet. */
  const CLUSTERS = {
    mainnet: {
      raydiumCpmm: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
      raydiumCreatePoolFee: new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'),
    },
    devnet: {
      raydiumCpmm: new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'),
      raydiumCreatePoolFee: new PublicKey('3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy'),
    },
  };

  const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
  const DISC = {
    initialize: hex('afaf6d1f0d989bed'), update_config: hex('1d9efcbf0a53db63'), propose_admin: hex('79d6c7d4572775ea'),
    accept_admin: hex('702a2d5a74b50daa'), create_token: hex('5434cce4188cea4b'), buy: hex('66063d1201daebea'),
    sell: hex('33e685a4017f83ad'), graduate: hex('2debe1b511da4082'), record_certificate: hex('af09cd845377bcdc'),
    distribute_fees: hex('78381b0735b071ba'),
  };
  const ACC_DISC = { Config: hex('9b0caae01efacc82'), Curve: hex('bfb4f942b44733b6') };
  const EVENT_DISC = {
    TokenCreated: 'ec1329ff824e93ac', TradeEvent: 'bddb7fd34ee661ee', CurveCompleted: '01aea47fdb81f30e',
    Graduated: '33f142328cf59cc0', CertificateRecorded: 'afb9b014c09d77b5', FeesDistributed: 'd118aec8ec5a9a37',
  };

  // ------------------------------------------------------------------ borsh helpers
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  class W {
    constructor() { this.parts = []; }
    bytes(b) { this.parts.push(Uint8Array.from(b)); return this; }
    u8(v) { return this.bytes([v & 0xff]); }
    bool(v) { return this.u8(v ? 1 : 0); }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(v), true); return this.bytes(b); }
    u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return this.bytes(b); }
    str(s) { const b = enc.encode(s); const l = new Uint8Array(4); new DataView(l.buffer).setUint32(0, b.length, true); return this.bytes(l).bytes(b); }
    pk(p) { return this.bytes(new PublicKey(p).toBytes()); }
    out() { const n = this.parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of this.parts) { o.set(p, i); i += p.length; } return o; }
  }
  class R {
    constructor(data, off = 0) { this.d = Uint8Array.from(data); this.v = new DataView(this.d.buffer); this.o = off; }
    u8() { return this.d[this.o++]; }
    bool() { return this.u8() !== 0; }
    u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
    u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
    u64() { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
    i64() { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
    bytes(n) { const x = this.d.slice(this.o, this.o + n); this.o += n; return x; }
    pk() { return new PublicKey(this.bytes(32)); }
    str() { return dec.decode(this.bytes(this.u32())); }
  }
  const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

  // ------------------------------------------------------------------ PDAs
  const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const S = (s) => enc.encode(s);
  function ata(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
    return pda([new PublicKey(owner).toBytes(), tokenProgram.toBytes(), new PublicKey(mint).toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID);
  }

  function makeClient(programId, cluster = 'mainnet') {
    const PROGRAM_ID = new PublicKey(programId);
    const C = CLUSTERS[cluster];
    if (!C) throw new Error('unknown cluster ' + cluster);
    const RAY = C.raydiumCpmm;

    const configPda = () => pda([S('config')], PROGRAM_ID);
    const programDataPda = () => pda([PROGRAM_ID.toBytes()], BPF_UPGRADEABLE_LOADER);
    const curvePda = (mint) => pda([S('curve'), new PublicKey(mint).toBytes()], PROGRAM_ID);
    const poolCreatorPda = (mint) => pda([S('pool_creator'), new PublicKey(mint).toBytes()], PROGRAM_ID);
    const poolStatePda = (mint) => pda([S('pool'), new PublicKey(mint).toBytes()], PROGRAM_ID);
    /** The coin's SOL vault (also creates the Raydium pool at graduation). */
    const solVault = (mint) => poolCreatorPda(mint);
    const curveVault = (mint) => ata(curvePda(mint), mint, TOKEN_2022_PROGRAM_ID);
    const userAta = (user, mint) => ata(user, mint, TOKEN_2022_PROGRAM_ID);

    const raydium = (mint) => {
      const pool = poolStatePda(mint);
      const m = new PublicKey(mint);
      const tokenIs0 = compareKeys(m, WSOL_MINT) < 0;
      const [t0, t1] = tokenIs0 ? [m, WSOL_MINT] : [WSOL_MINT, m];
      const lpMint = pda([S('pool_lp_mint'), pool.toBytes()], RAY);
      return {
        program: RAY,
        authority: pda([S('vault_and_lp_mint_auth_seed')], RAY),
        poolState: pool,
        lpMint,
        token0Mint: t0,
        token1Mint: t1,
        tokenIs0,
        token0Vault: pda([S('pool_vault'), pool.toBytes(), t0.toBytes()], RAY),
        token1Vault: pda([S('pool_vault'), pool.toBytes(), t1.toBytes()], RAY),
        observation: pda([S('observation'), pool.toBytes()], RAY),
        creatorLpToken: ata(poolCreatorPda(mint), lpMint, TOKEN_PROGRAM_ID),
        createPoolFee: C.raydiumCreatePoolFee,
      };
    };

    const meta = (pubkey, isSigner, isWritable) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable });
    const ix = (keys, data) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data: toBuf(data) });

    function encodeParams(w, p) {
      return w.pk(p.certifier).pk(p.buybackWallet).pk(p.devWallet).pk(p.raydiumAmmConfig)
        .u16(p.devShareBps).u16(p.tradeFeeBps).u64(p.creationFee).u64(p.graduationFee).u64(p.initialVirtualSol).bool(!!p.paused);
    }

    const tradeKeys = (user, mint) => [
      meta(user, true, true), meta(configPda(), false, true), meta(curvePda(mint), false, true), meta(mint, false, false),
      meta(curveVault(mint), false, true), meta(userAta(user, mint), false, true), meta(poolCreatorPda(mint), false, true),
      meta(TOKEN_2022_PROGRAM_ID, false, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false),
    ];

    /** Raydium CPMM fee config PDA: seeds ["amm_config", index as u16 big-endian]. Index 0 = 0.25% fee. */
    const raydiumAmmConfig = (index = 0) => pda([S('amm_config'), Uint8Array.from([(index >> 8) & 0xff, index & 0xff])], RAY);

    return {
      PROGRAM_ID, cluster, RAYDIUM_CPMM: RAY, raydiumAmmConfig,
      configPda, programDataPda, curvePda, poolCreatorPda, solVault, poolStatePda, curveVault, userAta, raydium,

      /** authority = the program's upgrade authority (deployer); admin = the wallet that will manage the config. */
      initialize: ({ authority, admin, params }) => ix(
        [meta(authority, true, true), meta(configPda(), false, true), meta(programDataPda(), false, false),
          meta(params.raydiumAmmConfig, false, false), meta(SystemProgram.programId, false, false)],
        encodeParams(new W().bytes(DISC.initialize).pk(admin), params).out()),

      updateConfig: ({ admin, params }) => ix(
        [meta(admin, true, false), meta(configPda(), false, true), meta(params.raydiumAmmConfig, false, false)],
        encodeParams(new W().bytes(DISC.update_config), params).out()),

      proposeAdmin: ({ admin, newAdmin, raydiumAmmConfig }) => ix(
        [meta(admin, true, false), meta(configPda(), false, true), meta(raydiumAmmConfig, false, false)],
        new W().bytes(DISC.propose_admin).pk(newAdmin).out()),

      acceptAdmin: ({ newAdmin }) => ix([meta(newAdmin, true, false), meta(configPda(), false, true)], new W().bytes(DISC.accept_admin).out()),

      createToken: ({ creator, mint, name, symbol, uri = '', devBuyLamports = 0n, minTokensOut = 0n }) => ix(
        [
          meta(creator, true, true), meta(configPda(), false, true), meta(mint, true, true), meta(curvePda(mint), false, true),
          meta(curveVault(mint), false, true), meta(userAta(creator, mint), false, true), meta(poolCreatorPda(mint), false, true),
          meta(TOKEN_2022_PROGRAM_ID, false, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false),
        ],
        new W().bytes(DISC.create_token).str(name).str(symbol).str(uri).u64(devBuyLamports).u64(minTokensOut).out()),

      buy: ({ user, mint, maxSol, minTokensOut = 0n }) => ix(tradeKeys(user, mint), new W().bytes(DISC.buy).u64(maxSol).u64(minTokensOut).out()),
      sell: ({ user, mint, tokenAmount, minSolOut = 0n }) => ix(tradeKeys(user, mint), new W().bytes(DISC.sell).u64(tokenAmount).u64(minSolOut).out()),

      graduate: ({ payer, mint, ammConfig }) => {
        const r = raydium(mint);
        const pc = poolCreatorPda(mint);
        return ix([
          meta(payer, true, true), meta(configPda(), false, true), meta(curvePda(mint), false, true), meta(mint, false, true),
          meta(curveVault(mint), false, true), meta(pc, false, true),
          meta(ata(pc, mint, TOKEN_2022_PROGRAM_ID), false, true), meta(ata(pc, WSOL_MINT, TOKEN_PROGRAM_ID), false, true),
          meta(WSOL_MINT, false, false), meta(RAY, false, false), meta(ammConfig, false, false), meta(r.authority, false, false),
          meta(r.poolState, false, true), meta(r.lpMint, false, true), meta(r.creatorLpToken, false, true),
          meta(r.token0Vault, false, true), meta(r.token1Vault, false, true), meta(r.createPoolFee, false, true), meta(r.observation, false, true),
          meta(TOKEN_PROGRAM_ID, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
          meta(SystemProgram.programId, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
        ], DISC.graduate);
      },

      recordCertificate: ({ certifier, mint, chain, txid }) => ix(
        [meta(certifier, true, false), meta(configPda(), false, false), meta(curvePda(mint), false, true)],
        new W().bytes(DISC.record_certificate).u8(chain).bytes(normTxid(txid)).out()),

      distributeFees: ({ devWallet, buybackWallet }) => ix(
        [meta(configPda(), false, true), meta(devWallet, false, true), meta(buybackWallet, false, true)], DISC.distribute_fees),

      /** Raydium CPMM swap for a graduated coin. inputIsSol: buy the coin with WSOL; else sell it. */
      raydiumSwap: ({ payer, mint, ammConfig, inputIsSol, amountIn, minOut = 0n }) => {
        const r = raydium(mint);
        const wsolAcc = ata(payer, WSOL_MINT, TOKEN_PROGRAM_ID);
        const tokAcc = ata(payer, mint, TOKEN_2022_PROGRAM_ID);
        const solVaultR = r.tokenIs0 ? r.token1Vault : r.token0Vault;
        const tokVaultR = r.tokenIs0 ? r.token0Vault : r.token1Vault;
        const [inAcc, outAcc, inVault, outVault, inProg, outProg, inMint, outMint] = inputIsSol
          ? [wsolAcc, tokAcc, solVaultR, tokVaultR, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, mint]
          : [tokAcc, wsolAcc, tokVaultR, solVaultR, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, mint, WSOL_MINT];
        return new TransactionInstruction({
          programId: RAY,
          data: toBuf(new W().bytes(hex('8fbe5adac41e33de')).u64(amountIn).u64(minOut).out()),
          keys: [meta(payer, true, true), meta(r.authority, false, false), meta(ammConfig, false, false), meta(r.poolState, false, true),
            meta(inAcc, false, true), meta(outAcc, false, true), meta(inVault, false, true), meta(outVault, false, true),
            meta(inProg, false, false), meta(outProg, false, false), meta(inMint, false, false), meta(outMint, false, false), meta(r.observation, false, true)],
        });
      },

      /** Graduation needs more compute than the 200k default. */
      graduateComputeIx: () => ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    };
  }

  function compareKeys(a, b) {
    const x = a.toBytes(), y = b.toBytes();
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }

  /** Accepts 32 raw bytes, or a 64-char hex string (with or without 0x). */
  function normTxid(txid) {
    if (typeof txid === 'string') {
      const h = txid.replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('txid must be 32 bytes / 64 hex chars');
      return hex(h);
    }
    if (txid.length !== 32) throw new Error('txid must be 32 bytes');
    return Uint8Array.from(txid);
  }

  // ------------------------------------------------------------------ decoders
  function decodeConfig(data) {
    if (!eqBytes(Uint8Array.from(data).subarray(0, 8), ACC_DISC.Config)) throw new Error('not a Config account');
    const r = new R(data, 8);
    return {
      admin: r.pk(), pendingAdmin: r.pk(), certifier: r.pk(), buybackWallet: r.pk(), devWallet: r.pk(), raydiumAmmConfig: r.pk(),
      devShareBps: r.u16(), tradeFeeBps: r.u16(), creationFee: r.u64(), graduationFee: r.u64(), initialVirtualSol: r.u64(),
      feesAccrued: r.u64(), tokenCount: r.u64(), paused: r.bool(), bump: r.u8(),
    };
  }

  function decodeCurve(data) {
    if (!eqBytes(Uint8Array.from(data).subarray(0, 8), ACC_DISC.Curve)) throw new Error('not a Curve account');
    const r = new R(data, 8);
    const c = {
      mint: r.pk(), creator: r.pk(), virtualSol: r.u64(), virtualToken: r.u64(), initialVirtualSol: r.u64(), realSol: r.u64(),
      tokensSold: r.u64(), complete: r.bool(), graduated: r.bool(), pool: r.pk(), createdAt: r.i64(), createdSlot: r.u64(),
      index: r.u64(), launchHash: r.bytes(32), certFlags: r.u8(),
      certMonero: r.bytes(32), certMoneroAt: r.i64(), certZcash: r.bytes(32), certZcashAt: r.i64(),
      certHyperevm: r.bytes(32), certHyperevmAt: r.i64(), bump: r.u8(), vaultBump: r.u8(),
    };
    c.price = priceLamportsPerToken(c.virtualSol, c.virtualToken);
    c.progressBps = Number((c.tokensSold * BPS) / CURVE_SUPPLY);
    c.certs = {
      monero: c.certFlags & 1 ? toHex(c.certMonero) : null,
      zcash: c.certFlags & 2 ? toHex(c.certZcash) : null,
      hyperevm: c.certFlags & 4 ? '0x' + toHex(c.certHyperevm) : null,
    };
    return c;
  }

  /** Reads name/symbol/uri from a Token-2022 mint's metadata extension. */
  function decodeMintMetadata(data) {
    const d = Uint8Array.from(data);
    if (d.length <= 166 || d[165] !== 1) return null; // 1 = AccountType::Mint
    const v = new DataView(d.buffer);
    let o = 166;
    while (o + 4 <= d.length) {
      const type = v.getUint16(o, true), len = v.getUint16(o + 2, true);
      if (type === 19) { // ExtensionType::TokenMetadata
        const r = new R(d.subarray(o + 4, o + 4 + len));
        const updateAuthority = r.pk(), mint = r.pk();
        return { updateAuthority, mint, name: r.str(), symbol: r.str(), uri: r.str() };
      }
      if (type === 0) break;
      o += 4 + len;
    }
    return null;
  }

  /** Decodes Anchor `emit!` events from transaction log lines. */
  function parseEvents(logs) {
    const out = [];
    for (const line of logs || []) {
      if (!line.startsWith('Program data: ')) continue;
      let bytes;
      try { bytes = Uint8Array.from(atob(line.slice(14)), (c) => c.charCodeAt(0)); } catch { continue; }
      const d = toHex(bytes.subarray(0, 8));
      const r = new R(bytes, 8);
      if (d === EVENT_DISC.TokenCreated) out.push({ name: 'TokenCreated', mint: r.pk(), creator: r.pk(), tokenName: r.str(), symbol: r.str(), uri: r.str(), launchHash: toHex(r.bytes(32)), slot: r.u64(), timestamp: r.i64() });
      else if (d === EVENT_DISC.TradeEvent) out.push({ name: 'TradeEvent', mint: r.pk(), trader: r.pk(), isBuy: r.bool(), solAmount: r.u64(), tokenAmount: r.u64(), fee: r.u64(), virtualSol: r.u64(), virtualToken: r.u64(), realSol: r.u64(), tokensSold: r.u64(), timestamp: r.i64() });
      else if (d === EVENT_DISC.CurveCompleted) out.push({ name: 'CurveCompleted', mint: r.pk(), realSol: r.u64() });
      else if (d === EVENT_DISC.Graduated) out.push({ name: 'Graduated', mint: r.pk(), pool: r.pk(), solLiquidity: r.u64(), tokenLiquidity: r.u64(), tokensBurned: r.u64(), protocolFee: r.u64() });
      else if (d === EVENT_DISC.CertificateRecorded) out.push({ name: 'CertificateRecorded', mint: r.pk(), chain: r.u8(), txid: toHex(r.bytes(32)), launchHash: toHex(r.bytes(32)) });
      else if (d === EVENT_DISC.FeesDistributed) out.push({ name: 'FeesDistributed', dev: r.u64(), buyback: r.u64() });
    }
    return out;
  }

  // ------------------------------------------------------------------ curve maths (mirrors programs/launchpad/src/math.rs)
  const divUp = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n);

  function quoteBuy(c, maxSol, feeBps) {
    maxSol = BigInt(maxSol); feeBps = BigInt(feeBps);
    if (maxSol === 0n) return { tokensOut: 0n, solIn: 0n, fee: 0n, total: 0n };
    const vs = c.virtualSol, vt = c.virtualToken, k = vs * vt;
    let fee = (maxSol * feeBps) / BPS;
    let solIn = maxSol - fee;
    let newVs = vs + solIn;
    let newVt = divUp(k, newVs);
    let tokensOut = vt - newVt;
    const remaining = CURVE_SUPPLY - c.tokensSold;
    let capped = false;
    if (tokensOut >= remaining) {
      capped = true;
      tokensOut = remaining;
      newVt = vt - remaining;
      newVs = divUp(k, newVt);
      solIn = newVs - vs;
      fee = feeBps === 0n ? 0n : divUp(solIn * feeBps, BPS - feeBps);
      if (solIn + fee > maxSol) fee = maxSol - solIn;
    }
    return { tokensOut, solIn, fee, total: solIn + fee, capped, newVirtualSol: newVs, newVirtualToken: newVt };
  }

  function quoteSell(c, tokenAmount, feeBps) {
    tokenAmount = BigInt(tokenAmount); feeBps = BigInt(feeBps);
    if (tokenAmount === 0n) return { solOut: 0n, fee: 0n, gross: 0n };
    const vs = c.virtualSol, vt = c.virtualToken;
    const newVt = vt + tokenAmount;
    let newVs = divUp(vs * vt, newVt);
    let gross = vs - newVs;
    if (gross > c.realSol) { gross = c.realSol; newVs = vs - gross; }
    const fee = (gross * feeBps) / BPS;
    return { solOut: gross - fee, fee, gross, newVirtualSol: newVs, newVirtualToken: newVt };
  }

  /** Lamports per whole token, as a JS number (can be fractional). */
  function priceLamportsPerToken(virtualSol, virtualToken) {
    return Number(virtualSol) / (Number(virtualToken) / Number(ONE_TOKEN));
  }
  /** Market cap in lamports (price × 1B tokens). */
  const marketCapLamports = (c) => priceLamportsPerToken(c.virtualSol, c.virtualToken) * 1e9;

  // ------------------------------------------------------------------ certificates
  /** Exact byte string the program hashes. Pass the result to any sha256 implementation. */
  function certificatePreimage({ mint, creator, name, symbol, uri, slot, timestamp }) {
    const w = new W().bytes(enc.encode(CERT_DOMAIN)).pk(mint).pk(creator);
    const n = enc.encode(name), s = enc.encode(symbol), u = enc.encode(uri);
    w.u8(n.length).bytes(n).u8(s.length).bytes(s).u16(u.length).bytes(u).u64(slot);
    const ts = new Uint8Array(8); new DataView(ts.buffer).setBigInt64(0, BigInt(timestamp), true);
    return w.bytes(ts).out();
  }
  /** Browser/Node async sha256 via WebCrypto. */
  async function certificateHash(fields) {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || require('crypto').webcrypto.subtle;
    return toHex(new Uint8Array(await subtle.digest('SHA-256', certificatePreimage(fields))));
  }
  const certificatePayload = (hashHex) => CERT_PAYLOAD_PREFIX + hashHex;

  return {
    makeClient, decodeConfig, decodeCurve, decodeMintMetadata, parseEvents, quoteBuy, quoteSell,
    priceLamportsPerToken, marketCapLamports, certificatePreimage, certificateHash, certificatePayload,
    ata, compareKeys, toHex, normTxid,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, WSOL_MINT, CLUSTERS,
    DECIMALS, ONE_TOKEN, TOTAL_SUPPLY, CURVE_SUPPLY, LP_RESERVE, INITIAL_VIRTUAL_TOKEN, CERT, CERT_PAYLOAD_PREFIX,
    ACC_DISC,
  };
});
