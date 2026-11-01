#!/usr/bin/env bash
# One-shot devnet deployment. Run from the repo root (works in GitHub Codespaces):
#   bash deploy/deploy-devnet.sh
# Safe to re-run: every step checks whether it's already done.
# Wallet addresses come from deploy/devnet.json.
set -euo pipefail
cd "$(dirname "$0")/.."

CFG=deploy/devnet.json
json() { node -e "console.log(require('./$CFG')['$1'])"; }
ADMIN=$(json admin); CERTIFIER=$(json certifier); DEV=$(json devWallet); BUYBACK=$(json buybackWallet)
KEYS="keys"
DEPLOYER="$KEYS/deployer.json"
PROGRAM_KEY=target/deploy/launchpad-keypair.json

step() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }

step "1/7 Tools"
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
source "$HOME/.cargo/env" 2>/dev/null || true
if ! command -v solana >/dev/null; then
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
[ -d node_modules ] || npm install

step "2/7 Deployer key (this becomes the program's upgrade authority)"
mkdir -p "$KEYS"
[ -f "$DEPLOYER" ] || solana-keygen new --no-bip39-passphrase -s -o "$DEPLOYER"
solana config set --url devnet --keypair "$DEPLOYER" >/dev/null
DEPLOYER_ADDR=$(solana address)
echo "Deployer: $DEPLOYER_ADDR"

step "3/7 Devnet SOL for the deployer (deploying costs about 3.5 SOL)"
need=4
bal() { solana balance | awk '{print int($1)}'; }
tries=0
while [ "$(bal)" -lt "$need" ] && [ $tries -lt 4 ]; do
  solana airdrop 2 >/dev/null 2>&1 || true
  tries=$((tries+1)); sleep 2
done
if [ "$(bal)" -lt "$need" ]; then
  echo
  echo "The devnet faucet is rate-limiting. Get free devnet SOL for:"
  echo "    $DEPLOYER_ADDR"
  echo "at https://faucet.solana.com (choose Devnet, request 5 SOL), then run this script again."
  exit 1
fi
solana balance

step "4/7 Program id"
mkdir -p target/deploy
if [ ! -f "$PROGRAM_KEY" ]; then
  solana-keygen new --no-bip39-passphrase -s -o "$PROGRAM_KEY"
fi
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEY")
node devtools/program-id.js "$PROGRAM_ID" >/dev/null
echo "Program id: $PROGRAM_ID"

step "5/7 Build for devnet (first build takes several minutes)"
npm run build:devnet

step "6/7 Deploy"
solana program deploy target/deploy/launchpad.so --program-id "$PROGRAM_KEY" --keypair "$DEPLOYER" --url devnet

step "7/7 Initialise and fund the fee wallets"
# Fee wallets must exist on-chain to receive payouts: give each a little devnet SOL.
for w in "$DEV" "$BUYBACK" "$CERTIFIER"; do
  if [ "$(solana balance "$w" | awk '{print ($1 < 0.01)}')" = "1" ]; then
    solana transfer --allow-unfunded-recipient "$w" 0.05 >/dev/null && echo "Funded $w"
  fi
done
if node devtools/admin.js show --cluster devnet | grep -q "No config yet"; then
  node devtools/admin.js init --cluster devnet --deployer "$DEPLOYER" --admin-address "$ADMIN" \
    --certifier "$CERTIFIER" --dev-wallet "$DEV" --buyback-wallet "$BUYBACK" --yes
fi
node devtools/admin.js show --cluster devnet

# Point the website at devnet + this program
node -e "
const fs=require('fs');let s=fs.readFileSync('app/config.js','utf8');
s=s.replace(/cluster: '[a-z]+'/, \"cluster: 'devnet'\").replace(/rpc: '[^']*'/, \"rpc: 'https://api.devnet.solana.com'\");
fs.writeFileSync('app/config.js', s);"

cat <<EOF

Done. Secretum is live on devnet.
  Program id:  $PROGRAM_ID
  Admin:       $ADMIN   (manage settings at <site>/#/admin with this wallet, on devnet)

BACK UP these two files now (right-click > Download in the Codespaces file list).
They are NOT in git, and if the codespace is deleted they're gone:
  $DEPLOYER        (upgrade authority: needed to upgrade the program)
  $PROGRAM_KEY     (program id keypair)

To browse the devnet site from this codespace:
  npx --yes http-server app -p 8080 -c-1
then open the forwarded port 8080.
EOF
