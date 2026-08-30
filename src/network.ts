import { Address, beginCell, Cell, internal, StateInit, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { loadConfigParamById, TonClient, WalletContractV4 } from "@ton/ton";

import {
    NetworkName,
    networkEndpoint,
    networkRestEndpoint,
    WALLET_TG_REV00_CODE_HASH,
} from "./constants.js";

const KEYLESS_REQUEST_INTERVAL_MS = 1_150;
const AUTHENTICATED_REQUEST_INTERVAL_MS = 120;
const MAX_RATE_LIMIT_RETRIES = 5;

let rpcQueue: Promise<void> = Promise.resolve();
let lastRpcStartedAt = 0;

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isRateLimitError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const candidate = error as {
        message?: unknown;
        status?: unknown;
        response?: { status?: unknown };
    };
    return candidate.status === 429 ||
        candidate.response?.status === 429 ||
        (typeof candidate.message === "string" && /\b429\b/u.test(candidate.message));
}

export function describeToncenterError(error: unknown): string {
    if (!(error instanceof Error)) {
        return "Unknown TON Center error";
    }
    const candidate = error as Error & {
        status?: unknown;
        response?: {
            status?: unknown;
            data?: unknown;
        };
    };
    const status = candidate.response?.status ?? candidate.status;
    const data = candidate.response?.data;
    const details: string[] = [];

    if (typeof status === "number") {
        details.push(`HTTP ${status}`);
    }
    if (typeof data === "string" && data.trim().length > 0) {
        details.push(data.trim().slice(0, 500));
    } else if (typeof data === "object" && data !== null) {
        const response = data as {
            code?: unknown;
            error?: unknown;
            message?: unknown;
        };
        if (typeof response.code === "number" || typeof response.code === "string") {
            details.push(`code ${String(response.code)}`);
        }
        if (typeof response.error === "string") {
            details.push(response.error.slice(0, 500));
        } else if (
            typeof response.error === "object" &&
            response.error !== null
        ) {
            const nested = response.error as { code?: unknown; message?: unknown };
            if (typeof nested.code === "number" || typeof nested.code === "string") {
                details.push(`RPC ${String(nested.code)}`);
            }
            if (typeof nested.message === "string") {
                details.push(nested.message.slice(0, 500));
            }
        }
        if (typeof response.message === "string") {
            details.push(response.message.slice(0, 500));
        }
    }
    if (details.length === 0) {
        details.push(error.message);
    }
    return [...new Set(details)].join(": ");
}

/**
 * Toncenter key-less access is limited to roughly one request per second.
 * Serialize all RPC calls and retry only explicit HTTP 429 responses.
 */
export async function toncenterRequest<T>(operation: () => Promise<T>): Promise<T> {
    const queued = rpcQueue.then(async () => {
        const hasApiKey = Boolean(process.env.TONCENTER_API_KEY?.trim());
        const interval = hasApiKey
            ? AUTHENTICATED_REQUEST_INTERVAL_MS
            : KEYLESS_REQUEST_INTERVAL_MS;

        for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
            const waitForSlot = Math.max(
                0,
                lastRpcStartedAt + interval - Date.now(),
            );
            if (waitForSlot > 0) {
                await sleep(waitForSlot);
            }
            lastRpcStartedAt = Date.now();

            try {
                return await operation();
            } catch (error) {
                if (!isRateLimitError(error)) {
                    throw error;
                }
                if (attempt === MAX_RATE_LIMIT_RETRIES) {
                    throw new Error(
                        "TON Center rate limit persisted after automatic retries. " +
                        "Wait a minute or set TONCENTER_API_KEY for this PowerShell session.",
                        { cause: error },
                    );
                }
                await sleep(1_500 * (attempt + 1));
            }
        }
        throw new Error("Unreachable TON Center retry state.");
    });

    rpcQueue = queued.then(() => undefined, () => undefined);
    return await queued;
}

export interface WalletTgInfo {
    balance: bigint;
    revision: number;
    seqno: number;
    subwalletId: number;
    publicKey: bigint;
}

export function createTonClient(network: NetworkName): TonClient {
    // The API key is optional and is not sensitive wallet material.
    const apiKey = process.env.TONCENTER_API_KEY?.trim() || undefined;
    return new TonClient({
        endpoint: networkEndpoint(network),
        ...(apiKey === undefined ? {} : { apiKey }),
    });
}

export async function getWalletTgInfo(
    client: TonClient,
    address: Address,
): Promise<WalletTgInfo> {
    const balance = await toncenterRequest(() => client.getBalance(address));
    const revisionResult = await toncenterRequest(
        () => client.runMethod(address, "revision"),
    );
    const seqnoResult = await toncenterRequest(
        () => client.runMethod(address, "seqno"),
    );
    const subwalletResult = await toncenterRequest(
        () => client.runMethod(address, "get_subwallet_id"),
    );
    const keyResult = await toncenterRequest(
        () => client.runMethod(address, "get_public_key"),
    );

    return {
        balance,
        revision: revisionResult.stack.readNumber(),
        seqno: seqnoResult.stack.readNumber(),
        subwalletId: subwalletResult.stack.readNumber(),
        publicKey: keyResult.stack.readBigNumber(),
    };
}

export async function sendWalletTgExternal(
    client: TonClient,
    address: Address,
    body: Cell,
): Promise<void> {
    await toncenterRequest(() => client.provider(address).external(body));
}

export async function isWalletDeployed(
    client: TonClient,
    address: Address,
): Promise<boolean> {
    return await toncenterRequest(() => client.isContractDeployed(address));
}

export async function getAddressBalance(
    client: TonClient,
    address: Address,
): Promise<bigint> {
    return await toncenterRequest(() => client.getBalance(address));
}

export async function assertWalletTgConfigActive(
    network: NetworkName,
): Promise<string> {
    const response = await toncenterRequest(async () => {
        const apiKey = process.env.TONCENTER_API_KEY?.trim();
        const result = await fetch(
            `${networkRestEndpoint(network)}/getConfigAll?mode=0`,
            { headers: apiKey ? { "X-API-Key": apiKey } : {} },
        );
        if (!result.ok) {
            const error = new Error(`TON Center config request failed with HTTP ${result.status}`) as
                Error & { status: number };
            error.status = result.status;
            throw error;
        }
        return await result.json() as {
            ok?: boolean;
            result?: { config?: { bytes?: string } };
        };
    });
    const configBytes = response.result?.config?.bytes;
    if (response.ok !== true || typeof configBytes !== "string") {
        throw new Error("TON Center returned an invalid full-config response.");
    }
    const walletCode = loadConfigParamById(configBytes, -123);
    if (walletCode === undefined) {
        throw new Error(
            `TON config[-123] is not active in ${network}. Self-deploy is blocked.`,
        );
    }
    const codeHash = walletCode.hash().toString("hex");
    if (codeHash !== WALLET_TG_REV00_CODE_HASH) {
        throw new Error(
            `TON config[-123] has an unrecognized code hash ${codeHash}. ` +
            "Update and audit the CLI before self-deploying funds.",
        );
    }
    return codeHash;
}

export async function waitForBalance(
    client: TonClient,
    address: Address,
    requiredBalance: bigint,
    timeoutMs = 30 * 60 * 1000,
): Promise<bigint> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const balance = await getAddressBalance(client, address);
        if (balance >= requiredBalance) return balance;
        await sleep(5_000);
    }
    throw new Error(`Funding was not detected for ${address.toString()} before timeout.`);
}

export async function sendWalletTgSelfDeploy(
    client: TonClient,
    address: Address,
    init: StateInit,
    body: Cell,
): Promise<void> {
    try {
        await toncenterRequest(
            () => client.provider(address, init).external(body),
        );
    } catch (error) {
        await sleep(2_500);
        if (await isWalletDeployed(client, address)) {
            return;
        }
        throw new Error(
            `WalletTg self-deploy could not be confirmed: ${describeToncenterError(error)}`,
            { cause: error },
        );
    }
}

export async function sendWalletTgInternal(
    client: TonClient,
    address: Address,
    body: Cell,
    relayerMnemonic: string[],
    relayValue = toNano("0.05"),
): Promise<void> {
    const relayerKeys = await mnemonicToPrivateKey(relayerMnemonic);
    try {
        const relayerContract = WalletContractV4.create({
            workchain: 0,
            publicKey: relayerKeys.publicKey,
        });
        const relayer = client.open(relayerContract);
        if (!(await isWalletDeployed(client, relayer.address))) {
            throw new Error(`Relayer wallet is not deployed: ${relayer.address.toString()}`);
        }
        const balance = await toncenterRequest(() => relayer.getBalance());
        if (balance < relayValue + toNano("0.01")) {
            throw new Error("Relayer wallet balance is too low.");
        }
        const seqno = await toncenterRequest(() => relayer.getSeqno());
        const transfer = relayerContract.createTransfer({
            seqno,
            secretKey: relayerKeys.secretKey,
            messages: [internal({
                to: address,
                value: relayValue,
                bounce: true,
                body,
            })],
        });
        try {
            await toncenterRequest(
                () => client.provider(relayer.address).external(transfer),
            );
        } catch (error) {
            await sleep(2_500);
            const updatedSeqno = await toncenterRequest(() => relayer.getSeqno());
            if (updatedSeqno <= seqno) {
                throw new Error(
                    `Relayer Wallet V4 ${relayer.address.toString()} rejected the request: ` +
                    describeToncenterError(error),
                    { cause: error },
                );
            }
        }
    } finally {
        relayerKeys.secretKey.fill(0);
    }
}

export async function deployWalletTg(
    client: TonClient,
    init: StateInit,
    address: Address,
    fundingMnemonic: string[],
    amount = toNano("0.05"),
): Promise<void> {
    const fundingKeys = await mnemonicToPrivateKey(fundingMnemonic);
    try {
        const fundingContract = WalletContractV4.create({
            workchain: 0,
            publicKey: fundingKeys.publicKey,
        });
        const fundingWallet = client.open(fundingContract);
        if (!(await isWalletDeployed(client, fundingWallet.address))) {
            throw new Error(
                `Funding wallet is not deployed: ${fundingWallet.address.toString()}`,
            );
        }
        const balance = await toncenterRequest(() => fundingWallet.getBalance());
        if (balance < amount + toNano("0.01")) {
            throw new Error("Funding wallet balance is too low for deployment.");
        }
        const seqno = await toncenterRequest(() => fundingWallet.getSeqno());
        const transfer = fundingContract.createTransfer({
            seqno,
            secretKey: fundingKeys.secretKey,
            messages: [
                internal({
                    to: address,
                    value: amount,
                    bounce: false,
                    init,
                    body: beginCell().endCell(),
                }),
            ],
        });
        try {
            await toncenterRequest(
                () => client.provider(fundingWallet.address).external(transfer),
            );
        } catch (error) {
            // A gateway can return 5xx after accepting the BOC. Seqno is the
            // authoritative signal and avoids blindly sending a second transfer.
            await sleep(2_500);
            const updatedSeqno = await toncenterRequest(
                () => fundingWallet.getSeqno(),
            );
            if (updatedSeqno <= seqno) {
                throw new Error(
                    `Funding Wallet V4 ${fundingWallet.address.toString()} ` +
                    `did not accept the deployment transfer: ${describeToncenterError(error)}`,
                    { cause: error },
                );
            }
        }
    } finally {
        fundingKeys.secretKey.fill(0);
    }
}

export async function waitForDeployment(
    client: TonClient,
    address: Address,
    timeoutMs = 120_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isWalletDeployed(client, address)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`Deployment was not confirmed for ${address.toString()}.`);
}

export async function waitForSeqno(
    client: TonClient,
    address: Address,
    previousSeqno: number,
    timeoutMs = 120_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = await toncenterRequest(
                () => client.runMethod(address, "seqno"),
            );
            if (result.stack.readNumber() > previousSeqno) {
                return;
            }
        } catch {
            // The network may not have indexed the transaction yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error("WalletTg seqno did not change before the timeout.");
}
