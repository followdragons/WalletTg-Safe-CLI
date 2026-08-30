export const TRAMPOLINE_BOC_BASE64 =
    "te6cckEBAQEAGgAAMP8AIJgh10mDCLnyQN+Ahfgz0O0eIO1T2WlCfjk=";

export const TRAMPOLINE_BOC_SHA256 =
    "19ec9e8bc64615da5edda931215dde125e7f9feda2178e558d4e4d2d71abf57f";

export const WALLET_TG_REV00_CODE_HASH =
    "6f177fd863213d7bd3b24a694b0b7efb7425721ed1d21490d052ae93276c4406";

export const STORAGE_REVISION = 0;

export const DEFAULT_SUBWALLET_ID = {
    mainnet: 0x7fff7f11,
    testnet: 0x7fff7ffd,
} as const;

export const OP = {
    sendOneInternal: 0x63896e74,
    sendOneExternal: 0x63896e75,
    sendBulkInternal: 0x73896e74,
    sendBulkExternal: 0x73896e75,
    changePublicKeyInternal: 0xfbba99c7,
    changePublicKeyExternal: 0xfbba99c8,
} as const;

export const KEY_ROTATION_TAG = 0x4b45595f524f544154494f4en;

export const SEND_MODE_PAY_GAS_SEPARATELY = 1;
export const SEND_MODE_IGNORE_ERRORS = 2;
export const DEFAULT_EXTERNAL_SEND_MODE =
    SEND_MODE_PAY_GAS_SEPARATELY | SEND_MODE_IGNORE_ERRORS;

export type NetworkName = "mainnet" | "testnet";

export function networkEndpoint(network: NetworkName): string {
    return network === "mainnet"
        ? "https://toncenter.com/api/v2/jsonRPC"
        : "https://testnet.toncenter.com/api/v2/jsonRPC";
}

export function networkRestEndpoint(network: NetworkName): string {
    return network === "mainnet"
        ? "https://toncenter.com/api/v2"
        : "https://testnet.toncenter.com/api/v2";
}
