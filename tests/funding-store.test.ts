import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Address } from "@ton/core";

import {
    loadFundingMnemonic,
    readFundingMetadata,
    saveFundingMnemonic,
} from "../src/funding-store.js";

test("stores funding words only as Windows DPAPI ciphertext", async (context) => {
    if (process.platform !== "win32") {
        context.skip("Windows DPAPI is required");
        return;
    }

    const directory = await mkdtemp(join(tmpdir(), "wallet-tg-dpapi-test-"));
    const previousDirectory = process.env.WALLET_TG_STORE_DIRECTORY;
    process.env.WALLET_TG_STORE_DIRECTORY = directory;
    const words = Array.from({ length: 24 }, (_, index) => `testword${index + 1}`);
    const phrase = words.join(" ");
    const address = Address.parseRaw(`0:${"55".repeat(32)}`);

    try {
        const saved = await saveFundingMnemonic("testnet", address, words);
        const raw = await readFile(saved.path, "utf8");
        assert.doesNotMatch(raw, /testword/u);
        assert.doesNotMatch(raw, new RegExp(phrase, "u"));

        const metadata = await readFundingMetadata("testnet");
        assert.ok(metadata);
        assert.ok(metadata.address.equals(address));

        const decrypted = await loadFundingMnemonic("testnet");
        assert.deepEqual(decrypted, words);
        decrypted?.fill("");
    } finally {
        words.fill("");
        if (previousDirectory === undefined) {
            delete process.env.WALLET_TG_STORE_DIRECTORY;
        } else {
            process.env.WALLET_TG_STORE_DIRECTORY = previousDirectory;
        }
        await rm(directory, { recursive: true, force: true });
    }
});
