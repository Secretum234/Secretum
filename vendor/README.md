# vendor

- `raydium-cp-swap/` — Raydium's CPMM program source (Apache-2.0, from github.com/raydium-io/raydium-cp-swap). Used as a CPI dependency for graduation.
- `raydium_cp_swap.so` — that program compiled to SBF (mainnet ids), loaded by the integration tests so graduation is tested against Raydium's real code.
  Rebuild: `cd vendor/raydium-cp-swap && cargo-build-sbf` and copy `target/deploy/raydium_cp_swap.so` here.
