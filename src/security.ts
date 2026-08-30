import { randomInt, timingSafeEqual } from "node:crypto";
import { stdin, stdout } from "node:process";

function requirePrivateTerminal(): void {
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new Error(
            "A private interactive terminal is required. " +
            "Seed phrases are never printed to redirected output.",
        );
    }
}

export async function promptHidden(prompt: string): Promise<string> {
    requirePrivateTerminal();

    return await new Promise<string>((resolve, reject) => {
        const chars: string[] = [];
        const wasRaw = stdin.isRaw;

        const cleanup = (): void => {
            stdin.off("data", onData);
            stdin.setRawMode(Boolean(wasRaw));
            stdin.pause();
        };

        const onData = (buffer: Buffer): void => {
            for (const byte of buffer) {
                if (byte === 3) {
                    cleanup();
                    stdout.write("\n");
                    reject(new Error("Cancelled"));
                    return;
                }

                if (byte === 13 || byte === 10) {
                    const value = chars.join("");
                    chars.fill("");
                    cleanup();
                    stdout.write("\n");
                    resolve(value);
                    return;
                }

                if (byte === 8 || byte === 127) {
                    if (chars.length > 0) {
                        chars.pop();
                        stdout.write("\b \b");
                    }
                    continue;
                }

                if (byte >= 32 && byte <= 126) {
                    chars.push(String.fromCharCode(byte));
                    stdout.write("*");
                }
            }
            buffer.fill(0);
        };

        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}

export async function promptVisible(prompt: string): Promise<string> {
    requirePrivateTerminal();

    return await new Promise<string>((resolve, reject) => {
        const chars: string[] = [];
        const wasRaw = stdin.isRaw;

        const cleanup = (): void => {
            stdin.off("data", onData);
            stdin.setRawMode(Boolean(wasRaw));
            stdin.pause();
        };

        const onData = (buffer: Buffer): void => {
            for (const byte of buffer) {
                if (byte === 3) {
                    cleanup();
                    stdout.write("\n");
                    reject(new Error("Cancelled"));
                    return;
                }

                if (byte === 13 || byte === 10) {
                    const value = chars.join("");
                    chars.fill("");
                    cleanup();
                    stdout.write("\n");
                    resolve(value);
                    return;
                }

                if (byte === 8 || byte === 127) {
                    if (chars.length > 0) {
                        chars.pop();
                        stdout.write("\b \b");
                    }
                    continue;
                }

                if (byte >= 32 && byte <= 126) {
                    const char = String.fromCharCode(byte);
                    chars.push(char);
                    stdout.write(char);
                }
            }
            buffer.fill(0);
        };

        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}

export async function confirm(question: string): Promise<boolean> {
    const answer = (await promptVisible(`${question} [y/N]: `))
        .trim()
        .toLowerCase();
    return answer === "y" || answer === "yes";
}

function formatMnemonic(words: readonly string[]): string {
    const lines: string[] = [];
    for (let offset = 0; offset < words.length; offset += 3) {
        const row = words.slice(offset, offset + 3).map((word, index) => {
            const number = String(offset + index + 1).padStart(2, "0");
            return `${number}. ${word.padEnd(12, " ")}`;
        });
        lines.push(row.join("  "));
    }
    return lines.join("\n");
}

async function waitForEnter(): Promise<void> {
    await promptHidden("Press Enter after writing the phrase down on paper: ");
}

export async function revealMnemonicOnce(
    words: readonly string[],
    title: string,
): Promise<void> {
    requirePrivateTerminal();

    // The alternate screen normally does not enter terminal scrollback.
    stdout.write("\u001b[?1049h\u001b[2J\u001b[H");
    try {
        stdout.write(`${title}\n\n`);
        stdout.write("WRITE THIS PHRASE ON PAPER. DO NOT COPY IT TO CLIPBOARD.\n\n");
        stdout.write(`${formatMnemonic(words)}\n\n`);
        await waitForEnter();
        stdout.write("\u001b[2J\u001b[H");
    } finally {
        stdout.write("\u001b[2J\u001b[H\u001b[?1049l");
    }
}

export async function revealWalletSecretsOnce(
    words: readonly string[],
    vaultPassword: string,
): Promise<void> {
    requirePrivateTerminal();
    stdout.write("\u001b[?1049h\u001b[2J\u001b[H");
    try {
        stdout.write("NEW WALLET TG RECOVERY MATERIAL\n\n");
        stdout.write("1. WRITE THE SEED PHRASE ON PAPER.\n\n");
        stdout.write(`${formatMnemonic(words)}\n\n`);
        stdout.write("2. SAVE THIS VAULT PASSWORD IN A PASSWORD MANAGER OR ON PAPER.\n");
        stdout.write("   IT IS NOT STORED BY THE APPLICATION.\n\n");
        stdout.write(`${vaultPassword}\n\n`);
        await waitForEnter();
        stdout.write("\u001b[2J\u001b[H");
    } finally {
        stdout.write("\u001b[2J\u001b[H\u001b[?1049l");
    }
}

export async function verifyVaultPasswordBackup(expected: string): Promise<void> {
    const entered = await promptHidden("Re-enter the generated vault password: ");
    const expectedBuffer = Buffer.from(expected, "utf8");
    const enteredBuffer = Buffer.from(entered, "utf8");
    try {
        if (
            expectedBuffer.length !== enteredBuffer.length ||
            !timingSafeEqual(expectedBuffer, enteredBuffer)
        ) {
            throw new Error("Vault password backup verification failed. Nothing was saved.");
        }
    } finally {
        expectedBuffer.fill(0);
        enteredBuffer.fill(0);
    }
}

export async function verifyMnemonicBackup(
    words: readonly string[],
): Promise<void> {
    const positions = new Set<number>();
    while (positions.size < 3) {
        positions.add(randomInt(0, words.length));
    }

    for (const position of [...positions].sort((a, b) => a - b)) {
        const answer = (await promptHidden(`Word #${position + 1}: `))
            .trim()
            .toLowerCase();
        if (answer !== words[position]) {
            throw new Error("Backup verification failed. Nothing was sent.");
        }
    }
}

export async function readMnemonic(label: string): Promise<string[]> {
    const raw = await promptHidden(`${label} (24 words): `);
    const words = raw.trim().toLowerCase().split(/\s+/u);
    if (words.length !== 24) {
        words.fill("");
        throw new Error("The mnemonic must contain exactly 24 words.");
    }
    return words;
}

export function wipeWords(words: string[]): void {
    words.fill("");
    words.length = 0;
}
