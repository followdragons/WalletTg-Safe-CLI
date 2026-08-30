import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    scrypt,
} from "node:crypto";
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { Address } from "@ton/core";

import { NetworkName } from "./constants.js";

const VAULT_VERSION = 1;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

interface WalletVaultFile {
    version: number;
    kind: "wallet-tg-seed-vault";
    network: NetworkName;
    address: string;
    publicKey: string;
    createdAt: string;
    kdf: {
        name: "scrypt";
        salt: string;
        N: number;
        r: number;
        p: number;
    };
    cipher: {
        name: "aes-256-gcm";
        iv: string;
        authTag: string;
        ciphertext: string;
    };
}

export interface WalletVaultMetadata {
    path: string;
    network: NetworkName;
    address: Address;
    publicKey: Buffer;
    createdAt: string;
}

function storeDirectory(): string {
    const override = process.env.WALLET_TG_STORE_DIRECTORY?.trim();
    return override === undefined || override.length === 0
        ? join(process.cwd(), ".wallet-tg")
        : resolve(override);
}

function vaultPath(network: NetworkName): string {
    return join(storeDirectory(), `wallet-${network}.vault.json`);
}

function aadFor(stored: Omit<WalletVaultFile, "cipher">): Buffer {
    return Buffer.from(JSON.stringify(stored), "utf8");
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    const passwordBuffer = Buffer.from(password, "utf8");
    try {
        return await new Promise<Buffer>((resolvePromise, reject) => {
            scrypt(passwordBuffer, salt, 32, {
                N: SCRYPT_N,
                r: SCRYPT_R,
                p: SCRYPT_P,
                maxmem: SCRYPT_MAXMEM,
            }, (error, key) => {
                if (error) reject(error);
                else resolvePromise(key);
            });
        });
    } finally {
        passwordBuffer.fill(0);
    }
}

function parseVault(contents: string, network: NetworkName): WalletVaultFile {
    const parsed = JSON.parse(contents) as Partial<WalletVaultFile>;
    if (
        parsed.version !== VAULT_VERSION ||
        parsed.kind !== "wallet-tg-seed-vault" ||
        parsed.network !== network ||
        typeof parsed.address !== "string" ||
        typeof parsed.publicKey !== "string" ||
        !/^[0-9a-f]{64}$/u.test(parsed.publicKey) ||
        typeof parsed.createdAt !== "string" ||
        parsed.kdf?.name !== "scrypt" ||
        parsed.kdf.N !== SCRYPT_N ||
        parsed.kdf.r !== SCRYPT_R ||
        parsed.kdf.p !== SCRYPT_P ||
        typeof parsed.kdf.salt !== "string" ||
        parsed.cipher?.name !== "aes-256-gcm" ||
        typeof parsed.cipher.iv !== "string" ||
        typeof parsed.cipher.authTag !== "string" ||
        typeof parsed.cipher.ciphertext !== "string"
    ) {
        throw new Error("Invalid or unsupported WalletTg vault file.");
    }
    Address.parse(parsed.address);
    return parsed as WalletVaultFile;
}

async function exists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export function generateVaultPassword(): string {
    const entropy = randomBytes(32);
    try {
        return entropy.toString("base64url");
    } finally {
        entropy.fill(0);
    }
}

export async function walletVaultExists(network: NetworkName): Promise<boolean> {
    return await exists(vaultPath(network));
}

export async function saveWalletVault(
    network: NetworkName,
    address: Address,
    publicKey: Buffer,
    words: readonly string[],
    password: string,
    replace = false,
): Promise<WalletVaultMetadata> {
    if (publicKey.length !== 32 || words.length !== 24 || password.length < 32) {
        throw new Error("Invalid WalletTg vault material.");
    }
    const path = vaultPath(network);
    if (!replace && await exists(path)) {
        throw new Error(`WalletTg vault already exists: ${path}`);
    }

    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const createdAt = new Date().toISOString();
    const header = {
        version: VAULT_VERSION,
        kind: "wallet-tg-seed-vault" as const,
        network,
        address: address.toRawString(),
        publicKey: publicKey.toString("hex"),
        createdAt,
        kdf: {
            name: "scrypt" as const,
            salt: salt.toString("base64"),
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
        },
    };
    const aad = aadFor(header);
    const key = await deriveKey(password, salt);
    const plaintext = Buffer.from(JSON.stringify({ mnemonic: words.join(" ") }), "utf8");
    let ciphertext: Buffer;
    let authTag: Buffer;
    try {
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(aad);
        ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        authTag = cipher.getAuthTag();
    } finally {
        key.fill(0);
        plaintext.fill(0);
        aad.fill(0);
        salt.fill(0);
    }

    try {
        const stored: WalletVaultFile = {
            ...header,
            cipher: {
                name: "aes-256-gcm",
                iv: iv.toString("base64"),
                authTag: authTag.toString("base64"),
                ciphertext: ciphertext.toString("base64"),
            },
        };
        const directory = storeDirectory();
        const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
        const backupPath = `${path}.backup-${process.pid}-${Date.now()}`;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });

        let backedUp = false;
        try {
            if (replace && await exists(path)) {
                await rename(path, backupPath);
                backedUp = true;
            }
            await rename(temporaryPath, path);
            if (backedUp) await rm(backupPath, { force: true });
        } catch (error) {
            await rm(temporaryPath, { force: true });
            if (backedUp && !(await exists(path))) {
                await rename(backupPath, path);
            }
            throw error;
        }
        await chmod(path, 0o600);
        return { path, network, address, publicKey: Buffer.from(publicKey), createdAt };
    } finally {
        iv.fill(0);
        ciphertext.fill(0);
        authTag.fill(0);
    }
}

export async function readWalletVaultMetadata(
    network: NetworkName,
): Promise<WalletVaultMetadata | null> {
    const path = vaultPath(network);
    if (!(await exists(path))) return null;
    const stored = parseVault(await readFile(path, "utf8"), network);
    return {
        path,
        network,
        address: Address.parse(stored.address),
        publicKey: Buffer.from(stored.publicKey, "hex"),
        createdAt: stored.createdAt,
    };
}

export async function loadWalletMnemonic(
    network: NetworkName,
    password: string,
): Promise<string[]> {
    const path = vaultPath(network);
    const stored = parseVault(await readFile(path, "utf8"), network);
    const { cipher, ...header } = stored;
    const salt = Buffer.from(stored.kdf.salt, "base64");
    const iv = Buffer.from(cipher.iv, "base64");
    const authTag = Buffer.from(cipher.authTag, "base64");
    const ciphertext = Buffer.from(cipher.ciphertext, "base64");
    const aad = aadFor(header);
    const key = await deriveKey(password, salt);
    let plaintext: Buffer | null = null;
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const decoded = JSON.parse(plaintext.toString("utf8")) as { mnemonic?: unknown };
        if (typeof decoded.mnemonic !== "string") {
            throw new Error("WalletTg vault plaintext is invalid.");
        }
        const words = decoded.mnemonic.trim().toLowerCase().split(/\s+/u);
        if (words.length !== 24) {
            words.fill("");
            throw new Error("WalletTg vault mnemonic has an invalid length.");
        }
        return words;
    } catch (error) {
        if (error instanceof Error && /authenticate data|bad decrypt/iu.test(error.message)) {
            throw new Error("Wrong vault password or corrupted WalletTg vault.");
        }
        throw error;
    } finally {
        key.fill(0);
        salt.fill(0);
        iv.fill(0);
        authTag.fill(0);
        ciphertext.fill(0);
        aad.fill(0);
        plaintext?.fill(0);
    }
}
