// HyperEVM anchor: a 0-value transaction to ourselves whose calldata is the certificate payload
// ("SECRETUM1:<sha256 hex>"). Fully public: anyone can read it on a HyperEVM explorer.
const { ethers } = require('ethers');

module.exports = function hyperevm({ rpcUrl, privateKey, chainId = 999, confirmations = 1, provider }) {
  const p = provider || new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(privateKey, p);
  return {
    name: 'hyperevm',
    chain: 2,
    address: wallet.address,
    async anchor({ payload }) {
      const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n, data: ethers.hexlify(ethers.toUtf8Bytes(payload)) });
      const rc = await tx.wait(confirmations);
      if (!rc || rc.status !== 1) throw new Error(`HyperEVM tx ${tx.hash} failed`);
      return { txid: tx.hash, details: { from: wallet.address, block: rc.blockNumber } };
    },
  };
};
