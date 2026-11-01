// Zcash anchor: a small shielded self-send whose 512-byte memo carries the certificate payload.
// Shielded memos are encrypted; publish the certifier wallet's viewing key (ZCASH_VIEWING_KEY)
// so anyone can import it and read the memos. Speaks the zcashd-compatible JSON-RPC
// (z_sendmany / z_getoperationresult), which zcashd and Zallet both implement.

module.exports = function zcash({
  rpcUrl, rpcUser, rpcPassword, fromAddress, toAddress, amountZec = 0.00001, minconf = 1,
  privacyPolicy = 'FullPrivacy', pollMs = 2000, timeoutMs = 10 * 60 * 1000, fetchImpl = fetch,
}) {
  let id = 0;
  const auth = rpcUser ? 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64') : undefined;
  async function rpc(method, params = []) {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`zcash ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    name: 'zcash',
    chain: 1,
    rpc,
    async anchor({ payload }) {
      const memo = Buffer.from(payload, 'utf8').toString('hex');
      const opid = await rpc('z_sendmany', [fromAddress, [{ address: toAddress || fromAddress, amount: amountZec, memo }], minconf, null, privacyPolicy]);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [op] = await rpc('z_getoperationresult', [[opid]]);
        if (op) {
          if (op.status === 'success') return { txid: op.result.txid, details: { to: toAddress || fromAddress, memo: payload } };
          throw new Error(`zcash op ${opid} ${op.status}: ${op.error?.message || ''}`);
        }
        await sleep(pollMs);
      }
      throw new Error(`zcash op ${opid} timed out`);
    },
  };
};
