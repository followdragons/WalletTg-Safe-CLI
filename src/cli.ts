import { Address, fromNano, toNano } from "@ton/core";
import {
    mnemonicNew,
    mnemonicToPrivateKey,
    mnemonicValidate,
} from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    DEFAULT_SUBWALLET_ID,
    NetworkName,
    SEND_MODE_IGNORE_ERRORS,
} from "./constants.js";
import {
    createSignedChangeKeyBody,
    createSignedSendBody,
    createWalletTgState,
    parseTon,
    publicKeyToUint256,
    RequestChannel,
    TransferRequest,
} from "./contract.js";
import {
    loadFundingMnemonic,
    readFundingMetadata,
    saveFundingMnemonic,
} from "./funding-store.js";
import {
    assertWalletTgConfigActive,
    createTonClient,
    deployWalletTg,
    getAddressBalance,
    getWalletTgInfo,
    isWalletDeployed,
    sendWalletTgExternal,
    sendWalletTgInternal,
    sendWalletTgSelfDeploy,
    waitForBalance,
    waitForDeployment,
    waitForSeqno,
} from "./network.js";
import {
    confirm,
    promptHidden,
    readMnemonic,
    revealMnemonicOnce,
    revealWalletSecretsOnce,
    verifyVaultPasswordBackup,
    wipeWords,
} from "./security.js";
import {
    generateVaultPassword,
    loadWalletMnemonic,
    readWalletVaultMetadata,
    saveWalletVault,
    walletVaultExists,
} from "./wallet-vault.js";

const SELF_DEPLOY_FUNDING = toNano("0.1");

interface ParsedArgs {
    command: string;
    options: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
    const command = argv[0] ?? "create";
    const options = new Map<string, string[]>();
    for (let index = 1; index < argv.length; index += 1) {
        const key = argv[index];
        if (key === undefined || !key.startsWith("--")) {
            throw new Error(`Unexpected argument: ${key ?? ""}`);
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Missing value for ${key}`);
        }
        const values = options.get(key) ?? [];
        values.push(value);
        options.set(key, values);
        index += 1;
    }
    return { command, options };
}

function oneOption(
    args: ParsedArgs,
    key: string,
    required = false,
): string | undefined {
    const values = args.options.get(key) ?? [];
    if (values.length > 1) {
        throw new Error(`${key} may only be specified once.`);
    }
    const value = values[0];
    if (required && value === undefined) {
        throw new Error(`${key} is required.`);
    }
    return value;
}

function parseNetwork(args: ParsedArgs): NetworkName {
    const value = oneOption(args, "--network") ?? "testnet";
    if (value !== "mainnet" && value !== "testnet") {
        throw new Error("--network must be mainnet or testnet.");
    }
    return value;
}

function parseChannel(args: ParsedArgs): RequestChannel {
    const value = oneOption(args, "--channel") ?? "external";
    if (value !== "external" && value !== "internal") {
        throw new Error("--channel must be external or internal.");
    }
    return value;
}

async function broadcastSignedBody(
    args: ParsedArgs,
    channel: RequestChannel,
    client: ReturnType<typeof createTonClient>,
    walletAddress: Address,
    body: ReturnType<typeof createSignedSendBody>,
    relayerWords: string[],
): Promise<void> {
    if (channel === "external") {
        await sendWalletTgExternal(client, walletAddress, body);
        return;
    }
    const entered = await readValidatedMnemonic("Relayer Wallet V4 mnemonic");
    relayerWords.push(...entered);
    wipeWords(entered);
    const relayValue = parseTon(oneOption(args, "--relay-value") ?? "0.05");
    await sendWalletTgInternal(
        client,
        walletAddress,
        body,
        relayerWords,
        relayValue,
    );
}

function friendlyAddress(address: Address, network: NetworkName): string {
    return address.toString({
        bounceable: true,
        testOnly: network === "testnet",
    });
}

function fundingAddress(address: Address, network: NetworkName): string {
    return address.toString({
        bounceable: false,
        testOnly: network === "testnet",
    });
}

async function readValidatedMnemonic(label: string): Promise<string[]> {
    const words = await readMnemonic(label);
    if (!(await mnemonicValidate(words))) {
        wipeWords(words);
        throw new Error("Invalid TON mnemonic.");
    }
    return words;
}

async function deriveStateFromPrompt(
    network: NetworkName,
    label: string,
): Promise<{
    words: string[];
    keys: Awaited<ReturnType<typeof mnemonicToPrivateKey>>;
    state: ReturnType<typeof createWalletTgState>;
    walletAddress: Address;
    vaultPassword: string | null;
}> {
    const metadata = await readWalletVaultMetadata(network);
    const vaultPassword = metadata === null
        ? null
        : await promptHidden("WalletTg vault password: ");
    const words = metadata === null
        ? await readValidatedMnemonic(label)
        : await loadWalletMnemonic(network, vaultPassword as string);
    if (!(await mnemonicValidate(words))) {
        wipeWords(words);
        throw new Error("The WalletTg vault contains an invalid mnemonic.");
    }
    const keys = await mnemonicToPrivateKey(words);
    const state = createWalletTgState(keys.publicKey, network);
    if (metadata !== null && !keys.publicKey.equals(metadata.publicKey)) {
        keys.secretKey.fill(0);
        wipeWords(words);
        throw new Error("WalletTg vault metadata does not match its encrypted seed.");
    }
    return {
        words,
        keys,
        state,
        walletAddress: metadata?.address ?? state.address,
        vaultPassword,
    };
}

function wipeOwnerMaterial(owner: Awaited<ReturnType<typeof deriveStateFromPrompt>>): void {
    owner.keys.secretKey.fill(0);
    wipeWords(owner.words);
    owner.vaultPassword = null;
}

async function assertOnChainKey(
    onChainPublicKey: bigint,
    localPublicKey: Buffer,
): Promise<void> {
    if (onChainPublicKey !== publicKeyToUint256(localPublicKey)) {
        throw new Error(
            "The entered mnemonic does not match the wallet's current public key.",
        );
    }
}

async function createCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    if (await walletVaultExists(network)) {
        const existing = await readWalletVaultMetadata(network);
        throw new Error(
            `A ${network} WalletTg vault already exists: ${existing?.path ?? ".wallet-tg"}. ` +
            "Use it with the address, activate, send, or rotate-key command.",
        );
    }
    const words = await mnemonicNew(24);
    const keys = await mnemonicToPrivateKey(words);
    let vaultPassword = generateVaultPassword();
    try {
        const state = createWalletTgState(keys.publicKey, network);
        await revealWalletSecretsOnce(words, vaultPassword);
        await verifyVaultPasswordBackup(vaultPassword);
        const vault = await saveWalletVault(
            network,
            state.address,
            keys.publicKey,
            words,
            vaultPassword,
        );
        console.log("\nWallet created and encrypted locally.");
        console.log(`Network: ${network}`);
        console.log(
            `Funding address (UQ, before activation): ${fundingAddress(state.address, network)}`,
        );
        console.log(
            `Wallet address (EQ, after activation): ${friendlyAddress(state.address, network)}`,
        );
        console.log(`Subwallet ID: 0x${state.subwalletId.toString(16)}`);
        console.log(`Encrypted vault: ${vault.path}`);
        console.log("The password is not stored. The vault contains no plaintext seed words.");

        try {
            const codeHash = await assertWalletTgConfigActive(network);
            console.log(`Verified TON config[-123] WalletTg rev00: ${codeHash}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown network error";
            console.warn(`Activation preflight is temporarily unavailable: ${message}`);
            console.log("The encrypted wallet is safe. Retry later with:");
            console.log(`npm run wallet -- activate --network ${network}`);
            return;
        }
        if (await confirm(
            `Wait for ${fromNano(SELF_DEPLOY_FUNDING)} TON funding and activate this wallet now?`,
        )) {
            await activateOwner(network, {
                words,
                keys,
                state,
                walletAddress: state.address,
                vaultPassword,
            });
        } else {
            console.log("Fund the address with at least 0.1 TON, then run:");
            console.log(`npm run wallet -- activate --network ${network}`);
        }
    } finally {
        keys.secretKey.fill(0);
        wipeWords(words);
        vaultPassword = "";
    }
}

async function activateOwner(
    network: NetworkName,
    owner: Awaited<ReturnType<typeof deriveStateFromPrompt>>,
): Promise<void> {
    const client = createTonClient(network);
    const activeAddress = friendlyAddress(owner.walletAddress, network);
    const depositAddress = fundingAddress(owner.walletAddress, network);
    if (await isWalletDeployed(client, owner.walletAddress)) {
        console.log(`Wallet is already active: ${activeAddress}`);
        return;
    }
    if (!owner.walletAddress.equals(owner.state.address)) {
        throw new Error("Vault address and undeployed state do not match.");
    }

    const codeHash = await assertWalletTgConfigActive(network);
    console.log(`Verified TON config[-123] WalletTg rev00: ${codeHash}`);
    let balance = await getAddressBalance(client, owner.walletAddress);
    if (balance < SELF_DEPLOY_FUNDING) {
        console.log("\nSend TON only to this NON-BOUNCEABLE UQ address:");
        console.log(depositAddress);
        console.log("Do not fund the EQ address before activation: it will bounce the transfer.");
        console.log(`Required detected balance: ${fromNano(SELF_DEPLOY_FUNDING)} TON`);
        console.log(`Current balance: ${fromNano(balance)} TON`);
        console.log("Waiting up to 30 minutes. You can cancel with Ctrl+C and run activate later.");
        balance = await waitForBalance(
            client,
            owner.walletAddress,
            SELF_DEPLOY_FUNDING,
        );
    }
    console.log(`Funding detected: ${fromNano(balance)} TON. Sending signed self-deploy...`);
    const body = createSignedSendBody({
        subwalletId: owner.state.subwalletId,
        validUntil: Math.floor(Date.now() / 1000) + 300,
        seqno: 0,
    }, [{
        to: owner.walletAddress,
        value: 0n,
        bounce: false,
        sendMode: SEND_MODE_IGNORE_ERRORS,
    }], owner.keys.secretKey, "external");
    await sendWalletTgSelfDeploy(
        client,
        owner.walletAddress,
        owner.state.init,
        body,
    );
    console.log("Self-deploy sent. Waiting for confirmation...");
    await waitForDeployment(client, owner.walletAddress);
    const info = await getWalletTgInfo(client, owner.walletAddress);
    await assertOnChainKey(info.publicKey, owner.keys.publicKey);
    console.log(`WalletTg is active: ${activeAddress}`);
    console.log(`Revision: ${info.revision}; seqno: ${info.seqno}; balance: ${fromNano(info.balance)} TON`);
}

async function activateCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const owner = await deriveStateFromPrompt(network, "WalletTg mnemonic");
    try {
        await activateOwner(network, owner);
    } finally {
        wipeOwnerMaterial(owner);
    }
}

async function addressCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const material = await deriveStateFromPrompt(network, "WalletTg mnemonic");
    try {
        console.log(
            `Funding address (UQ, before activation): ${fundingAddress(material.walletAddress, network)}`,
        );
        console.log(
            `Wallet address (EQ, after activation): ${friendlyAddress(material.walletAddress, network)}`,
        );
    } finally {
        wipeOwnerMaterial(material);
    }
}

async function deployCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const amount = parseTon(oneOption(args, "--amount") ?? "0.05");
    const owner = await deriveStateFromPrompt(network, "New WalletTg mnemonic");
    let fundingWords: string[] = [];
    try {
        const client = createTonClient(network);
        const address = friendlyAddress(owner.walletAddress, network);
        if (await isWalletDeployed(client, owner.walletAddress)) {
            console.log(`Wallet is already deployed: ${address}`);
            return;
        }
        if (!owner.walletAddress.equals(owner.state.address)) {
            throw new Error(
                "Vault address and undeployed StateInit do not match. " +
                "Refusing to send a funding-wallet deployment.",
            );
        }
        console.log(`WalletTg address: ${address}`);
        console.log(`Deployment value: ${fromNano(amount)} TON`);
        const fundingMetadata = await readFundingMetadata(network);
        if (fundingMetadata !== null) {
            console.log(
                `Configured funding Wallet V4: ${friendlyAddress(fundingMetadata.address, network)}`,
            );
        }
        if (!(await confirm("Deploy using a separate funded Wallet V4?"))) {
            throw new Error("Cancelled");
        }
        if (fundingMetadata === null) {
            fundingWords = await readValidatedMnemonic("Funding Wallet V4 mnemonic");
        } else {
            fundingWords = await loadFundingMnemonic(network) ?? [];
            if (!(await mnemonicValidate(fundingWords))) {
                throw new Error("The encrypted funding store contains an invalid mnemonic.");
            }
            const storedKeys = await mnemonicToPrivateKey(fundingWords);
            try {
                const derived = WalletContractV4.create({
                    workchain: 0,
                    publicKey: storedKeys.publicKey,
                });
                if (!derived.address.equals(fundingMetadata.address)) {
                    throw new Error(
                        "Funding store metadata does not match its encrypted mnemonic.",
                    );
                }
            } finally {
                storedKeys.secretKey.fill(0);
            }
            console.log(`Using Windows DPAPI funding store: ${fundingMetadata.path}`);
        }
        await deployWalletTg(
            client,
            owner.state.init,
            owner.walletAddress,
            fundingWords,
            amount,
        );
        console.log("Deployment message sent. Waiting for confirmation...");
        await waitForDeployment(client, owner.walletAddress);
        console.log(`Deployed: ${address}`);
        try {
            const info = await getWalletTgInfo(client, owner.walletAddress);
            console.log(`WalletTg revision: ${info.revision}; seqno: ${info.seqno}`);
        } catch {
            console.warn(
                "The account was deployed, but WalletTg getters failed. " +
                "The network may not have config[-123] active.",
            );
        }
    } finally {
        wipeOwnerMaterial(owner);
        wipeWords(fundingWords);
    }
}

async function fundingSetupCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const existing = await readFundingMetadata(network);
    if (existing !== null) {
        throw new Error(
            `A funding store already exists: ${existing.path}. ` +
            "It was not overwritten.",
        );
    }

    const words = await readValidatedMnemonic("Funding Wallet V4 mnemonic");
    const keys = await mnemonicToPrivateKey(words);
    try {
        const wallet = WalletContractV4.create({
            workchain: 0,
            publicKey: keys.publicKey,
        });
        const client = createTonClient(network);
        const deployed = await isWalletDeployed(client, wallet.address);
        const balance = await getAddressBalance(client, wallet.address);
        console.log(`Funding Wallet V4: ${friendlyAddress(wallet.address, network)}`);
        console.log(`Deployed: ${deployed ? "yes" : "no"}`);
        console.log(`Balance: ${fromNano(balance)} TON`);
        if (!deployed || balance < toNano("0.06")) {
            throw new Error(
                "Funding Wallet V4 must be deployed and hold at least 0.06 TON. " +
                "Nothing was saved.",
            );
        }
        if (!(await confirm(
            "Encrypt this funding mnemonic with Windows DPAPI for automatic deploys?",
        ))) {
            throw new Error("Cancelled");
        }
        const saved = await saveFundingMnemonic(network, wallet.address, words);
        console.log(`Encrypted funding store created: ${saved.path}`);
        console.log("The file is bound to the current Windows user and ignored by Git.");
    } finally {
        keys.secretKey.fill(0);
        wipeWords(words);
    }
}

async function fundingStatusCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const metadata = await readFundingMetadata(network);
    if (metadata === null) {
        console.log(`No funding store configured for ${network}.`);
        return;
    }
    const client = createTonClient(network);
    const deployed = await isWalletDeployed(client, metadata.address);
    const balance = await getAddressBalance(client, metadata.address);
    console.log(`Store: ${metadata.path}`);
    console.log(`Network: ${network}`);
    console.log(`Funding Wallet V4: ${friendlyAddress(metadata.address, network)}`);
    console.log(`Created: ${metadata.createdAt}`);
    console.log(`Deployed: ${deployed ? "yes" : "no"}`);
    console.log(`Balance: ${fromNano(balance)} TON`);
}

function parseTransfer(value: string): TransferRequest {
    const separator = value.lastIndexOf(",");
    if (separator < 1) {
        throw new Error("Use --transfer ADDRESS,TON_AMOUNT");
    }
    return {
        to: Address.parse(value.slice(0, separator)),
        value: parseTon(value.slice(separator + 1)),
    };
}

async function sendCommand(args: ParsedArgs, bulk: boolean): Promise<void> {
    const network = parseNetwork(args);
    const channel = parseChannel(args);
    const relayerWords: string[] = [];
    let transfers: TransferRequest[];
    if (bulk) {
        const values = args.options.get("--transfer") ?? [];
        transfers = values.map(parseTransfer);
        if (transfers.length < 2) {
            throw new Error("send-bulk requires at least two --transfer values.");
        }
    } else {
        const transferComment = oneOption(args, "--comment");
        transfers = [{
            to: Address.parse(oneOption(args, "--to", true) as string),
            value: parseTon(oneOption(args, "--amount", true) as string),
            ...(transferComment === undefined
                ? {}
                : { comment: transferComment }),
        }];
    }

    const owner = await deriveStateFromPrompt(network, "WalletTg mnemonic");
    try {
        const client = createTonClient(network);
        const explicitAddress = oneOption(args, "--address");
        const walletAddress = explicitAddress === undefined
            ? owner.walletAddress
            : Address.parse(explicitAddress);
        const info = await getWalletTgInfo(client, walletAddress);
        await assertOnChainKey(info.publicKey, owner.keys.publicKey);
        const total = transfers.reduce((sum, item) => sum + item.value, 0n);
        console.log(`From: ${friendlyAddress(walletAddress, network)}`);
        console.log(`Signed channel: ${channel}`);
        console.log(`Messages: ${transfers.length}; total: ${fromNano(total)} TON`);
        for (const transfer of transfers) {
            console.log(`  ${friendlyAddress(transfer.to, network)}  ${fromNano(transfer.value)} TON`);
        }
        if (!(await confirm("Sign and broadcast this request?"))) {
            throw new Error("Cancelled");
        }
        const body = createSignedSendBody({
            subwalletId: info.subwalletId,
            validUntil: Math.floor(Date.now() / 1000) + 300,
            seqno: info.seqno,
        }, transfers, owner.keys.secretKey, channel);
        await broadcastSignedBody(
            args,
            channel,
            client,
            walletAddress,
            body,
            relayerWords,
        );
        console.log("Signed request sent. Waiting for seqno...");
        await waitForSeqno(client, walletAddress, info.seqno);
        console.log("Confirmed.");
    } finally {
        wipeOwnerMaterial(owner);
        wipeWords(relayerWords);
        transfers = [];
    }
}

async function rotateKeyCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const channel = parseChannel(args);
    const relayerWords: string[] = [];
    const current = await deriveStateFromPrompt(network, "Current WalletTg mnemonic");
    const newWords = await mnemonicNew(24);
    const newKeys = await mnemonicToPrivateKey(newWords);
    try {
        const client = createTonClient(network);
        const explicitAddress = oneOption(args, "--address");
        const walletAddress = explicitAddress === undefined
            ? current.walletAddress
            : Address.parse(explicitAddress);
        const info = await getWalletTgInfo(client, walletAddress);
        await assertOnChainKey(info.publicKey, current.keys.publicKey);
        await revealMnemonicOnce(newWords, "NEW WALLET TG RECOVERY PHRASE");
        console.log(`Wallet: ${friendlyAddress(walletAddress, network)}`);
        console.log(`Signed channel: ${channel}`);
        console.log("After confirmation, the old mnemonic will no longer authorize requests.");
        if (!(await confirm("Rotate the WalletTg public key now?"))) {
            throw new Error("Cancelled");
        }
        const body = createSignedChangeKeyBody({
            subwalletId: info.subwalletId,
            validUntil: Math.floor(Date.now() / 1000) + 300,
            seqno: info.seqno,
        }, walletAddress, current.keys.secretKey, newKeys.publicKey, newKeys.secretKey, channel);
        await broadcastSignedBody(
            args,
            channel,
            client,
            walletAddress,
            body,
            relayerWords,
        );
        console.log("Rotation request sent. Waiting for seqno...");
        await waitForSeqno(client, walletAddress, info.seqno);
        const updated = await getWalletTgInfo(client, walletAddress);
        await assertOnChainKey(updated.publicKey, newKeys.publicKey);
        if (current.vaultPassword !== null) {
            try {
                const updatedVault = await saveWalletVault(
                    network,
                    walletAddress,
                    newKeys.publicKey,
                    newWords,
                    current.vaultPassword,
                    true,
                );
                console.log(`Encrypted vault updated: ${updatedVault.path}`);
            } catch (error) {
                throw new Error(
                    "The on-chain key rotation succeeded, but the local vault update failed. " +
                    "The old vault can no longer authorize this wallet. Preserve the new paper " +
                    "seed and restore the vault before making another transaction.",
                    { cause: error },
                );
            }
        }
        console.log("Public key rotation confirmed. Use only the new paper backup.");
    } finally {
        wipeOwnerMaterial(current);
        newKeys.secretKey.fill(0);
        wipeWords(newWords);
        wipeWords(relayerWords);
    }
}

async function infoCommand(args: ParsedArgs): Promise<void> {
    const network = parseNetwork(args);
    const address = Address.parse(oneOption(args, "--address", true) as string);
    const client = createTonClient(network);
    const info = await getWalletTgInfo(client, address);
    console.log(`Address: ${friendlyAddress(address, network)}`);
    console.log(`Balance: ${fromNano(info.balance)} TON`);
    console.log(`Revision: ${info.revision}`);
    console.log(`Seqno: ${info.seqno}`);
    console.log(`Subwallet ID: 0x${info.subwalletId.toString(16)}`);
    console.log(`Public key: ${info.publicKey.toString(16).padStart(64, "0")}`);
}

function printHelp(): void {
    console.log(`WalletTg Safe CLI

Usage:
  npm run wallet -- create [--network testnet|mainnet]
  npm run wallet -- address [--network testnet|mainnet]
  npm run wallet -- activate [--network testnet|mainnet]
  npm run wallet -- deploy [--network testnet|mainnet] [--amount 0.05]
  npm run wallet -- funding-setup [--network testnet|mainnet]
  npm run wallet -- funding-status [--network testnet|mainnet]
  npm run wallet -- send --network testnet [--channel external|internal] [--address WALLET] --to ADDRESS --amount 0.1
  npm run wallet -- send-bulk --network testnet [--channel external|internal] [--address WALLET] --transfer ADDRESS,0.1 --transfer ADDRESS,0.2
  npm run wallet -- rotate-key [--network testnet|mainnet] [--channel external|internal] [--address WALLET]
  npm run wallet -- info --network testnet --address ADDRESS

Running without a command is equivalent to create. New wallets are stored only
as an AES-256-GCM encrypted local vault and unlocked through a hidden password
prompt. Plaintext mnemonics are never accepted through arguments or environment.`);
}

async function main(): Promise<void> {
    process.umask(0o077);
    const args = parseArgs(process.argv.slice(2));
    switch (args.command) {
        case "create": await createCommand(args); break;
        case "address": await addressCommand(args); break;
        case "activate": await activateCommand(args); break;
        case "deploy": await deployCommand(args); break;
        case "funding-setup": await fundingSetupCommand(args); break;
        case "funding-status": await fundingStatusCommand(args); break;
        case "send": await sendCommand(args, false); break;
        case "send-bulk": await sendCommand(args, true); break;
        case "rotate-key": await rotateKeyCommand(args); break;
        case "info": await infoCommand(args); break;
        case "help":
        case "--help":
        case "-h": printHelp(); break;
        default: throw new Error(`Unknown command: ${args.command}`);
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
});
