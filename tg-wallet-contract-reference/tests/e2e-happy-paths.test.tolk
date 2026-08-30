import "@acton/crypto"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/messages"

/*
    This file benchmarks end-to-end happy paths as full transaction chains.
    It measures the wallet transaction plus all child delivery transactions.

    Contrast with e2e-send-gas.test.tolk, which intentionally executes only the
    single wallet transaction to measure WalletTg send path gas.
*/

const E2E_BENCH_KEY_SEED = 0x57560001
const E2E_BENCH_NEW_KEY_SEED = 0x57560002
const E2E_BENCH_NOW = 1000
const E2E_BENCH_VALID_UNTIL = 2000

const E2E_BENCH_DEPLOY_VALUE = ton("0.05")
const E2E_BENCH_TOP_UP_VALUE = ton("10")
const E2E_BENCH_SIGNED_INTERNAL_VALUE = ton("0.1")
const E2E_BENCH_TRANSFER_VALUE = ton("0.001")

struct E2EBenchFixture {
    wallet: WalletTrampoline
    deployer: Treasury
    receiver: Treasury
    keyPair: KeyPair
}

fun e2eBenchKeyPair(): KeyPair {
    return crypto.seedToKeyPair(E2E_BENCH_KEY_SEED as uint256);
}

fun e2eBenchNewKeyPair(): KeyPair {
    return crypto.seedToKeyPair(E2E_BENCH_NEW_KEY_SEED as uint256);
}

fun e2eBenchRawTransferMessage(dest: address, value: coins): cell {
    return beginCell()
        .storeUint(0x10, 6)
        .storeAddress(dest)
        .storeCoins(value)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeRef(createEmptyCell())
        .endCell();
}

fun e2eBenchToSend(dest: address, value: coins): MessageToSend {
    return MessageToSend {
        sendMode: SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS,
        messageCell: e2eBenchRawTransferMessage(dest, value),
    };
}

fun e2eBenchToSendList(count: int, dest: address): array<MessageToSend> {
    var msgArr = array<MessageToSend> [];
    repeat (count) {
        msgArr.push(e2eBenchToSend(dest, E2E_BENCH_TRANSFER_VALUE));
    }
    return msgArr;
}

fun deployE2EBenchFixture(): E2EBenchFixture {
    testing.setNow(E2E_BENCH_NOW);

    val keyPair = e2eBenchKeyPair();
    val deployer = testing.treasury("e2e-deployer");
    val receiver = testing.treasury("e2e-receiver");

    setWalletBytecodeInConfig();
    val storage = makeStorage(keyPair.publicKey);
    val wallet = WalletTrampoline.fromStorage(storage);

    val deployResult = wallet.deploy(
        deployer.address,
        { value: E2E_BENCH_DEPLOY_VALUE, bounce: false },
    );
    deployResult.giveName("e2e setup deploy WalletTg");
    expect(deployResult).toHaveSuccessfulDeploy({
        from: deployer.address,
        to: wallet.address,
    });

    val topUpResult = wallet.sendAny(
        deployer.address,
        createEmptyCell(),
        { value: E2E_BENCH_TOP_UP_VALUE },
    );
    topUpResult.giveName("e2e setup top up WalletTg");
    expect(topUpResult).toHaveSuccessfulTx({ to: wallet.address });

    return E2EBenchFixture { wallet, deployer, receiver, keyPair };
}

fun sendE2EBenchSignedExternal(
    fixture: E2EBenchFixture,
    msgArr: array<MessageToSend>,
): SendResultList {
    val seqno = fixture.wallet.seqno();
    val req = prepareSendMessagesE(
        fixture.keyPair,
        seqnoHeader(seqno, E2E_BENCH_VALID_UNTIL),
        msgArr,
    );
    val result = fixture.wallet.requestExternal(req);

    expect(result).toBeAccepted();
    expect(fixture.wallet.seqno()).toEqual(seqno + 1);
    return result.unwrap();
}

fun sendE2EBenchSignedInternal(
    fixture: E2EBenchFixture,
    msgArr: array<MessageToSend>,
): SendResultList {
    val seqno = fixture.wallet.seqno();
    val req = prepareSendMessagesI(
        fixture.keyPair,
        seqnoHeader(seqno, E2E_BENCH_VALID_UNTIL),
        msgArr,
    );
    val result = fixture
        .wallet
        .requestInternal(
            fixture.deployer.address,
            req,
            { value: E2E_BENCH_SIGNED_INTERNAL_VALUE },
        );

    expect(fixture.wallet.seqno()).toEqual(seqno + 1);
    return result;
}

fun sendE2EBenchChangeKeyExternal(
    fixture: E2EBenchFixture,
    newKey: KeyPair,
): SendResultList {
    val seqno = fixture.wallet.seqno();
    val req = prepareChangePublicKeyE(
        fixture.keyPair,
        seqnoHeader(seqno, E2E_BENCH_VALID_UNTIL),
        fixture.wallet.address,
        newKey,
    );
    val result = fixture.wallet.requestExternal(req);

    expect(result).toBeAccepted();
    expect(fixture.wallet.seqno()).toEqual(seqno + 1);
    expect(fixture.wallet.getPublicKey()).toEqual(newKey.publicKey);
    return result.unwrap();
}

fun sendE2EBenchChangeKeyInternal(
    fixture: E2EBenchFixture,
    newKey: KeyPair,
): SendResultList {
    val seqno = fixture.wallet.seqno();
    val req = prepareChangePublicKeyI(
        fixture.keyPair,
        seqnoHeader(seqno, E2E_BENCH_VALID_UNTIL),
        fixture.wallet.address,
        newKey,
    );
    val result = fixture
        .wallet
        .requestInternal(
            fixture.deployer.address,
            req,
            { value: E2E_BENCH_SIGNED_INTERNAL_VALUE },
        );

    expect(fixture.wallet.seqno()).toEqual(seqno + 1);
    expect(fixture.wallet.getPublicKey()).toEqual(newKey.publicKey);
    return result;
}

fun assertFullChainSendResult(
    result: SendResultList,
    fixture: E2EBenchFixture,
    messageCount: int,
    receiverBalanceBefore: coins,
): void {
    expect(result.size()).toEqual(messageCount + 1);
    expect(result).toHaveTx({ exitCode: 0 });
    expect(result.at(0).outMessages.size()).toEqual(messageCount);

    var totalDeliveredValue: coins = 0;
    var totalReceiverFees: coins = 0;
    var i = 0;
    repeat (messageCount) {
        val deliveredTx = result.at(i + 1).tx.load();
        totalDeliveredValue += E2E_BENCH_TRANSFER_VALUE;
        totalReceiverFees += deliveredTx.totalFees.grams;
        i += 1;
    }
    val receiverBalanceAfter = testing.getAccountBalance(fixture.receiver.address);
    expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + totalDeliveredValue - totalReceiverFees);
}

get fun `test e2e full chain: EXTERNAL send 1 message`() {
    val fixture = deployE2EBenchFixture();
    val receiverBalanceBefore = testing.getAccountBalance(fixture.receiver.address);

    val result = sendE2EBenchSignedExternal(
        fixture,
        e2eBenchToSendList(1, fixture.receiver.address),
    );
    result.giveName("e2e full-chain EXTERNAL send 1");

    assertFullChainSendResult(result, fixture, 1, receiverBalanceBefore);
}

get fun `test e2e full chain: INTERNAL send 1 message`() {
    val fixture = deployE2EBenchFixture();
    val receiverBalanceBefore = testing.getAccountBalance(fixture.receiver.address);

    val result = sendE2EBenchSignedInternal(
        fixture,
        e2eBenchToSendList(1, fixture.receiver.address),
    );
    result.giveName("e2e full-chain INTERNAL send 1");

    assertFullChainSendResult(result, fixture, 1, receiverBalanceBefore);
}

get fun `test e2e full chain: EXTERNAL send 32 messages`() {
    val fixture = deployE2EBenchFixture();
    val receiverBalanceBefore = testing.getAccountBalance(fixture.receiver.address);

    val result = sendE2EBenchSignedExternal(
        fixture,
        e2eBenchToSendList(32, fixture.receiver.address),
    );
    result.giveName("e2e full-chain EXTERNAL send 32");

    assertFullChainSendResult(result, fixture, 32, receiverBalanceBefore);
}

get fun `test e2e full chain: INTERNAL send 32 messages`() {
    val fixture = deployE2EBenchFixture();
    val receiverBalanceBefore = testing.getAccountBalance(fixture.receiver.address);

    val result = sendE2EBenchSignedInternal(
        fixture,
        e2eBenchToSendList(32, fixture.receiver.address),
    );
    result.giveName("e2e full-chain INTERNAL send 32");

    assertFullChainSendResult(result, fixture, 32, receiverBalanceBefore);
}

get fun `test e2e full chain: EXTERNAL change key`() {
    val fixture = deployE2EBenchFixture();
    val newKey = e2eBenchNewKeyPair();

    val result = sendE2EBenchChangeKeyExternal(fixture, newKey);
    result.giveName("e2e full-chain EXTERNAL change key");

    expect(result.size()).toEqual(1);
    expect(result).toHaveTx({ exitCode: 0 });
}

get fun `test e2e full chain: INTERNAL change key`() {
    val fixture = deployE2EBenchFixture();
    val newKey = e2eBenchNewKeyPair();

    val result = sendE2EBenchChangeKeyInternal(fixture, newKey);
    result.giveName("e2e full-chain INTERNAL change key");

    expect(result.size()).toEqual(1);
    expect(result).toHaveSuccessfulTx({
        from: fixture.deployer.address,
        to: fixture.wallet.address,
        exitCode: 0,
    });
}
