import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Address } from "@ton/core";

import {
    generateVaultPassword,
    loadWalletMnemonic,
    readWalletVaultMetadata,
    saveWalletVault,
} from "../src/wallet-vault.js";

test("encrypts, authenticates, and atomically replaces a WalletTg seed vault", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-tg-vault-test-"));
    const previousDirectory = process.env.WALLET_TG_STORE_DIRECTORY;
    process.env.WALLET_TG_STORE_DIRECTORY = directory;
    const firstWords = Array.from({ length: 24 }, (_, index) => `firstword${index + 1}`);
    const secondWords = Array.from({ length: 24 }, (_, index) => `secondword${index + 1}`);
    let password = generateVaultPassword();
    const address = Address.parseRaw(`0:${"77".repeat(32)}`);
    const firstPublicKey = Buffer.alloc(32, 0x11);
    const secondPublicKey = Buffer.alloc(32, 0x22);

    try {
        assert.match(password, /^[A-Za-z0-9_-]{43}$/u);
        const saved = await saveWalletVault(
            "mainnet",
            address,
            firstPublicKey,
            firstWords,
            password,
        );
        const raw = await readFile(saved.path, "utf8");
        assert.doesNotMatch(raw, /firstword/u);
        assert.doesNotMatch(raw, new RegExp(password, "u"));

        const metadata = await readWalletVaultMetadata("mainnet");
        assert.ok(metadata);
        assert.ok(metadata.address.equals(address));
        assert.ok(metadata.publicKey.equals(firstPublicKey));
        assert.deepEqual(await loadWalletMnemonic("mainnet", password), firstWords);
        await assert.rejects(
            loadWalletMnemonic("mainnet", `${password}wrong`),
            /Wrong vault password or corrupted WalletTg vault/u,
        );

        await saveWalletVault(
            "mainnet",
            address,
            secondPublicKey,
            secondWords,
            password,
            true,
        );
        assert.deepEqual(await loadWalletMnemonic("mainnet", password), secondWords);
        const replacedMetadata = await readWalletVaultMetadata("mainnet");
        assert.ok(replacedMetadata?.publicKey.equals(secondPublicKey));
    } finally {
        firstWords.fill("");
        secondWords.fill("");
        firstPublicKey.fill(0);
        secondPublicKey.fill(0);
        password = "";
        if (previousDirectory === undefined) {
            delete process.env.WALLET_TG_STORE_DIRECTORY;
        } else {
            process.env.WALLET_TG_STORE_DIRECTORY = previousDirectory;
        }
        await rm(directory, { recursive: true, force: true });
    }
});
