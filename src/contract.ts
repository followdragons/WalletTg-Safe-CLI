import { createHash } from "node:crypto";

import {
    Address,
    beginCell,
    Builder,
    Cell,
    comment,
    contractAddress,
    internal,
    SendMode,
    StateInit,
    storeMessageRelaxed,
    toNano,
} from "@ton/core";
import { sign } from "@ton/crypto";

import {
    DEFAULT_EXTERNAL_SEND_MODE,
    DEFAULT_SUBWALLET_ID,
    KEY_ROTATION_TAG,
    NetworkName,
    OP,
    STORAGE_REVISION,
    TRAMPOLINE_BOC_BASE64,
    TRAMPOLINE_BOC_SHA256,
} from "./constants.js";

export interface SeqnoHeader {
    subwalletId: number;
    validUntil: number;
    seqno: number;
}

export interface TransferRequest {
    to: Address;
    value: bigint;
    bounce?: boolean;
    comment?: string;
    sendMode?: number;
}

export interface MessageToSend {
    sendMode: number;
    messageCell: Cell;
}

export type RequestChannel = "external" | "internal";

export interface WalletTgState {
    address: Address;
    code: Cell;
    data: Cell;
    init: StateInit;
    subwalletId: number;
}

export function publicKeyToUint256(publicKey: Buffer): bigint {
    if (publicKey.length !== 32) {
        throw new Error("An Ed25519 public key must contain 32 bytes.");
    }
    return BigInt(`0x${publicKey.toString("hex")}`);
}

export function loadVerifiedTrampolineCode(): Cell {
    const boc = Buffer.from(TRAMPOLINE_BOC_BASE64, "base64");
    const actualHash = createHash("sha256").update(boc).digest("hex");
    if (actualHash !== TRAMPOLINE_BOC_SHA256) {
        throw new Error("Embedded WalletTrampoline BOC checksum mismatch.");
    }
    const cells = Cell.fromBoc(boc);
    if (cells.length !== 1 || cells[0] === undefined) {
        throw new Error("Embedded WalletTrampoline BOC must contain one root cell.");
    }
    // Cell.fromBoc keeps a view into the source buffer. This BOC is public
    // contract code and must remain intact for the lifetime of the returned
    // Cell; wiping it would silently serialize a different StateInit.
    return cells[0];
}

export function createWalletTgState(
    publicKey: Buffer,
    network: NetworkName,
    subwalletId = DEFAULT_SUBWALLET_ID[network],
    workchain = 0,
): WalletTgState {
    const code = loadVerifiedTrampolineCode();
    const data = beginCell()
        .storeUint(STORAGE_REVISION, 8)
        .storeUint(0, 32)
        .storeUint(subwalletId, 32)
        .storeUint(publicKeyToUint256(publicKey), 256)
        .endCell();
    const init = { code, data } satisfies StateInit;
    return {
        address: contractAddress(workchain, init),
        code,
        data,
        init,
        subwalletId,
    };
}

export function createMessageToSend(request: TransferRequest): MessageToSend {
    const body = request.comment === undefined
        ? Cell.EMPTY
        : comment(request.comment);
    const relaxedMessage = internal({
        to: request.to,
        value: request.value,
        bounce: request.bounce ?? false,
        body,
    });
    const messageCell = beginCell()
        .store(storeMessageRelaxed(relaxedMessage))
        .endCell();
    return {
        sendMode: request.sendMode ?? DEFAULT_EXTERNAL_SEND_MODE,
        messageCell,
    };
}

function storeHeader(builder: Builder, header: SeqnoHeader): Builder {
    return builder
        .storeUint(header.subwalletId, 32)
        .storeUint(header.validUntil, 32)
        .storeUint(header.seqno, 32);
}

function storeItem(builder: Builder, item: MessageToSend): Builder {
    return builder.storeUint(item.sendMode, 8).storeRef(item.messageCell);
}

function validateSendModes(
    items: readonly MessageToSend[],
    channel: RequestChannel,
): void {
    if (
        channel === "external" &&
        items.some((item) => (item.sendMode & SendMode.IGNORE_ERRORS) === 0)
    ) {
        throw new Error("External WalletTg messages require IGNORE_ERRORS send mode.");
    }
}

export function encodeTolkMessageArray(items: readonly MessageToSend[]): Cell {
    if (items.length < 1 || items.length > 255) {
        throw new Error("WalletTg bulk requests require 1 to 255 messages.");
    }

    const chunks: MessageToSend[][] = [];
    let offset = 0;
    while (items.length - offset > 4) {
        chunks.push(items.slice(offset, offset + 3));
        offset += 3;
    }
    chunks.push(items.slice(offset));

    let next: Cell | null = null;
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const chunk = chunks[index];
        if (chunk === undefined) {
            throw new Error("Invalid array chunk.");
        }
        let builder = beginCell().storeMaybeRef(next);
        for (const item of chunk) {
            builder = storeItem(builder, item);
        }
        next = builder.endCell();
    }

    if (next === null) {
        throw new Error("WalletTg message array cannot be empty.");
    }
    return beginCell().storeUint(items.length, 8).storeMaybeRef(next).endCell();
}

export function createSendRequest(
    header: SeqnoHeader,
    messages: readonly MessageToSend[],
    channel: RequestChannel = "external",
): Cell {
    validateSendModes(messages, channel);
    if (messages.length === 1) {
        const message = messages[0];
        if (message === undefined) {
            throw new Error("Missing message.");
        }
        return storeItem(
            storeHeader(beginCell().storeUint(
                channel === "external" ? OP.sendOneExternal : OP.sendOneInternal,
                32,
            ), header),
            message,
        ).endCell();
    }

    const encoded = encodeTolkMessageArray(messages);
    return storeHeader(
        beginCell().storeUint(
            channel === "external" ? OP.sendBulkExternal : OP.sendBulkInternal,
            32,
        ),
        header,
    ).storeSlice(encoded.beginParse()).endCell();
}

export function signRequest(request: Cell, secretKey: Buffer): Cell {
    const signature = sign(request.hash(), secretKey);
    try {
        return beginCell()
            .storeBuffer(signature)
            .storeSlice(request.beginParse())
            .endCell();
    } finally {
        signature.fill(0);
    }
}

export function createSignedSendBody(
    header: SeqnoHeader,
    transfers: readonly TransferRequest[],
    secretKey: Buffer,
    channel: RequestChannel = "external",
): Cell {
    const messages = transfers.map(createMessageToSend);
    return signRequest(createSendRequest(header, messages, channel), secretKey);
}

export function createRotationProof(
    walletAddress: Address,
    newSecretKey: Buffer,
): Buffer {
    const payload = beginCell()
        .storeUint(KEY_ROTATION_TAG, 96)
        .storeInt(walletAddress.workChain, 8)
        .storeBuffer(walletAddress.hash)
        .endCell();
    return sign(payload.hash(), newSecretKey);
}

export function createChangeKeyRequest(
    header: SeqnoHeader,
    newPublicKey: Buffer,
    rotationProof: Buffer,
    channel: RequestChannel = "external",
): Cell {
    if (newPublicKey.length !== 32 || rotationProof.length !== 64) {
        throw new Error("Invalid key rotation material.");
    }
    const proofCell = beginCell().storeBuffer(rotationProof).endCell();
    return storeHeader(
        beginCell().storeUint(
            channel === "external"
                ? OP.changePublicKeyExternal
                : OP.changePublicKeyInternal,
            32,
        ),
        header,
    )
        .storeBuffer(newPublicKey)
        .storeRef(proofCell)
        .endCell();
}

export function createSignedChangeKeyBody(
    header: SeqnoHeader,
    walletAddress: Address,
    currentSecretKey: Buffer,
    newPublicKey: Buffer,
    newSecretKey: Buffer,
    channel: RequestChannel = "external",
): Cell {
    const proof = createRotationProof(walletAddress, newSecretKey);
    try {
        const request = createChangeKeyRequest(header, newPublicKey, proof, channel);
        return signRequest(request, currentSecretKey);
    } finally {
        proof.fill(0);
    }
}

export function parseTon(value: string): bigint {
    if (!/^\d+(?:\.\d{1,9})?$/u.test(value)) {
        throw new Error(`Invalid TON amount: ${value}`);
    }
    return toNano(value);
}
