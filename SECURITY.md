# Security policy

## Supported release

Security fixes are applied to the latest `release-cli-*` branch and its tagged
successor when tags are published. Version `0.1.0` is the initial CLI release.

## Never disclose wallet secrets

Do not put seed phrases, vault passwords, private keys, encrypted vault files or
signed transaction BOCs in GitHub issues, pull requests, screenshots, chat or logs.
If a seed phrase has been disclosed, treat it as compromised immediately, move
funds to a newly generated wallet and stop using the old key.

## Reporting

Use a private GitHub security advisory for the repository when available. A report
should contain reproduction steps and public identifiers only. Redact all secret
input and replayable signed payloads.

## Threat model

The CLI protects secrets at rest against disclosure of the project directory:

- WalletTg seed: AES-256-GCM vault with authenticated metadata;
- key derivation: scrypt with random 256-bit salt;
- generated vault password: 256 bits from the operating-system CSPRNG;
- optional funding Wallet V4: Windows DPAPI ciphertext;
- secret input: hidden interactive TTY only.

The CLI does not protect against a compromised operating system, administrator,
keylogger, screen capture, malicious Node.js runtime, process-memory dump, terminal
logging, clipboard monitor or an attacker who has both the vault and its password.

## Operational rules

1. Use a dedicated, patched computer and verified Node.js installation.
2. Run `npm ci` and `npm run check` after checkout.
3. Verify the Git branch/commit before entering any secret.
4. Disable screen sharing and terminal recording during create/rotate operations.
5. Store seed, password and encrypted vault in separate backup locations.
6. Fund only the displayed `UQ…` address before activation.
7. Verify recipients and totals printed by the CLI before signing.
8. Start with testnet and small mainnet amounts.

## Cryptographic and runtime caveat

Node.js buffers containing secret keys are overwritten when practical. JavaScript
strings and runtime copies cannot be guaranteed to disappear from physical memory.
Vault encryption reduces at-rest exposure; it is not a hardware-wallet boundary.
