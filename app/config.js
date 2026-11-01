// Site configuration. Edit after deploying (see README "Deploy").
window.SECRETUM_CONFIG = {
  cluster: 'devnet', // 'devnet' | 'mainnet'
  // Use a dedicated RPC (Helius, Triton, QuickNode...) for mainnet: public RPCs rate-limit and
  // block getProgramAccounts, which the coin list needs.
  rpc: 'https://api.devnet.solana.com',
  programId: 'HPomwh2M3sMcD9LpTALifnT41RQYx3rq7sUn3HrvukpR',
  // Your certification service's public URL (serves /certificates/<mint> and /keys). Optional.
  certifierUrl: '',
  explorers: {
    solanaTx: (sig, cluster) => `https://solscan.io/tx/${sig}${cluster === 'devnet' ? '?cluster=devnet' : ''}`,
    solanaAccount: (a, cluster) => `https://solscan.io/account/${a}${cluster === 'devnet' ? '?cluster=devnet' : ''}`,
    monero: (tx) => `https://xmrchain.net/tx/${tx}`,
    zcash: (tx) => `https://blockchair.com/zcash/transaction/${tx}`,
    hyperevm: (tx) => `https://hyperevmscan.io/tx/${tx}`,
    raydium: (mint) => `https://raydium.io/swap/?inputMint=sol&outputMint=${mint}`,
  },
};
