# Production runbook

## 1. Clean installation

```powershell
git clone https://github.com/followdragons/tg-wallet.git
cd tg-wallet
git status --short --branch
npm ci
npm run check
```

Use Node.js 22 or newer. `git status` must be clean before entering wallet secrets.

## 2. Network preflight

TON Center API keys are optional. Key-less requests are rate-limited and retried.

```powershell
$env:TONCENTER_API_KEY = "YOUR_API_KEY"
npm run wallet -- help
```

Do not place the key in `.env` or Git.

## 3. Mainnet creation and activation

```powershell
npm run wallet -- create --network mainnet
```

- Save the seed and generated password before leaving the alternate screen.
- Re-enter only the complete generated password.
- Confirm that the primary funding address begins with `UQ`.
- Send exactly the intended small activation amount (the CLI currently waits for
  a detected balance of at least `0.1 TON`).
- Keep the terminal open until deployment is confirmed.

Resume an interrupted activation without creating another wallet:

```powershell
npm run wallet -- activate --network mainnet
```

## 4. Post-activation verification

```powershell
npm run wallet -- info --network mainnet --address EQ_WALLET_ADDRESS
```

Expected initial values are WalletTg revision `0`, mainnet subwallet ID
`0x7fff7f11`, and a positive seqno after self-deploy. Record the public address.

## 5. Backup set

Back up these items separately:

- current paper seed phrase;
- vault password;
- `.wallet-tg/wallet-mainnet.vault.json`;
- public `EQ…`/`UQ…` address.

The Git repository is not a backup location. Do not commit `.wallet-tg/` even
though the file is encrypted. After key rotation, replace the old seed and vault
backup only after on-chain confirmation.

## 6. Recovery boundaries

- Lost vault, current seed available: commands can fall back to a hidden mnemonic
  prompt when no vault is present; preserve the original vault until recovery is
  verified. Automatic vault re-import is not implemented in v0.1.0.
- Lost password, seed available: use the same fallback carefully on an offline
  copy and migrate funds if necessary.
- Lost current seed and password: the application cannot recover the wallet.
- Disclosed seed: move funds to a newly generated wallet immediately.
- Rotated wallet: recovery requires the current seed and the original wallet
  address because the address was derived from the initial StateInit.

## 7. Release verification

Before publishing a release branch:

```powershell
npm ci
npm run check
npm audit --omit=dev
git diff --check
git status --short --branch
```

Review all staged paths and verify that `.wallet-tg/`, `.env`, logs, editor state,
`node_modules/` and nested Git metadata are absent.
