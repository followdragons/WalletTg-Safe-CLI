import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Address, beginCell, Cell, toNano } from "@ton/core";
import { keyPairFromSeed, signVerify } from "@ton/crypto";

import {
    DEFAULT_SUBWALLET_ID,
    KEY_ROTATION_TAG,
    OP,
    SEND_MODE_IGNORE_ERRORS,
    TRAMPOLINE_BOC_BASE64,
    TRAMPOLINE_BOC_SHA256,
    WALLET_TG_REV00_CODE_HASH,
} from "../src/constants.js";
import {
    createChangeKeyRequest,
    createMessageToSend,
    createRotationProof,
    createSendRequest,
    createSignedSendBody,
    createWalletTgState,
    encodeTolkMessageArray,
    loadVerifiedTrampolineCode,
    signRequest,
} from "../src/contract.js";
import { describeToncenterError, isRateLimitError } from "../src/network.js";

test("uses the exact official 41-byte trampoline BOC", () => {
    const boc = Buffer.from(TRAMPOLINE_BOC_BASE64, "base64");
    assert.equal(boc.length, 41);
    assert.equal(createHash("sha256").update(boc).digest("hex"), TRAMPOLINE_BOC_SHA256);
    const expected = Cell.fromBoc(boc)[0] as Cell;
    const loaded = loadVerifiedTrampolineCode();
    assert.ok(loaded.equals(expected));
    assert.deepEqual(loaded.toBoc(), expected.toBoc());
    assert.deepEqual(
        loaded.beginParse().loadBuffer(24),
        expected.beginParse().loadBuffer(24),
    );
    assert.notEqual(loaded.beginParse().loadUintBig(192), 0n);
});

test("pins TON config[-123] to the official WalletTg rev00 code BOC", () => {
    const boc = readFileSync(new URL(
        "../tg-wallet-contract-reference/contracts/revisions-boc/WalletTg-rev00.boc",
        import.meta.url,
    ));
    const cells = Cell.fromBoc(boc);
    assert.equal(cells.length, 1);
    assert.equal(cells[0]?.hash().toString("hex"), WALLET_TG_REV00_CODE_HASH);
});

test("recognizes only explicit TON Center HTTP 429 failures", () => {
    assert.equal(isRateLimitError({ response: { status: 429 } }), true);
    assert.equal(isRateLimitError({ status: 429 }), true);
    assert.equal(isRateLimitError(new Error("Request failed with status code 429")), true);
    assert.equal(isRateLimitError({ response: { status: 500 } }), false);
    assert.equal(isRateLimitError(new Error("network timeout")), false);
});

test("reports safe TON Center response details without request configuration", () => {
    const error = new Error("Request failed") as Error & {
        response: { status: number; data: unknown };
        config: { data: string };
    };
    error.response = {
        status: 500,
        data: { code: 500, error: "external message was not accepted" },
    };
    error.config = { data: "SECRET_REQUEST_BOC" };
    const description = describeToncenterError(error);
    assert.match(description, /HTTP 500/u);
    assert.match(description, /external message was not accepted/u);
    assert.doesNotMatch(description, /SECRET_REQUEST_BOC/u);
});

test("encodes revision 00 storage in the documented field order", () => {
    const keys = keyPairFromSeed(Buffer.alloc(32, 7));
    const state = createWalletTgState(keys.publicKey, "testnet");
    const slice = state.data.beginParse();
    assert.equal(slice.loadUint(8), 0);
    assert.equal(slice.loadUint(32), 0);
    assert.equal(slice.loadUint(32), DEFAULT_SUBWALLET_ID.testnet);
    assert.equal(slice.loadBuffer(32).toString("hex"), keys.publicKey.toString("hex"));
    slice.endParse();
    keys.secretKey.fill(0);
});

test("encodes and signs the external one-message request", () => {
    const keys = keyPairFromSeed(Buffer.alloc(32, 11));
    const message = createMessageToSend({
        to: Address.parseRaw(`0:${"22".repeat(32)}`),
        value: toNano("0.25"),
    });
    const request = createSendRequest({
        subwalletId: DEFAULT_SUBWALLET_ID.testnet,
        validUntil: 2_000_000_000,
        seqno: 4,
    }, [message]);
    const requestSlice = request.beginParse();
    assert.equal(requestSlice.loadUint(32), OP.sendOneExternal);
    assert.equal(requestSlice.loadUint(32), DEFAULT_SUBWALLET_ID.testnet);
    assert.equal(requestSlice.loadUint(32), 2_000_000_000);
    assert.equal(requestSlice.loadUint(32), 4);
    assert.equal(requestSlice.loadUint(8), 3);
    assert.ok(requestSlice.loadRef().equals(message.messageCell));
    requestSlice.endParse();

    const signed = signRequest(request, keys.secretKey).beginParse();
    const signature = signed.loadBuffer(64);
    const reconstructed = beginCell().storeSlice(signed).endCell();
    assert.ok(signVerify(reconstructed.hash(), signature, keys.publicKey));
    signature.fill(0);
    keys.secretKey.fill(0);
});

test("builds a replay-safe zero-value request for funded self-deploy", () => {
    const keys = keyPairFromSeed(Buffer.alloc(32, 19));
    const wallet = createWalletTgState(keys.publicKey, "mainnet");
    const signed = createSignedSendBody({
        subwalletId: wallet.subwalletId,
        validUntil: 2_000_000_000,
        seqno: 0,
    }, [{
        to: wallet.address,
        value: 0n,
        bounce: false,
        sendMode: SEND_MODE_IGNORE_ERRORS,
    }], keys.secretKey).beginParse();
    const signature = signed.loadBuffer(64);
    const request = beginCell().storeSlice(signed).endCell();
    assert.ok(signVerify(request.hash(), signature, keys.publicKey));
    const requestSlice = request.beginParse();
    assert.equal(requestSlice.loadUint(32), OP.sendOneExternal);
    assert.equal(requestSlice.loadUint(32), wallet.subwalletId);
    assert.equal(requestSlice.loadUint(32), 2_000_000_000);
    assert.equal(requestSlice.loadUint(32), 0);
    assert.equal(requestSlice.loadUint(8), SEND_MODE_IGNORE_ERRORS);
    assert.equal(requestSlice.remainingRefs, 1);
    signature.fill(0);
    keys.secretKey.fill(0);
});

test("uses channel-separated opcodes to prevent relayer replay", () => {
    const message = createMessageToSend({
        to: Address.parseRaw(`0:${"44".repeat(32)}`),
        value: toNano("0.01"),
    });
    const header = {
        subwalletId: DEFAULT_SUBWALLET_ID.testnet,
        validUntil: 2_000_000_000,
        seqno: 0,
    };
    assert.equal(
        createSendRequest(header, [message], "external").beginParse().loadUint(32),
        OP.sendOneExternal,
    );
    assert.equal(
        createSendRequest(header, [message], "internal").beginParse().loadUint(32),
        OP.sendOneInternal,
    );
});

test("encodes standard Tolk arrays with 3 intermediate and 4 final items", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
        sendMode: 3,
        messageCell: beginCell().storeUint(index, 8).endCell(),
    }));
    const array = encodeTolkMessageArray(messages).beginParse();
    assert.equal(array.loadUint(8), 10);
    let head: Cell | null = array.loadMaybeRef();
    const decoded: Cell[] = [];
    const chunkSizes: number[] = [];
    while (head !== null) {
        const chunk = head.beginParse();
        head = chunk.loadMaybeRef();
        chunkSizes.push(chunk.remainingRefs);
        while (chunk.remainingRefs > 0) {
            assert.equal(chunk.loadUint(8), 3);
            decoded.push(chunk.loadRef());
        }
        chunk.endParse();
    }
    assert.deepEqual(chunkSizes, [3, 3, 4]);
    assert.deepEqual(
        decoded.map((cell) => cell.hash().toString("hex")),
        messages.map((message) => message.messageCell.hash().toString("hex")),
    );
});

test("builds a new-key proof and external rotation request", () => {
    const newKeys = keyPairFromSeed(Buffer.alloc(32, 31));
    const wallet = Address.parseRaw(`0:${"ab".repeat(32)}`);
    const proof = createRotationProof(wallet, newKeys.secretKey);
    const payload = beginCell()
        .storeUint(KEY_ROTATION_TAG, 96)
        .storeInt(wallet.workChain, 8)
        .storeBuffer(wallet.hash)
        .endCell();
    assert.ok(signVerify(payload.hash(), proof, newKeys.publicKey));

    const request = createChangeKeyRequest({
        subwalletId: DEFAULT_SUBWALLET_ID.mainnet,
        validUntil: 2_000_000_000,
        seqno: 9,
    }, newKeys.publicKey, proof).beginParse();
    assert.equal(request.loadUint(32), OP.changePublicKeyExternal);
    assert.equal(request.loadUint(32), DEFAULT_SUBWALLET_ID.mainnet);
    assert.equal(request.loadUint(32), 2_000_000_000);
    assert.equal(request.loadUint(32), 9);
    assert.equal(request.loadBuffer(32).toString("hex"), newKeys.publicKey.toString("hex"));
    assert.equal(request.loadRef().beginParse().loadBuffer(64).toString("hex"), proof.toString("hex"));
    request.endParse();

    proof.fill(0);
    newKeys.secretKey.fill(0);
});
