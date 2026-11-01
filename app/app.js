/* Secretum web app. Plain JS, no build step. Talks to Solana through the shared client library. */
(() => {
  'use strict';
  const web3 = window.solanaWeb3;
  const S = window.Secretum;
  const { sealSVG } = window.SecretumSeal;
  const CFG = window.SECRETUM_CONFIG;
  const { PublicKey, Transaction, Keypair, LAMPORTS_PER_SOL } = web3;

  const conn = new web3.Connection(CFG.rpc, 'confirmed');
  const lp = S.makeClient(CFG.programId, CFG.cluster);
  const ERRORS = [
    'Not authorized.', 'Launches and buys are paused right now. Selling still works.', 'Check the name (1–32 characters), ticker (1–10) and image link (up to 200).',
    'Enter an amount above zero.', 'The price moved past your slippage limit. Try again or raise the limit.', 'This coin’s curve is full. It can now be graduated to Raydium.',
    'This coin’s curve isn’t full yet.', 'This coin has already graduated. Trade it on Raydium.', 'Not enough SOL raised to graduate.', 'Invalid certificate.', 'Certificate already recorded.', 'Invalid configuration.',
  ];

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with generated SVG
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const short = (a) => { const s = String(a); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
  function fmt(x, digits = 2) {
    if (!isFinite(x)) return '–';
    const a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (x / 1e3).toFixed(1) + 'K';
    if (a >= 1) return x.toLocaleString('en-GB', { maximumFractionDigits: digits });
    if (a === 0) return '0';
    return String(Number(x.toPrecision(3)));
  }
  const solOf = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;
  const sol = (l) => fmt(solOf(l), 3) + ' SOL';
  const tokens = (raw) => fmt(Number(raw) / 1e6);
  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  function toast(msg, isErr, link) {
    const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg, link ? h('div', {}, h('a', { href: link, target: '_blank', rel: 'noopener' }, 'View transaction')) : null);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), isErr ? 9000 : 6000);
  }
  function errMessage(e) {
    const msg = String(e?.message || e);
    if (/reject|denied|cancel/i.test(msg)) return 'You declined the request in your wallet.';
    const m = msg.match(/custom program error: 0x([0-9a-f]+)/i) || JSON.stringify(e?.logs || '').match(/Error Number: (\d+)/);
    if (m) {
      const n = m[0].includes('0x') ? parseInt(m[1], 16) : Number(m[1]);
      if (n >= 6000 && ERRORS[n - 6000]) return ERRORS[n - 6000];
    }
    if (/insufficient (funds|lamports)/i.test(msg)) return 'Not enough SOL for this transaction and its fees.';
    const anchorMsg = msg.match(/Error Message: ([^.\n]+)/);
    if (anchorMsg) return anchorMsg[1] + '.';
    return msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
  }
  /** Images: https and ipfs only. A link to a .json metadata file is followed to its image. */
  const imgCache = new Map();
  async function imageFor(uri) {
    if (!uri) return null;
    if (imgCache.has(uri)) return imgCache.get(uri);
    let url = uri.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + uri.slice(7) : uri;
    let out = null;
    try {
      if (new URL(url).protocol === 'https:') {
        out = url;
        if (/\.json($|\?)/i.test(url)) {
          const j = await (await fetch(url)).json();
          const img = String(j.image || '');
          out = img.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + img.slice(7) : (img.startsWith('https://') ? img : null);
        }
      }
    } catch { out = null; }
    imgCache.set(uri, out);
    return out;
  }
  function coinImage(coin, size) {
    const img = h('img', { alt: '', width: size, height: size, loading: 'lazy', referrerpolicy: 'no-referrer' });
    const fallback = () => { const d = h('span', { html: sealSVG(coin.launchHash, coin.certFlags, { size, label: coin.symbol, title: coin.name }) }); img.replaceWith(d.firstChild); };
    img.onerror = fallback;
    imageFor(coin.uri).then((src) => (src ? (img.src = src) : fallback()));
    return img;
  }
  const seal = (coin, size, extra = {}) => h('span', { html: sealSVG(coin.launchHash, coin.certFlags, { size, label: coin.symbol, graduated: coin.graduated, title: `${coin.name} seal`, ...extra }) }).firstChild;

  // ------------------------------------------------------------------ chain data
  let configCache = null;
  async function getConfig() {
    if (!configCache) {
      const a = await conn.getAccountInfo(lp.configPda());
      if (!a) throw new Error('Launchpad not initialised on this network yet.');
      configCache = S.decodeConfig(a.data);
    }
    return configCache;
  }
  async function attachMetadata(curves) {
    const out = [];
    for (let i = 0; i < curves.length; i += 100) {
      const chunk = curves.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(chunk.map((c) => c.mint));
      chunk.forEach((c, j) => {
        const m = infos[j] && S.decodeMintMetadata(infos[j].data);
        out.push({ ...c, name: m?.name || 'Unnamed', symbol: m?.symbol || '???', uri: m?.uri || '' });
      });
    }
    return out;
  }
  async function loadCoins() {
    const filters = [{ memcmp: { offset: 0, bytes: encodeB58(S.ACC_DISC.Curve) } }];
    const accts = await conn.getProgramAccounts(lp.PROGRAM_ID, { filters });
    const curves = accts.map((a) => S.decodeCurve(a.account.data)).sort((a, b) => Number(b.createdAt - a.createdAt));
    return attachMetadata(curves);
  }
  async function loadCoin(mint) {
    const [c, m] = await conn.getMultipleAccountsInfo([lp.curvePda(mint), new PublicKey(mint)]);
    if (!c) return null;
    const curve = S.decodeCurve(c.data);
    const meta = m && S.decodeMintMetadata(m.data);
    return { ...curve, name: meta?.name || 'Unnamed', symbol: meta?.symbol || '???', uri: meta?.uri || '' };
  }
  async function loadTrades(mint) {
    const sigs = await conn.getSignaturesForAddress(lp.curvePda(mint), { limit: 40 });
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    if (!ok.length) return [];
    const txs = await conn.getTransactions(ok, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    const out = [];
    txs.forEach((tx, i) => {
      for (const e of S.parseEvents(tx?.meta?.logMessages)) if (e.name === 'TradeEvent' && e.mint.equals(new PublicKey(mint))) out.push({ ...e, sig: ok[i] });
    });
    return out.sort((a, b) => Number(b.timestamp - a.timestamp));
  }
  // base58 encode (for memcmp filters) without extra dependencies
  function encodeB58(bytes) {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
  }

  // ------------------------------------------------------------------ wallet
  let wallet = null; // { provider, publicKey, name }
  function detectProviders() {
    const list = [];
    if (window.secretumSandboxWallet) list.push({ name: 'Sandbox wallet', p: window.secretumSandboxWallet });
    if (window.phantom?.solana?.isPhantom) list.push({ name: 'Phantom', p: window.phantom.solana });
    if (window.solflare?.isSolflare) list.push({ name: 'Solflare', p: window.solflare });
    if (window.backpack?.solana) list.push({ name: 'Backpack', p: window.backpack.solana });
    if (!list.length && window.solana) list.push({ name: 'Wallet', p: window.solana });
    return list;
  }
  async function connect() {
    const list = detectProviders();
    if (!list.length) { toast('No Solana wallet found. Install Phantom, Solflare or Backpack, then reload.', true); return null; }
    const { name, p } = list[0];
    const r = await p.connect();
    const pk = new PublicKey((r?.publicKey || p.publicKey).toString());
    wallet = { provider: p, publicKey: pk, name };
    p.on?.('accountChanged', (k) => { if (k) wallet.publicKey = new PublicKey(k.toString()); else wallet = null; renderHeader(); route(); });
    renderHeader();
    return wallet;
  }
  async function sendTx(label, ixs, extraSigners = []) {
    if (!wallet) await connect();
    if (!wallet) throw new Error('Connect a wallet first.');
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    if (extraSigners.length) tx.partialSign(...extraSigners);
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) { const e = new Error(JSON.stringify(sim.value.err)); e.logs = sim.value.logs; e.message = (sim.value.logs || []).join('\n') || e.message; throw e; }
    const signed = await wallet.provider.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize());
    toast(`${label} sent. Waiting for confirmation…`, false, CFG.explorers.solanaTx(sig, CFG.cluster));
    await confirm(sig, lastValidBlockHeight);
    toast(`${label} confirmed.`, false, CFG.explorers.solanaTx(sig, CFG.cluster));
    return sig;
  }

  // Poll for confirmation (works on RPCs without websocket support).
  async function confirm(sig, lastValidBlockHeight) {
    for (;;) {
      const { value: [st] } = await conn.getSignatureStatuses([sig]);
      if (st?.err) throw new Error('Transaction failed: ' + JSON.stringify(st.err));
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
      if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error('Transaction expired before it was confirmed. Please try again.');
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  // ------------------------------------------------------------------ header
  function renderHeader() {
    $('#net').textContent = CFG.networkName || (CFG.cluster === 'devnet' ? 'Devnet' : 'Solana');
    const b = $('#connect');
    b.textContent = wallet ? short(wallet.publicKey.toBase58()) : 'Connect wallet';
    b.className = wallet ? 'btn line' : 'btn';
    b.onclick = wallet ? () => window.open(CFG.explorers.solanaAccount(wallet.publicKey.toBase58(), CFG.cluster), '_blank', 'noopener') : () => connect().catch((e) => toast(errMessage(e), true));
  }
  $('#mark').innerHTML = sealSVG('5ec7e7a0'.repeat(8), 7, { size: 30, title: 'Secretum' });

  // ------------------------------------------------------------------ routing
  let timer = null;
  function route() {
    clearInterval(timer);
    const hash = location.hash || '#/';
    document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
    const coin = hash.match(/^#\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (coin) return renderCoin(coin[1]);
    if (hash === '#/admin') return renderAdmin();
    renderHome(hash);
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ home
  let homeTab = 'new';
  async function renderHome(hash) {
    const app = $('#app');
    const heroSeal = h('div', { class: 'hero-seal' });
    const list = h('ul', { class: 'registry', 'aria-live': 'polite' }, h('li', { class: 'empty' }, 'Reading the registry…'));
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search name, ticker or address', 'aria-label': 'Search coins' });
    const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Sort coins' },
      ...[['new', 'Newest'], ['full', 'Nearly full'], ['grad', 'Graduated']].map(([k, t]) =>
        h('button', { type: 'button', 'data-tab': k, 'aria-pressed': String(homeTab === k), onclick: () => { homeTab = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === k))); draw(); } }, t)));

    let cfg = null;
    try { cfg = await getConfig(); } catch {}
    const grad = cfg ? solOf(cfg.initialVirtualSol * 2n) : 85;
    const fee = cfg ? cfg.tradeFeeBps / 100 : 1;
    const launchFee = cfg ? solOf(cfg.creationFee) : 0.02;

    app.replaceChildren(
      h('div', { class: 'wrap' },
        h('section', { class: 'hero' },
          h('div', {},
            h('h1', {}, 'Every coin is sealed at birth.'),
            h('p', {}, `Launch a coin on Solana in one transaction. Its origin is certified on Monero, Zcash and HyperEVM, and at ${fmt(grad)} SOL it moves to Raydium with liquidity locked for good.`),
            h('button', { class: 'btn wax big', type: 'button', onclick: openLaunch }, 'Launch a coin')),
          heroSeal)),
      h('section', { class: 'block', id: 'coins' },
        h('div', { class: 'wrap' },
          h('div', { class: 'reg-head' }, h('h2', {}, 'The registry'), h('div', { class: 'reg-head' }, tabs, search)),
          list)),
      h('section', { class: 'block', id: 'how' },
        h('div', { class: 'wrap' },
          h('h2', {}, 'How a launch works'),
          h('p', { class: 'lede' }, 'No presale, no team allocation, no admin keys on any coin.'),
          h('ol', { class: 'steps' },
            h('li', {}, h('h3', {}, 'Launch'), h('p', {}, 'Pick a name, ticker and image. One billion tokens are minted, and the mint, freeze and metadata authorities are removed in the same transaction. Nobody can ever mint more.')),
            h('li', {}, h('h3', {}, 'Trade on the curve'), h('p', {}, `750 million tokens are sold on a bonding curve: the price rises with every buy and falls with every sell. Selling is never paused.`)),
            h('li', {}, h('h3', {}, 'Graduate'), h('p', {}, `When the curve sells out at about ${fmt(grad)} SOL, anyone can move the coin to a Raydium pool. The SOL raised and up to 250 million tokens go in at the curve’s final price, and the pool’s LP tokens are burned.`))))),
      h('section', { class: 'block' },
        h('div', { class: 'wrap seal-explain' },
          h('div', { html: sealSVG('a3f1c09e5b7d2846'.repeat(4), 7, { size: 220, label: 'S', graduated: true, title: 'Example seal, fully certified' }) }),
          h('div', {},
            h('h2', {}, 'The seal'),
            h('p', { class: 'lede' }, 'At launch, the program hashes the coin’s mint, creator, name, ticker, image and launch time. That hash is the coin’s certificate, and its seal is drawn from it, so no two seals match.'),
            h('ul', {},
              h('li', {}, h('b', {}, 'HyperEVM'), ' carries the full hash in a public transaction, moments after launch.'),
              h('li', {}, h('b', {}, 'Monero'), ' carries the first 8 bytes in a payment ID, plus a wallet signature over the full hash.'),
              h('li', {}, h('b', {}, 'Zcash'), ' carries the full hash in a shielded memo about 15 minutes later.'),
              h('li', {}, 'Each transaction ID is written to the coin’s record on Solana and can never be changed. Anyone can recompute the hash from public data on the coin page.'))))),
      h('section', { class: 'block', id: 'fees' },
        h('div', { class: 'wrap' },
          h('h2', {}, 'Fees and supply'),
          h('p', { class: 'lede' }, 'Of all protocol fees, 90% goes to buying back and burning $SECRETUM and 10% funds development.'),
          h('dl', { class: 'terms' },
            h('dt', {}, 'Supply per coin'), h('dd', {}, '1,000,000,000: 750M on the curve, 250M reserved for the Raydium pool'),
            h('dt', {}, 'Launch fee'), h('dd', {}, `${fmt(launchFee, 3)} SOL`),
            h('dt', {}, 'Trading fee on the curve'), h('dd', {}, `${fmt(fee, 2)}% of each buy and sell`),
            h('dt', {}, 'Graduation'), h('dd', {}, `At about ${fmt(grad)} SOL raised. ${cfg ? fmt(solOf(cfg.graduationFee), 2) : '1'} SOL covers Raydium’s pool fee and rent; the rest of that goes to the protocol`),
            h('dt', {}, 'Team allocation'), h('dd', {}, 'None'),
            h('dt', {}, 'Liquidity'), h('dd', {}, 'LP tokens are burned at graduation, so the pool can’t be withdrawn')))),
    );
    if (!cfg) app.prepend(h('div', { class: 'wrap' }, h('div', { class: 'banner' }, `Secretum isn’t live on ${CFG.cluster} yet. Coins will appear here once the launchpad is initialised.`)));

    if (hash === '#/how' || hash === '#/fees') {
      $(`[data-nav="${hash.slice(2)}"]`)?.setAttribute('aria-current', 'page');
      requestAnimationFrame(() => document.getElementById(hash.slice(2))?.scrollIntoView());
    }

    let coins = [];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      let rows = coins.filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q) || c.mint.toBase58().toLowerCase() === q);
      if (homeTab === 'full') rows = rows.filter((c) => !c.graduated).sort((a, b) => b.progressBps - a.progressBps);
      if (homeTab === 'grad') rows = rows.filter((c) => c.graduated);
      list.replaceChildren(...(rows.length ? rows.slice(0, 100).map(row) : [h('li', { class: 'empty' }, coins.length ? 'No coins match.' : 'No coins yet. Launch the first one.')]));
    };
    search.addEventListener('input', draw);

    const showHero = (c) => {
      heroSeal.replaceChildren(
        h('a', { href: c ? `#/coin/${c.mint.toBase58()}` : '#/', 'aria-label': c ? `Newest coin: ${c.name}` : 'Secretum seal' },
          h('span', { class: 'press', html: sealSVG(c ? c.launchHash : '5ec7e7a0'.repeat(8), c ? c.certFlags : 0, { size: 340, label: c ? c.symbol : 'S', title: c ? `${c.name} seal` : 'Seal' }) })),
        h('div', { class: 'cap' }, c ? c.name : 'Your coin here', h('small', {}, c ? `Newest launch, ${ago(c.createdAt)}` : 'The newest launch appears here')));
    };
    const load = async () => {
      try { coins = await loadCoins(); draw(); if (!heroSeal.firstChild) showHero(coins[0]); }
      catch (e) { if (!coins.length) list.replaceChildren(h('li', { class: 'empty' }, 'Couldn’t read the registry: ' + errMessage(e))); }
    };
    if (!cfg) showHero(null);
    await load();
    if (!heroSeal.firstChild) showHero(coins[0]);
    timer = setInterval(load, 20000);
  }

  function row(c) {
    const pct = c.graduated ? 100 : c.progressBps / 100;
    const bar = h('div', { class: 'bar' + (c.graduated ? ' done' : '') }, h('i'));
    bar.firstChild.style.width = pct + '%';
    const certs = h('div', { class: 'certs', title: 'Monero, Zcash, HyperEVM' },
      ...[1, 2, 4].map((b, i) => h('span', { class: c.certFlags & b ? 'on' : '', 'aria-label': `${['Monero', 'Zcash', 'HyperEVM'][i]} ${c.certFlags & b ? 'certified' : 'pending'}` })));
    return h('li', {}, h('a', { class: 'row', href: `#/coin/${c.mint.toBase58()}` },
      seal(c, 52),
      h('div', {}, h('div', { class: 'name' }, c.name), h('div', { class: 'sym' }, `$${c.symbol}, launched ${ago(c.createdAt)}`)),
      h('div', { class: 'num' }, fmt(S.marketCapLamports(c) / 1e9) + ' SOL', h('small', {}, 'market cap')),
      h('div', { class: 'col-progress' }, bar, h('div', { class: 'bar-label' }, c.graduated ? 'Graduated to Raydium' : c.complete ? 'Ready to graduate' : `${pct.toFixed(1)}% of curve sold`)),
      certs));
  }

  // ------------------------------------------------------------------ launch
  async function openLaunch() {
    const dlg = $('#launch');
    $('#launch-form').reset();
    try { const cfg = await getConfig(); $('#launch-note').textContent = `Launch fee ${fmt(solOf(cfg.creationFee), 3)} SOL, plus about 0.01 SOL of account rent and any launch buy.`; } catch { $('#launch-note').textContent = ''; }
    dlg.showModal();
  }
  $('#launch-cancel').onclick = () => $('#launch').close();
  $('#launch-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const btn = $('#launch-submit');
    btn.disabled = true; btn.textContent = 'Launching…';
    try {
      if (!wallet) await connect();
      const devBuy = String(f.get('devBuy') || '').trim();
      const mint = Keypair.generate();
      const ix = lp.createToken({
        creator: wallet.publicKey, mint: mint.publicKey,
        name: String(f.get('name')).trim(), symbol: String(f.get('symbol')).trim().toUpperCase(), uri: String(f.get('uri') || '').trim(),
        devBuyLamports: devBuy ? BigInt(Math.round(parseFloat(devBuy) * LAMPORTS_PER_SOL)) : 0n,
      });
      await sendTx('Launch', [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix], [mint]);
      $('#launch').close();
      location.hash = `#/coin/${mint.publicKey.toBase58()}`;
    } catch (e) { toast(errMessage(e), true); }
    finally { btn.disabled = false; btn.textContent = 'Launch coin'; }
  });

  // ------------------------------------------------------------------ admin page
  async function renderAdmin() {
    const app = $('#app');
    app.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'empty' }, 'Reading settings…')));
    configCache = null;
    let cfg;
    try { cfg = await getConfig(); }
    catch (e) { app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'banner' }, errMessage(e)))); return; }
    const me = wallet?.publicKey;
    const isAdmin = !!me && me.equals(cfg.admin);
    const isPending = !!me && me.equals(cfg.pendingAdmin);
    const solStr = (l) => String(solOf(l));
    const field = (name, label, value, hint, attrs = {}) => h('label', { class: 'f' }, label,
      h('input', { class: 'in', name, value, autocomplete: 'off', disabled: !isAdmin, ...attrs }), hint ? h('span', { class: 'note' }, hint) : null);
    const form = h('form', { class: 'admin-form', novalidate: true },
      field('devWallet', 'Dev wallet', cfg.devWallet.toBase58()),
      field('buybackWallet', 'Buyback wallet', cfg.buybackWallet.toBase58()),
      field('devSharePct', 'Dev wallet share of fees (%)', String(cfg.devShareBps / 100), 'The rest goes to the buyback wallet.', { inputmode: 'decimal' }),
      field('tradeFeePct', 'Trading fee (%)', String(cfg.tradeFeeBps / 100), 'Up to 2%.', { inputmode: 'decimal' }),
      field('creationFee', 'Launch fee (SOL)', solStr(cfg.creationFee), 'Up to 1 SOL.', { inputmode: 'decimal' }),
      field('graduationFee', 'Graduation fee (SOL)', solStr(cfg.graduationFee), 'Between 0.3 and 5 SOL. Covers Raydium’s pool fee and rent.', { inputmode: 'decimal' }),
      field('initialVirtualSol', 'Virtual SOL for new coins', solStr(cfg.initialVirtualSol), `New curves fill at twice this amount (now ${fmt(solOf(cfg.initialVirtualSol * 2n))} SOL). Existing coins aren’t affected.`, { inputmode: 'decimal' }),
      field('certifier', 'Certifier key', cfg.certifier.toBase58(), 'The key your certification service signs with.'),
      field('raydiumAmmConfig', 'Raydium fee config', cfg.raydiumAmmConfig.toBase58()),
      h('label', { class: 'f check' }, h('input', { type: 'checkbox', name: 'paused', checked: cfg.paused, disabled: !isAdmin }), ' Pause new launches and buys (selling always works)'),
    );
    const changes = h('ul', { class: 'note' });
    const save = h('button', { class: 'btn wax', type: 'button', disabled: true }, 'Save changes');

    function readForm() {
      const f = new FormData(form);
      const pct = (k) => Math.round(parseFloat(f.get(k)) * 100);
      const lam = (k) => BigInt(Math.round(parseFloat(f.get(k)) * LAMPORTS_PER_SOL));
      return {
        devWallet: new PublicKey(String(f.get('devWallet')).trim()), buybackWallet: new PublicKey(String(f.get('buybackWallet')).trim()),
        certifier: new PublicKey(String(f.get('certifier')).trim()), raydiumAmmConfig: new PublicKey(String(f.get('raydiumAmmConfig')).trim()),
        devShareBps: pct('devSharePct'), tradeFeeBps: pct('tradeFeePct'),
        creationFee: lam('creationFee'), graduationFee: lam('graduationFee'), initialVirtualSol: lam('initialVirtualSol'),
        paused: form.querySelector('[name=paused]').checked,
      };
    }
    function diff() {
      let next;
      try { next = readForm(); } catch { changes.replaceChildren(h('li', { class: 'warn' }, 'One of the addresses isn’t a valid Solana address.')); save.disabled = true; return null; }
      const labels = { devWallet: 'Dev wallet', buybackWallet: 'Buyback wallet', certifier: 'Certifier', raydiumAmmConfig: 'Raydium config', devShareBps: 'Dev share', tradeFeeBps: 'Trading fee', creationFee: 'Launch fee', graduationFee: 'Graduation fee', initialVirtualSol: 'Virtual SOL', paused: 'Paused' };
      const show = (k, v) => (v instanceof PublicKey ? short(v.toBase58()) : /Bps$/.test(k) ? `${Number(v) / 100}%` : typeof v === 'bigint' ? `${solOf(v)} SOL` : String(v));
      const items = Object.keys(labels).filter((k) => (next[k] instanceof PublicKey ? !next[k].equals(cfg[k]) : String(next[k]) !== String(cfg[k])))
        .map((k) => h('li', {}, `${labels[k]}: ${show(k, cfg[k])} → ${show(k, next[k])}`));
      changes.replaceChildren(...items);
      save.disabled = !isAdmin || !items.length;
      return next;
    }
    form.addEventListener('input', diff);
    save.onclick = async () => {
      const next = diff();
      if (!next) return;
      save.disabled = true; save.textContent = 'Confirm in your wallet…';
      try { await sendTx('Settings update', [lp.updateConfig({ admin: wallet.publicKey, params: next })]); renderAdmin(); }
      catch (e) { toast(errMessage(e), true); save.textContent = 'Save changes'; diff(); }
    };

    const payout = h('button', { class: 'btn line', type: 'button', disabled: cfg.feesAccrued === 0n, onclick: async () => {
      try { await sendTx('Fee payout', [lp.distributeFees({ devWallet: cfg.devWallet, buybackWallet: cfg.buybackWallet })]); renderAdmin(); }
      catch (e) { toast(errMessage(e), true); }
    } }, 'Pay out fees');
    const newAdmin = h('input', { class: 'in', placeholder: 'New admin address', autocomplete: 'off', disabled: !isAdmin });
    const handover = h('button', { class: 'btn line', type: 'button', disabled: !isAdmin, onclick: async () => {
      try {
        const pk = new PublicKey(newAdmin.value.trim());
        await sendTx('Admin handover', [lp.proposeAdmin({ admin: wallet.publicKey, newAdmin: pk, raydiumAmmConfig: cfg.raydiumAmmConfig })]); renderAdmin();
      } catch (e) { toast(errMessage(e), true); }
    } }, 'Propose new admin');
    const accept = isPending ? h('button', { class: 'btn wax', type: 'button', onclick: async () => {
      try { await sendTx('Admin role', [lp.acceptAdmin({ newAdmin: wallet.publicKey })]); renderAdmin(); } catch (e) { toast(errMessage(e), true); }
    } }, 'Accept the admin role') : null;

    const status = !me ? h('div', { class: 'banner' }, 'Connect the admin wallet to change settings. ', h('button', { class: 'btn', type: 'button', onclick: () => connect().then(renderAdmin) }, 'Connect wallet'))
      : isAdmin ? null
      : h('div', { class: 'banner' }, `The connected wallet isn’t the admin (${short(cfg.admin.toBase58())}). Settings are read-only.`);

    app.replaceChildren(h('div', { class: 'wrap admin' },
      h('h1', {}, 'Settings'),
      h('p', { class: 'muted' }, `Admin ${cfg.admin.toBase58()}`, cfg.pendingAdmin.equals(PublicKey.default) ? '' : `. Handover pending to ${cfg.pendingAdmin.toBase58()}.`),
      status, accept,
      h('section', { class: 'panel' }, h('h2', {}, 'Fees waiting to be paid out'),
        h('p', {}, `${sol(cfg.feesAccrued)}: ${sol((cfg.feesAccrued * BigInt(cfg.devShareBps)) / 10000n)} to the dev wallet, the rest to the buyback wallet. Anyone can trigger this.`), payout),
      h('section', { class: 'panel' }, h('h2', {}, 'Launchpad settings'), form, changes, save),
      h('section', { class: 'panel' }, h('h2', {}, 'Hand over the admin role'),
        h('p', { class: 'muted' }, 'The new wallet must accept on this page before the handover takes effect.'), newAdmin, handover)));
  }

  // ------------------------------------------------------------------ coin page
  async function renderCoin(mint) {
    const app = $('#app');
    app.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'empty' }, 'Opening the record…')));
    let coin, cfg;
    try { [coin, cfg] = await Promise.all([loadCoin(mint), getConfig()]); }
    catch (e) { app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'banner' }, errMessage(e)))); return; }
    if (!coin) { app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'banner' }, 'No Secretum coin at this address.'))); return; }

    const statEls = {};
    const stat = (k, label) => h('div', {}, (statEls[k] = h('b', {}, '–')), h('span', {}, label));
    const bar = h('div', { class: 'bar' }, h('i'));
    const barLabel = h('div', { class: 'bar-label' });
    const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spark.setAttribute('class', 'spark'); spark.setAttribute('viewBox', '0 0 600 120'); spark.setAttribute('preserveAspectRatio', 'none');
    spark.setAttribute('role', 'img'); spark.setAttribute('aria-label', 'Recent price');
    const tradesBody = h('tbody', {}, h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Loading trades…')));
    const certBox = h('div', { class: 'cert' });
    const tradePanel = h('aside', { class: 'panel trade', 'aria-label': 'Trade' });

    app.replaceChildren(h('div', { class: 'wrap coin' },
      h('div', {},
        h('div', { class: 'coin-head' }, coinImage(coin, 88),
          h('div', {}, h('h1', {}, coin.name), h('div', { class: 'sym' }, `$${coin.symbol}, launched ${ago(coin.createdAt)} by `,
            h('a', { href: CFG.explorers.solanaAccount(coin.creator.toBase58(), CFG.cluster), target: '_blank', rel: 'noopener' }, short(coin.creator.toBase58()))),
          h('div', { class: 'hash' }, mint))),
        h('div', { class: 'stats' }, stat('price', 'Price per million tokens'), stat('mcap', 'Market cap'), stat('raised', 'SOL in curve'), stat('sold', 'Tokens sold')),
        bar, barLabel, spark,
        h('section', { 'aria-labelledby': 'cert-title' }, h('h2', { id: 'cert-title', class: 'sr-only' }, 'Certificate of origin'), certBox),
        h('section', { class: 'panel', 'aria-labelledby': 'trades-title' }, h('h2', { id: 'trades-title' }, 'Recent trades'),
          h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, h('th', {}, 'Trade'), h('th', {}, 'SOL'), h('th', {}, coin.symbol), h('th', {}, 'When'))), tradesBody))),
      tradePanel));

    const refresh = async () => {
      try { coin = (await loadCoin(mint)) || coin; } catch { return; }
      statEls.price.textContent = fmt(S.priceLamportsPerToken(coin.virtualSol, coin.virtualToken) * 1e6 / 1e9, 4) + ' SOL';
      statEls.mcap.textContent = fmt(S.marketCapLamports(coin) / 1e9) + ' SOL';
      statEls.raised.textContent = coin.graduated ? 'On Raydium' : sol(coin.realSol);
      statEls.sold.textContent = tokens(coin.tokensSold);
      const pct = coin.graduated ? 100 : coin.progressBps / 100;
      bar.className = 'bar' + (coin.graduated || coin.complete ? ' done' : '');
      bar.firstChild.style.width = pct + '%';
      barLabel.textContent = coin.graduated ? 'Graduated: trading on Raydium' : coin.complete ? 'Curve full: ready to graduate to Raydium' : `${pct.toFixed(2)}% of the curve sold`;
      renderCert(certBox, coin);
      renderTrade(tradePanel, coin, cfg, refresh);
      loadTrades(mint).then((ts) => {
        tradesBody.replaceChildren(...(ts.length ? ts.slice(0, 25).map((t) => h('tr', {},
          h('td', { class: t.isBuy ? 'b' : 's' }, h('a', { href: CFG.explorers.solanaTx(t.sig, CFG.cluster), target: '_blank', rel: 'noopener' }, t.isBuy ? 'Buy' : 'Sell')),
          h('td', {}, fmt(solOf(t.solAmount), 4)), h('td', {}, tokens(t.tokenAmount)), h('td', {}, ago(t.timestamp)))) : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No trades yet. Be the first.'))]));
        drawSpark(spark, ts);
      }).catch(() => tradesBody.replaceChildren(h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Trade history isn’t available from this RPC.'))));
    };
    await refresh();
    timer = setInterval(refresh, 15000);
  }

  function drawSpark(svg, trades) {
    const pts = trades.slice().reverse().map((t) => Number(t.virtualSol) / Number(t.virtualToken));
    svg.replaceChildren();
    if (pts.length < 2) return;
    const min = Math.min(...pts), max = Math.max(...pts), span = max - min || max || 1;
    const d = pts.map((p, i) => `${(i / (pts.length - 1)) * 600},${(110 - ((p - min) / span) * 100).toFixed(1)}`).join(' ');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', d); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#b4233c'); line.setAttribute('stroke-width', '2'); line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }

  async function renderCert(box, coin) {
    const certs = [
      { key: 'monero', name: 'Monero', bit: 1, link: CFG.explorers.monero, at: coin.certMoneroAt },
      { key: 'zcash', name: 'Zcash', bit: 2, link: CFG.explorers.zcash, at: coin.certZcashAt },
      { key: 'hyperevm', name: 'HyperEVM', bit: 4, link: CFG.explorers.hyperevm, at: coin.certHyperevmAt },
    ];
    const result = h('span', { class: 'verify-result' });
    const verifyBtn = h('button', { class: 'btn line', type: 'button', onclick: async () => {
      try {
        const got = await S.certificateHash({ mint: coin.mint, creator: coin.creator, name: coin.name, symbol: coin.symbol, uri: coin.uri, slot: coin.createdSlot, timestamp: coin.createdAt });
        const okHash = got === S.toHex(coin.launchHash);
        result.className = 'verify-result ' + (okHash ? 'good' : 'bad');
        result.textContent = okHash ? 'Match: this coin’s public data hashes to its certificate.' : 'Mismatch: the data does not match the certificate.';
      } catch (e) { result.className = 'verify-result bad'; result.textContent = errMessage(e); }
    } }, 'Verify in your browser');
    box.replaceChildren(
      seal(coin, 170),
      h('div', {},
        h('h2', { class: 'panel-title' }, 'Certificate of origin'),
        h('div', { class: 'hash' }, S.certificatePayload(S.toHex(coin.launchHash))),
        h('ol', {}, ...certs.map((c) => {
          const tx = coin.certs[c.key];
          return h('li', {}, h('span', { class: 'chain' }, c.name),
            tx ? h('span', {}, h('span', { class: 'status-on' }, 'Certified '), h('span', { class: 'muted' }, ago(c.at) + ', '),
              h('a', { href: c.link(tx), target: '_blank', rel: 'noopener' }, short(tx)))
              : h('span', { class: 'muted' }, c.key === 'zcash' ? 'Pending: follows about 15 minutes after launch' : 'Pending'));
        })),
        h('div', { class: 'verify' }, verifyBtn, result),
        CFG.certifierUrl ? h('p', { class: 'note' }, 'Monero proof and Zcash memo details: ',
          h('a', { href: `${CFG.certifierUrl.replace(/\/$/, '')}/certificates/${coin.mint.toBase58()}`, target: '_blank', rel: 'noopener' }, 'certificate file')) : null));
  }

  // ------------------------------------------------------------------ trade panel
  function renderTrade(panel, coin, cfg, refresh) {
    if (coin.graduated) {
      panel.replaceChildren(h('h2', {}, 'On Raydium'),
        h('p', { class: 'muted' }, 'This coin’s curve is complete. Its liquidity sits in a Raydium pool and the LP tokens were burned.'),
        h('a', { class: 'btn wax full', href: CFG.explorers.raydium(coin.mint.toBase58()), target: '_blank', rel: 'noopener' }, 'Trade on Raydium'),
        h('p', { class: 'note' }, 'Pool: ', h('a', { href: CFG.explorers.solanaAccount(coin.pool.toBase58(), CFG.cluster), target: '_blank', rel: 'noopener' }, short(coin.pool.toBase58()))));
      delete panel.dataset.built;
      return;
    }
    if (coin.complete) {
      const btn = h('button', { class: 'btn wax full', type: 'button', onclick: async () => {
        btn.disabled = true; btn.textContent = 'Graduating…';
        try { await sendTx('Graduation', [lp.graduateComputeIx(), lp.graduate({ payer: wallet?.publicKey || (await connect()).publicKey, mint: coin.mint, ammConfig: cfg.raydiumAmmConfig })]); await refresh(); }
        catch (e) { toast(errMessage(e), true); btn.disabled = false; btn.textContent = 'Graduate to Raydium'; }
      } }, 'Graduate to Raydium');
      panel.replaceChildren(h('h2', {}, 'Curve full'), h('p', { class: 'muted' }, 'Anyone can move this coin to Raydium now. You only pay the network fee.'), btn);
      delete panel.dataset.built;
      return;
    }
    if (panel.dataset.built) { panel.update?.(coin); return; }
    panel.dataset.built = '1';

    let side = 'buy', slipBps = 200, bal = { sol: 0n, tok: 0n };
    const input = h('input', { inputmode: 'decimal', placeholder: '0', autocomplete: 'off', 'aria-label': 'Amount' });
    const unit = h('span');
    const quick = h('div', { class: 'quick' });
    const quote = h('dl', { class: 'quote' });
    const balLine = h('p', { class: 'note' });
    const action = h('button', { class: 'btn wax full', type: 'button' });
    const slip = h('input', { value: '2', inputmode: 'decimal', 'aria-label': 'Maximum slippage percent' });
    const buyB = h('button', { type: 'button', class: 'buy' }, 'Buy');
    const sellB = h('button', { type: 'button', class: 'sell' }, 'Sell');
    const setSide = (s) => { side = s; buyB.setAttribute('aria-pressed', String(s === 'buy')); sellB.setAttribute('aria-pressed', String(s === 'sell')); input.value = ''; build(); };
    buyB.onclick = () => setSide('buy'); sellB.onclick = () => setSide('sell');
    slip.oninput = () => { const v = parseFloat(slip.value); slipBps = isFinite(v) && v >= 0 && v <= 50 ? Math.round(v * 100) : 200; update(); };
    panel.replaceChildren(h('div', { class: 'side', role: 'group', 'aria-label': 'Buy or sell' }, buyB, sellB), h('div', { class: 'amount' }, input, unit), quick, quote, action,
      balLine, h('p', { class: 'note slip' }, 'Max slippage', slip, '%'));

    async function loadBalances() {
      if (!wallet) { bal = { sol: 0n, tok: 0n }; return; }
      const [s, t] = await Promise.all([
        conn.getBalance(wallet.publicKey),
        conn.getTokenAccountBalance(lp.userAta(wallet.publicKey, coin.mint)).then((r) => BigInt(r.value.amount)).catch(() => 0n),
      ]);
      bal = { sol: BigInt(s), tok: t };
    }
    function build() {
      unit.textContent = side === 'buy' ? 'SOL' : coin.symbol;
      quick.replaceChildren(...(side === 'buy'
        ? ['0.1', '0.5', '1', '5'].map((v) => h('button', { type: 'button', onclick: () => { input.value = v; update(); } }, v + ' SOL'))
        : [25, 50, 100].map((p) => h('button', { type: 'button', onclick: () => { input.value = String(Number((bal.tok * BigInt(p)) / 100n) / 1e6); update(); } }, p + '%'))));
      loadBalances().then(update);
    }
    let debounce;
    input.oninput = () => { clearTimeout(debounce); debounce = setTimeout(update, 200); };
    panel.update = (c) => { coin = c; loadBalances().then(update); };

    function update() {
      balLine.textContent = wallet ? (side === 'buy' ? `Balance: ${sol(bal.sol)}` : `Balance: ${tokens(bal.tok)} ${coin.symbol}`) : '';
      quote.replaceChildren();
      const r = (k, v, cls) => h('div', {}, h('dt', {}, k), h('dd', { class: cls }, v));
      if (!wallet) { action.disabled = false; action.textContent = 'Connect wallet'; action.onclick = () => connect().then(() => loadBalances().then(update)).catch((e) => toast(errMessage(e), true)); return; }
      const v = parseFloat(input.value);
      if (!input.value || !(v > 0)) { action.disabled = true; action.textContent = 'Enter an amount'; return; }
      const fee = cfg.tradeFeeBps;
      if (side === 'buy') {
        const lamports = BigInt(Math.round(v * LAMPORTS_PER_SOL));
        const q = S.quoteBuy(coin, lamports, fee);
        const now = S.priceLamportsPerToken(coin.virtualSol, coin.virtualToken);
        const avg = q.tokensOut > 0n ? Number(q.solIn) / (Number(q.tokensOut) / 1e6) : 0;
        const impact = now ? (avg / now - 1) * 100 : 0;
        quote.append(r('You receive', `${tokens(q.tokensOut)} ${coin.symbol}`), r('Fee', sol(q.fee)), r('Price impact', `${impact.toFixed(2)}%`, impact > 10 ? 'note warn' : ''));
        if (q.capped) quote.append(h('p', { class: 'note warn' }, `This buy fills the curve. You’ll be charged ${sol(q.total)}, not the full amount.`));
        if (lamports > bal.sol) { action.disabled = true; action.textContent = 'Not enough SOL'; return; }
        const minOut = (q.tokensOut * BigInt(10000 - slipBps)) / 10000n;
        action.disabled = false; action.textContent = `Buy ${coin.symbol}`;
        action.onclick = () => run('Buy', [lp.buy({ user: wallet.publicKey, mint: coin.mint, maxSol: lamports, minTokensOut: minOut })]);
      } else {
        const amount = BigInt(Math.round(v * 1e6));
        const q = S.quoteSell(coin, amount, fee);
        quote.append(r('You receive', sol(q.solOut)), r('Fee', sol(q.fee)));
        if (amount > bal.tok) { action.disabled = true; action.textContent = `Not enough ${coin.symbol}`; return; }
        const minOut = (q.solOut * BigInt(10000 - slipBps)) / 10000n;
        action.disabled = false; action.textContent = `Sell ${coin.symbol}`;
        action.onclick = () => run('Sell', [lp.sell({ user: wallet.publicKey, mint: coin.mint, tokenAmount: amount, minSolOut: minOut })]);
      }
    }
    async function run(label, ixs) {
      action.disabled = true; const t = action.textContent; action.textContent = 'Confirm in your wallet…';
      try { await sendTx(label, ixs); input.value = ''; await refresh(); }
      catch (e) { toast(errMessage(e), true); }
      finally { action.textContent = t; await loadBalances(); update(); }
    }
    setSide('buy');
  }

  renderHeader();
  route();
  // Reconnect silently if the wallet already trusts this site.
  const p = detectProviders()[0]?.p;
  p?.connect?.({ onlyIfTrusted: true }).then((r) => { if (r?.publicKey || p.publicKey) { wallet = { provider: p, publicKey: new PublicKey((r?.publicKey || p.publicKey).toString()) }; renderHeader(); route(); } }).catch(() => {});
})();
