# Secretum

A fair-launch token launchpad on Solana where every coin is sealed at birth.

- Anyone launches a coin in one transaction. It is a Token-2022 mint with its name, ticker and image stored on the mint itself. The mint, freeze and metadata authorities are all revoked at launch, so nobody can ever mint more, freeze holders or change the metadata.
- The coin trades against SOL on a bonding curve. Selling can never be paused.
- When the curve sells out, anyone can **graduate** the coin. Graduation:
  - moves the coin to a Raydium CPMM pool at the curve's final price,
  - burns the LP tokens, so the liquidity is locked forever,
  - burns any unused tokens.
- Every launch gets a **certificate**: a SHA-256 hash of its mint, creator, name, ticker, image and launch time, computed on-chain. A certification service anchors that hash on **Monero**, **Zcash** and **HyperEVM**. It then records each transaction ID on the coin's Solana record, write-once.
- The website draws each coin a unique wax seal from its certificate hash.

> **Unaudited.** This code has thorough tests but has not had a professional security audit. Get one before mainnet launch with real money.

## Numbers

| | |
|---|---|
| Supply per coin | 1,000,000,000 (6 decimals). 750M (75%) on the curve; 250M (25%) reserved for the Raydium pool |
| Team allocation | None |
| Curve | Constant product over virtual reserves: 42.5 virtual SOL × 1.125B virtual tokens |
| Starting market cap | ≈ 37.8 SOL |
| Graduation | Curve sells out at exactly **85 SOL** raised |
| Trading fee | 1% of every curve buy and sell (admin-adjustable, hard cap 2%) |
| Launch fee | 0.02 SOL (adjustable, cap 1 SOL) |
| Graduation fee | 1 SOL from the raised SOL. Covers Raydium's 0.15 SOL pool fee and rent; the rest goes to the protocol (adjustable 0.3–5 SOL) |
| Pool opening price | Equals the curve's final price, so there's no gap for arbitrage bots at launch. Tokens left over because of the graduation fee are burned |
| Fee split | All protocol fees: **90% to the buyback wallet** (to buy and burn $SECRETUM) and **10% to the dev wallet** |

## What's in this repo

```
programs/launchpad/   Solana program (Rust, Anchor 1.0)
client/secretum.js    Shared JS client: instruction builders, account decoders, curve maths, certificate hashing
app/                  The website (static HTML/CSS/JS, no build step, self-hosted fonts and libraries)
certifier/            Certification service (Node): anchors certificates on Monero, Zcash, HyperEVM
devtools/             admin.js (config), buyback.js (buyback & burn), sandbox.js (local sandbox), program-id.js
tests/                Integration tests (LiteSVM) incl. Raydium's real CPMM program, certifier, buyback, browser E2E
vendor/               Raydium CPMM source (Apache-2.0) and its compiled program, used for graduation and tests
```

## Try it locally (no Solana install, no real funds)

```bash
npm install
npm run sandbox          # → http://localhost:8899
```

The sandbox runs the real Secretum and Raydium programs in an in-memory Solana runtime, with five sample coins and a burner wallet holding 500 SOL. From the website you can launch, buy, sell, fill a curve, graduate it to Raydium and verify certificates.

## Tests

```bash
npm run build            # needs Rust + cargo-build-sbf (Solana platform tools)
npm test
```

There are 20 tests:

- **Program:** launch metadata and revoked authorities, buy and sell quotes, slippage, pause behaviour, admin handover, write-once certificates, capped fill and graduation against **Raydium's real CPMM bytecode**, Raydium swaps after graduation, an attack that pre-creates the pool to block graduation, the fee split, and a 150-trade solvency fuzz.
- **Certifier:** anchoring on all three chains, with retries that never double-send.
- **Buyback:** the curve route and the Raydium route.
- **Browser end-to-end:** a full launch → buy → sell → fill → graduate → verify run in headless Chrome. It is skipped if Chrome isn't installed; set `CHROME_PATH` to point at it.

## Deploy (devnet first)

1. **Install tools:** [Rust](https://rustup.rs), the [Solana CLI](https://docs.anza.xyz/cli/install) (which includes `cargo-build-sbf`) and Node 20+.
2. **Create your program ID.** The ID in this repo has no keypair in it.
   ```bash
   solana-keygen new -o target/deploy/launchpad-keypair.json
   npm run program-id -- $(solana-keygen pubkey target/deploy/launchpad-keypair.json)
   ```
3. **Build.** Devnet and mainnet link to different Raydium program IDs, so build for the network you're deploying to:
   ```bash
   npm run build:devnet     # or: npm run build   (mainnet)
   ```
4. **Deploy:**
   ```bash
   solana program deploy target/deploy/launchpad.so --program-id target/deploy/launchpad-keypair.json -u devnet
   ```
5. **Initialise the config.** You'll be asked to confirm the values first.
   ```bash
   npm run admin -- init --cluster devnet --admin keys/admin.json \
     --certifier <CERTIFIER_PUBKEY> --dev-wallet <DEV_WALLET> --buyback-wallet <BUYBACK_WALLET>
   npm run admin -- show --cluster devnet
   ```
   The fee wallets must already exist on-chain. Send each one a little SOL first.
6. **Certification service:** copy `certifier/.env.example` to `certifier/.env`, fill it in, then run `npm run certifier`. It needs:
   - `monero-wallet-rpc` running against a funded wallet,
   - a zcashd/Zallet node with a funded shielded address,
   - a HyperEVM key with a little HYPE for gas.
7. **Website:** set `cluster`, `rpc`, `programId` and `certifierUrl` in `app/config.js`, then upload the `app/` folder to any static host (Cloudflare Pages, Netlify, Vercel, GitHub Pages). Add the response header `Content-Security-Policy: frame-ancestors 'none'` so the site can't be framed.

### Before mainnet

- [ ] Professional security audit of `programs/launchpad`.
- [ ] Use a paid RPC (Helius, Triton, QuickNode). Public RPCs rate-limit and block `getProgramAccounts`, which the coin list needs.
- [ ] Put the **program upgrade authority** in a multisig (e.g. Squads), or make the program immutable once it's stable. It's the most powerful key in the system.
- [ ] Put the config **admin** in a multisig too: `npm run admin -- propose-admin`, then `accept-admin`.
- [ ] Check the Raydium CPMM fee config address (`--amm-config`). The program rejects any account Raydium's CPMM doesn't own.
- [ ] Publish the certifier's Zcash viewing key, plus its Monero address and view key, on the site so anyone can verify.

## Wallets you'll need

| Wallet | Chain | Used for | Notes |
|---|---|---|---|
| Upgrade authority | Solana | Deploying and upgrading the program | Keep offline or in a multisig |
| Admin | Solana | `admin.js`: fees, wallets, pause | Can't touch curve SOL or block sells |
| Certifier | Solana | Writes certificate tx IDs | Needs a little SOL for fees |
| Dev wallet | Solana | Receives 10% of fees | Must hold some SOL so it exists on-chain |
| Buyback wallet | Solana | Receives 90% of fees; `buyback.js` spends it on $SECRETUM and burns it | Must hold some SOL |
| HyperEVM key | HyperEVM | Certificate anchor | Small HYPE balance |
| Monero wallet | Monero | Certificate anchor via `monero-wallet-rpc` | Small XMR balance for fees |
| Zcash wallet | Zcash | Certificate anchor (shielded memo) | Small ZEC balance |

## What the admin can and can't do

**The admin can:**
- change the trading fee (max 2%), launch fee (max 1 SOL) and graduation fee (0.3–5 SOL),
- change the dev/buyback split, the certifier key, the fee wallets and the virtual SOL for *new* coins,
- pause new launches and buys.

**The admin can't:**
- move any coin's SOL or tokens,
- mint tokens,
- stop anyone selling,
- change an existing certificate entry,
- withdraw graduated liquidity. The LP tokens are burned.

The program's upgrade authority could change the code itself, which is why it should be a multisig or revoked.

## How certificates work, and their limits

`launch_hash = sha256("SECRETUM-CERT-V1" | mint | creator | name | ticker | image | slot | unix_time)`, computed by the program at launch. The coin page's **Verify** button recomputes it in your browser from public on-chain data. Each chain carries `SECRETUM1:<hash>`:

- **HyperEVM:** the full payload in transaction calldata. Fully public.
- **Zcash:** the full payload in a shielded memo, about 15 minutes after launch. Encrypted, so readable by anyone holding the published viewing key.
- **Monero:** Monero's wallet software can't attach arbitrary data. Instead:
  - the transaction goes to an integrated address whose **payment ID is the first 8 bytes of the hash**, and
  - the wallet produces a **tx proof signing the full payload**, which anyone can check with `check_tx_proof`.

  This binds the full hash to that Monero transaction, but only 8 bytes are on Monero's chain itself.

SHA-256 is resistant to known quantum attacks, but the signatures on these chains aren't, so Secretum doesn't claim "post-quantum" security.

## Buyback & burn

```bash
node devtools/buyback.js --cluster mainnet --wallet keys/buyback.json --mint <SECRETUM_MINT> --reserve-sol 0.05
```

The keeper spends the buyback wallet's SOL above the reserve on $SECRETUM, then burns what it bought:
- **while $SECRETUM is on its curve:** it buys on the curve,
- **after it graduates:** it buys through its Raydium pool, with slippage protection.

Run it by hand or on a schedule.

## Licence

MIT for Secretum's own code. `vendor/raydium-cp-swap` is Raydium's, under Apache-2.0. The fonts (IM Fell English, Instrument Sans) are under the SIL Open Font License.
