// Monero anchor, via monero-wallet-rpc.
//
// Monero's wallet software cannot attach arbitrary data to a transaction, so the certificate is
// anchored in two parts that together are verifiable by anyone:
//   1. On-chain commitment: a self-send to our own *integrated address* whose payment ID is the
//      first 8 bytes of the certificate hash. The payment ID is encrypted in the tx; publishing
//      the tx key (we do) lets anyone decrypt it and see it matches.
//   2. Signature over the full hash: `get_tx_proof` signs the full payload ("SECRETUM1:<hash>")
//      with that transaction's keys. Anyone can check it with `check_tx_proof` in any Monero
//      wallet (or the CLI), proving this wallet bound that exact certificate to that tx.
//
// Run monero-wallet-rpc on localhost with --disable-rpc-login (or put it behind your own auth).

module.exports = function monero({ rpcUrl, amountPiconero = 1_000_000n, priority = 0, fetchImpl = fetch }) {
  let id = 0;
  async function rpc(method, params = {}) {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`monero ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  return {
    name: 'monero',
    chain: 0,
    rpc,
    async anchor({ payload, hashHex }) {
      const { address } = await rpc('get_address', { account_index: 0 });
      const paymentId = hashHex.slice(0, 16);
      const { integrated_address } = await rpc('make_integrated_address', { standard_address: address, payment_id: paymentId });
      const t = await rpc('transfer', {
        destinations: [{ amount: Number(amountPiconero), address: integrated_address }],
        priority,
        get_tx_key: true,
      });
      const { signature } = await rpc('get_tx_proof', { txid: t.tx_hash, address, message: payload });
      return {
        txid: t.tx_hash,
        details: { address, integratedAddress: integrated_address, paymentId, txKey: t.tx_key, txProof: signature, message: payload },
      };
    },
  };
};
