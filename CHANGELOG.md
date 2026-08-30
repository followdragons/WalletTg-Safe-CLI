# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2026-08-30

Initial WalletTg Safe CLI release.

### Added

- encrypted WalletTg seed vault with generated 256-bit password;
- mainnet/testnet address derivation and verified WalletTrampoline StateInit;
- non-bounceable funding flow and signed self-deploy;
- mandatory WalletTg rev00 `config[-123]` hash verification;
- external/internal single and bulk transfers;
- public-key rotation with vault replacement;
- public getter and balance inspection;
- optional Windows DPAPI funding Wallet V4 store;
- TON Center rate limiting, retry and safe error diagnostics;
- unit/regression tests for contract encoding, BOC integrity and secret stores.

### Security fixes included

- prevent bounce of pre-activation funding by printing the `UQ…` form;
- keep the public trampoline BOC buffer alive so serialized StateInit code cannot
  be mutated after address calculation;
- avoid printing signed BOCs or private request material in network errors.
