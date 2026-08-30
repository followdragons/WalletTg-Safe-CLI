import "@acton/crypto"
import "@acton/ffi"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/messages"

/*
    This file benchmarks "send N messages" for different N — ONLY the send transaction alone.
    Both external and internal helpers use a trace cursor with executeN(1).
    e2e-happy-paths.test.tolk measures the full chain instead.
*/

const SEND_GAS_BENCH_KEY_SEED = 0x5E000001
const SEND_GAS_BENCH_NOW = 1000
const SEND_GAS_BENCH_VALID_UNTIL = 2000

const SEND_GAS_BENCH_DEPLOY_VALUE = ton("0.05")
const SEND_GAS_BENCH_TOP_UP_VALUE = ton("10")
const SEND_GAS_BENCH_INTERNAL_VALUE = ton("0.1")
const SEND_GAS_BENCH_TRANSFER_VALUE = ton("0.001")

struct SendGasBenchFixture {
    wallet: WalletTrampoline
    deployer: Treasury
    receiver: Treasury
    keyPair: KeyPair
}

fun deploySendGasBenchFixture(): SendGasBenchFixture {
    testing.setNow(SEND_GAS_BENCH_NOW);

    val keyPair = crypto.seedToKeyPair(SEND_GAS_BENCH_KEY_SEED as uint256);
    val deployer = testing.treasury("send-gas-bench-deployer");
    val receiver = testing.treasury("send-gas-bench-receiver");

    setWalletBytecodeInConfig();
    val storage = makeStorage(keyPair.publicKey);
    val wallet = WalletTrampoline.fromStorage(storage);

    val deployResult = wallet.deploy(
        deployer.address,
        { value: SEND_GAS_BENCH_DEPLOY_VALUE, bounce: false },
    );
    deployResult.giveName("send gas bench setup deploy");
    expect(deployResult).toHaveSuccessfulDeploy({ to: wallet.address });

    val topUpResult = wallet.sendAny(
        deployer.address,
        createEmptyCell(),
        { value: SEND_GAS_BENCH_TOP_UP_VALUE },
    );
    topUpResult.giveName("send gas bench setup top up");
    expect(topUpResult).toHaveSuccessfulTx({ to: wallet.address });

    return SendGasBenchFixture { wallet, deployer, receiver, keyPair };
}

fun sendGasBenchToSend(
    count: int,
    dest: address,
    malformedMessageAt: int = -1,
): array<MessageToSend> {
    var msgArr: array<MessageToSend> = [];
    var i = 0;
    repeat (count) {
        val messageCell = i == malformedMessageAt
            ? createEmptyCell()
            : createMessage({
                bounce: false,
                value: SEND_GAS_BENCH_TRANSFER_VALUE,
                dest,
                body: beginCell().storeUint(i, 32).endCell(),
            }).messageCell;
        msgArr.push(MessageToSend {
            sendMode: SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS,
            messageCell,
        });
        i += 1;
    }
    return msgArr;
}

fun executeSendGasBenchExternal(
    fixture: SendGasBenchFixture,
    msgArr: array<MessageToSend>,
): SendResultList {
    val req = prepareSendMessagesE(
        fixture.keyPair,
        seqnoHeader(0, SEND_GAS_BENCH_VALID_UNTIL),
        msgArr,
    );
    val message = net.createExternalMessage(fixture.wallet.address, req);
    val cursor = TxCursor {
        id: ffi.startMessageIter(
            message.messageCell,
            address("-1:0000000000000000000000000000000000000000000000000000000000000000").toCell(),
        ),
    };
    val result = cursor.executeN(1);
    cursor.close();
    return result;
}

fun executeSendGasBenchInternal(
    fixture: SendGasBenchFixture,
    msgArr: array<MessageToSend>,
): SendResultList {
    val req = prepareSendMessagesI(
        fixture.keyPair,
        seqnoHeader(0, SEND_GAS_BENCH_VALID_UNTIL),
        msgArr,
    );
    val signedMessage = createMessage({
        bounce: false,
        value: SEND_GAS_BENCH_INTERNAL_VALUE,
        dest: fixture.wallet.address,
        body: req,
    });
    val cursor = testing.createTraceIterationCursor(fixture.deployer.address, signedMessage);
    val result = cursor.executeN(1);
    cursor.close();
    return result;
}

fun assertSuccessfulSendGasBench(result: SendResultList, expectedMessages: int): void {
    expect(result.size()).toEqual(1);
    expect(result).toHaveSuccessfulTx({ exitCode: 0 });
    expect(result.at(0).outMessages.size()).toEqual(expectedMessages);
}

get fun `test send gas: EXTERNAL send 1 message`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchExternal(fixture, sendGasBenchToSend(1, fixture.receiver.address));
    result.giveName("send gas EXTERNAL send 1");
    assertSuccessfulSendGasBench(result, 1);
}

get fun `test send gas: EXTERNAL send 2 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchExternal(fixture, sendGasBenchToSend(2, fixture.receiver.address));
    result.giveName("send gas EXTERNAL send 2");
    assertSuccessfulSendGasBench(result, 2);
}

get fun `test send gas: EXTERNAL send 5 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchExternal(fixture, sendGasBenchToSend(5, fixture.receiver.address));
    result.giveName("send gas EXTERNAL send 5");
    assertSuccessfulSendGasBench(result, 5);
}

get fun `test send gas: EXTERNAL send 32 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchExternal(fixture, sendGasBenchToSend(32, fixture.receiver.address));
    result.giveName("send gas EXTERNAL send 32");
    assertSuccessfulSendGasBench(result, 32);
}

get fun `test send gas: EXTERNAL send 255 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchExternal(fixture, sendGasBenchToSend(255, fixture.receiver.address));
    result.giveName("send gas EXTERNAL send 255");
    assertSuccessfulSendGasBench(result, 255);
}

get fun `test send gas: EXTERNAL malformed message 30 of 32`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchExternal(
        fixture,
        sendGasBenchToSend(32, fixture.receiver.address, 29),
    );
    result.giveName("send gas EXTERNAL malformed message 30 of 32");

    // WalletTg does not parse MessageRelaxed. The +2 mode makes the action phase skip the
    // malformed 30th message instead of failing the whole action phase.
    expect(result).toHaveSuccessfulTx({ exitCode: 0, actionExitCode: 0 });
    expect(result.at(0).outMessages.size()).toEqual(31);
    expect(fixture.wallet.seqno()).toEqual(1);
}

get fun `test send gas: INTERNAL send 1 message`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchInternal(fixture, sendGasBenchToSend(1, fixture.receiver.address));
    result.giveName("send gas INTERNAL send 1");
    assertSuccessfulSendGasBench(result, 1);
}

get fun `test send gas: INTERNAL send 2 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchInternal(fixture, sendGasBenchToSend(2, fixture.receiver.address));
    result.giveName("send gas INTERNAL send 2");
    assertSuccessfulSendGasBench(result, 2);
}

get fun `test send gas: INTERNAL send 5 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchInternal(fixture, sendGasBenchToSend(5, fixture.receiver.address));
    result.giveName("send gas INTERNAL send 5");
    assertSuccessfulSendGasBench(result, 5);
}

get fun `test send gas: INTERNAL send 32 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchInternal(fixture, sendGasBenchToSend(32, fixture.receiver.address));
    result.giveName("send gas INTERNAL send 32");
    assertSuccessfulSendGasBench(result, 32);
}

get fun `test send gas: INTERNAL send 255 messages`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchInternal(fixture, sendGasBenchToSend(255, fixture.receiver.address));
    result.giveName("send gas INTERNAL send 255");
    assertSuccessfulSendGasBench(result, 255);
}

get fun `test send gas: INTERNAL malformed message 30 of 32`() {
    val fixture = deploySendGasBenchFixture();
    val result = executeSendGasBenchInternal(
        fixture,
        sendGasBenchToSend(32, fixture.receiver.address, 29),
    );
    result.giveName("send gas INTERNAL malformed message 30 of 32");

    // WalletTg does not parse MessageRelaxed. The +2 mode makes the action phase skip the
    // malformed 30th message instead of failing the whole action phase.
    expect(result).toHaveSuccessfulTx({ exitCode: 0, actionExitCode: 0 });
    expect(result.at(0).outMessages.size()).toEqual(31);
    expect(fixture.wallet.seqno()).toEqual(1);
}
