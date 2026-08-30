# WalletTg Safe CLI

A local CLI for creating and managing a wallet backed by the official TON
[`WalletTg`](https://github.com/ton-blockchain/tg-wallet-contract) contract.

Version `0.1.0` is the first CLI release. The project is designed to run locally
on a trusted computer and contains no backend, analytics, or telemetry.

> [!WARNING]
> This program handles real funds. The code has passed automated tests and
> mainnet checks, but it has not undergone an independent security audit. Test
> your workflow on testnet first, and never deposit more than you can afford to lose.

## Features

- creates a 24-word TON mnemonic and a local WalletTg vault;
- protects the vault with AES-256-GCM, a generated 256-bit password, and `scrypt` KDF;
- supports mainnet self-activation after funding the non-bounceable `UQ...` address;
- sends single or bulk transfers, up to the contract limit of 255 messages;
- supports external and internal gasless/relayer channels with distinct opcodes;
- rotates the public key without changing the wallet address;
- reads `revision`, `seqno`, `subwalletId`, `publicKey`, and balance;
- verifies TON `config[-123]` before self-deployment;
- provides a Windows DPAPI store for a separate funding Wallet V4 in the fallback deployment flow.

## Contract identity

The CLI pins the following official artifacts:

| Artifact | Hash |
|---|---|
| `WalletTrampoline.boc` SHA-256 | `19ec9e8bc64615da5edda931215dde125e7f9feda2178e558d4e4d2d71abf57f` |
| WalletTrampoline cell | `9149ae51c1e4689710cebf7830297b16acfbadb363a920a537893e7ffeeca768` |
| WalletTg rev00 / TON `config[-123]` cell | `6f177fd863213d7bd3b24a694b0b7efb7425721ed1d21490d052ae93276c4406` |

Before self-deployment, the current `config[-123]` is loaded from the selected
network and must exactly match the pinned WalletTg rev00 code. Missing or
unknown code blocks activation.

## Requirements and installation

- Windows 10/11 or another trusted local operating system;
- Node.js `22` or newer;
- PowerShell with an interactive TTY;
- access to TON Center.

```powershell
git clone https://github.com/followdragons/tg-wallet.git
cd tg-wallet
npm ci
npm run check
```

`npm ci` installs the versions pinned in `package-lock.json`.

## Mainnet quick start

```powershell
npm run wallet -- create --network mainnet
```

The CLI will:

1. generate a seed phrase and a 256-bit vault password;
2. display both once in an alternate terminal screen;
3. ask you to re-enter only the full password;
4. store the seed only in the encrypted `.wallet-tg/wallet-mainnet.vault.json`;
5. show the `UQ...` address for initial funding and the `EQ...` address for the active wallet;
6. verify WalletTg rev00 in `config[-123]`;
7. wait for `0.1 TON` and submit the signed self-deployment message.

Before activation, fund **only the `UQ...` address**. A transfer to the
bounceable `EQ...` address will bounce from an inactive account after network
fees are deducted.

If you stopped the waiting process, resume activation with:

```powershell
npm run wallet -- activate --network mainnet
```

You do not need to create or fund another wallet.

## Core commands

Get both address forms:

```powershell
npm run wallet -- address --network mainnet
```

Inspect public state:

```powershell
npm run wallet -- info --network mainnet --address EQ_WALLET_ADDRESS
```

Send TON:

```powershell
npm run wallet -- send --network mainnet `
  --to EQ_DESTINATION `
  --amount 0.01 `
  --comment "hello"
```

Send a batch:

```powershell
npm run wallet -- send-bulk --network mainnet `
  --transfer "EQ_DESTINATION_1,0.01" `
  --transfer "EQ_DESTINATION_2,0.02"
```

Before signing, the CLI displays the channel, addresses, message count, and
total amount. It submits the operation only after separate confirmation.

Gasless/relayer delivery:

```powershell
npm run wallet -- send --network mainnet `
  --channel internal `
  --relay-value 0.05 `
  --to EQ_DESTINATION `
  --amount 0.01
```

The owner enters the vault password. The CLI then separately requests the
mnemonic for the relayer Wallet V4, which pays to deliver the signed payload.
The relayer never receives the owner's key and cannot modify signed parameters.

Rotate the key:

```powershell
npm run wallet -- rotate-key --network mainnet
```

The CLI displays a new seed phrase, requests confirmation, submits the dual
proof required for the key change, and atomically re-encrypts the vault with
new salt and IV after on-chain confirmation. The old key stops working, the
password remains the same, and the wallet address is preserved.

View the complete command list:

```powershell
npm run wallet -- help
```

## Security model

- seed phrases and passwords are never accepted through argv or environment variables;
- secret input is hidden and requires an interactive TTY;
- the application does not store the password;
- `.wallet-tg/`, `.env*`, keys, seed files, and local backups are excluded from Git;
- the vault uses AES-256-GCM and `scrypt` (`N=131072`, `r=8`, `p=1`);
- signed BOCs and private material are not printed after network errors;
- seqno, `validUntil`, `subwalletId`, and channel-specific opcodes provide replay protection;
- mnemonic arrays and secret-key buffers are wiped where the runtime permits it.

JavaScript cannot guarantee physical erasure of every string from memory. The
CLI cannot protect against a compromised operating system, keylogger, screen
recorder, process dump, or compromised password manager. See
[SECURITY.md](SECURITY.md) for details.

Store these items separately:

1. the seed phrase on paper;
2. the vault password in a password manager and/or on paper;
3. the wallet address, especially after key rotation;
4. an encrypted vault backup outside the repository.

## Fallback funding Wallet V4

Self-deployment is the primary flow. An alternative deployment through a
separate Wallet V4 is available on Windows:

```powershell
npm run wallet -- funding-setup --network mainnet
npm run wallet -- funding-status --network mainnet
npm run wallet -- deploy --network mainnet --amount 0.05
```

The funding mnemonic is stored only as Windows DPAPI ciphertext bound to the
current Windows account. Never use a seed phrase that has previously been
published or otherwise compromised.

## TON Center

Without an API key, requests are serialized with a delay and retried after HTTP
`429` responses. You can set an optional key for the current PowerShell session:

```powershell
$env:TONCENTER_API_KEY = "YOUR_API_KEY"
```

Do not commit the API key or store it in `.env`.

## v0.1.0 limitations

- the CLI builds standard TON transfers and comments; Jetton, NFT, staking,
  TonConnect, multisig, and arbitrary payloads are not implemented yet;
- automatic seed import into a new vault is not implemented yet;
- the DPAPI funding store works only on Windows;
- the application is not an official Telegram Wallet interface;
- matching the contract proves WalletTg rev00 identity at the TON level but
  does not guarantee that a third-party application will display the wallet.

Production runbook: [docs/PRODUCTION.md](docs/PRODUCTION.md). Release history:
[CHANGELOG.md](CHANGELOG.md).

## Official contract snapshot

The `tg-wallet-contract-reference/` directory contains a vendored snapshot of
the official contract for reproducible verification of the BOC, storage, and
opcodes. The exact source, commit, and license are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
