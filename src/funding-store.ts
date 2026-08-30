import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Address } from "@ton/core";

import { NetworkName } from "./constants.js";

const STORE_VERSION = 1;
const STORE_DIRECTORY = ".wallet-tg";

interface FundingStoreFile {
    version: number;
    protection: "windows-dpapi-current-user";
    network: NetworkName;
    address: string;
    createdAt: string;
    ciphertext: string;
}

export interface FundingStoreMetadata {
    path: string;
    network: NetworkName;
    address: Address;
    createdAt: string;
}

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Convert]::ToBase64String($protected))
} finally {
    if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    $plain = $null
}
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$ciphertext = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($ciphertext)
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
} finally {
    if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
}
`;

function storeDirectory(): string {
    const override = process.env.WALLET_TG_STORE_DIRECTORY?.trim();
    return override === undefined || override.length === 0
        ? join(process.cwd(), STORE_DIRECTORY)
        : resolve(override);
}

function storePath(network: NetworkName): string {
    return join(storeDirectory(), `funding-${network}.dpapi.json`);
}

async function runDpapi(script: string, input: Buffer): Promise<Buffer> {
    if (process.platform !== "win32") {
        input.fill(0);
        throw new Error("The funding store currently requires Windows DPAPI.");
    }

    const encodedScriptBuffer = Buffer.from(script, "utf16le");
    const encodedScript = encodedScriptBuffer.toString("base64");
    encodedScriptBuffer.fill(0);

    return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        const output: Buffer[] = [];
        const errors: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
        child.once("error", (error) => {
            input.fill(0);
            reject(error);
        });
        child.once("close", (code) => {
            input.fill(0);
            const stderr = Buffer.concat(errors);
            try {
                if (code !== 0) {
                    const message = stderr.toString("utf8").trim();
                    reject(new Error(
                        `Windows DPAPI operation failed${message ? `: ${message}` : ""}`,
                    ));
                    return;
                }
                resolve(Buffer.concat(output));
            } finally {
                stderr.fill(0);
                for (const chunk of errors) chunk.fill(0);
                for (const chunk of output) chunk.fill(0);
            }
        });
        child.stdin.end(input);
    });
}

function parseStore(contents: string, expectedNetwork: NetworkName): FundingStoreFile {
    const parsed = JSON.parse(contents) as Partial<FundingStoreFile>;
    if (
        parsed.version !== STORE_VERSION ||
        parsed.protection !== "windows-dpapi-current-user" ||
        parsed.network !== expectedNetwork ||
        typeof parsed.address !== "string" ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.ciphertext !== "string" ||
        parsed.ciphertext.length === 0
    ) {
        throw new Error("Invalid or unsupported funding store file.");
    }
    Address.parse(parsed.address);
    return parsed as FundingStoreFile;
}

export async function fundingStoreExists(network: NetworkName): Promise<boolean> {
    try {
        return (await stat(storePath(network))).isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export async function saveFundingMnemonic(
    network: NetworkName,
    address: Address,
    words: readonly string[],
): Promise<FundingStoreMetadata> {
    if (words.length !== 24) {
        throw new Error("Funding mnemonic must contain exactly 24 words.");
    }
    const protectedOutput = await runDpapi(
        PROTECT_SCRIPT,
        Buffer.from(words.join(" "), "utf8"),
    );
    let ciphertext: string;
    try {
        ciphertext = protectedOutput.toString("utf8").trim();
    } finally {
        protectedOutput.fill(0);
    }
    if (ciphertext.length === 0) {
        throw new Error("Windows DPAPI returned an empty ciphertext.");
    }

    const directory = storeDirectory();
    const path = storePath(network);
    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    const createdAt = new Date().toISOString();
    const data: FundingStoreFile = {
        version: STORE_VERSION,
        protection: "windows-dpapi-current-user",
        network,
        address: address.toRawString(),
        createdAt,
        ciphertext,
    };

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    return { path, network, address, createdAt };
}

export async function readFundingMetadata(
    network: NetworkName,
): Promise<FundingStoreMetadata | null> {
    if (!(await fundingStoreExists(network))) return null;
    const path = storePath(network);
    const stored = parseStore(await readFile(path, "utf8"), network);
    return {
        path,
        network,
        address: Address.parse(stored.address),
        createdAt: stored.createdAt,
    };
}

export async function loadFundingMnemonic(
    network: NetworkName,
): Promise<string[] | null> {
    if (!(await fundingStoreExists(network))) return null;
    const stored = parseStore(await readFile(storePath(network), "utf8"), network);
    const plaintext = await runDpapi(
        UNPROTECT_SCRIPT,
        Buffer.from(stored.ciphertext, "utf8"),
    );
    try {
        const words = plaintext.toString("utf8").trim().toLowerCase().split(/\s+/u);
        if (words.length !== 24) {
            words.fill("");
            throw new Error("Decrypted funding mnemonic has an invalid length.");
        }
        return words;
    } finally {
        plaintext.fill(0);
    }
}
