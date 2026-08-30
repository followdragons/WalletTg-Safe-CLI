import "@acton/crypto"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/messages"

/*
    This file checks valid raw `array<MessageToSend>` encodings that differ from the
  default client serialization: chunk sizes, mixed layouts, empty chunks, etc.
*/

fun buildValidArrayToSend(count: int, dest: address, sendMode: int): array<MessageToSend> {
    var msgArr = array<MessageToSend> [];
    var i = 0;
    repeat (count) {
        val outMsg = createMessage({
            bounce: false,
            value: ton("0.001"),
            dest,
            body: beginCell().storeUint(i, 32).endCell(),
        });
        msgArr.push({ sendMode, messageCell: outMsg.messageCell });
        i += 1;
    }
    return msgArr;
}

fun buildValidRawArrayChunk(
    msgArr: array<MessageToSend>,
    start: int,
    chunkSize: int,
    tail: cell?,
): cell {
    var b = beginCell();
    b.storeMaybeRef(tail);
    var i = 0;
    repeat (chunkSize) {
        b.storeAny<MessageToSend>(msgArr.get(start + i));
        i += 1;
    }
    return b.endCell();
}

fun buildValidRawArray(
    msgArr: array<MessageToSend>,
    chunkSizes: array<int>,
): builder {
    var tail: cell? = null;
    var chunkIndex = chunkSizes.size();
    var nextItem = msgArr.size();
    while (chunkIndex > 0) {
        chunkIndex -= 1;
        val chunkSize = chunkSizes.get(chunkIndex);
        nextItem -= chunkSize;
        tail = buildValidRawArrayChunk(msgArr, nextItem, chunkSize, tail);
    }
    return beginCell().storeUint(msgArr.size(), 8).storeMaybeRef(tail);
}

fun buildDeepMixedRawArray(msgArr: array<MessageToSend>): builder {
    var tail: cell? = buildValidRawArrayChunk(msgArr, msgArr.size(), 0, null);
    var nextItem = msgArr.size();
    repeat (85) {
        nextItem -= 2;
        tail = buildValidRawArrayChunk(msgArr, nextItem, 2, tail);
        tail = buildValidRawArrayChunk(msgArr, nextItem, 0, tail);
        nextItem -= 1;
        tail = buildValidRawArrayChunk(msgArr, nextItem, 1, tail);
        tail = buildValidRawArrayChunk(msgArr, nextItem, 0, tail);
    }
    return beginCell().storeUint(msgArr.size(), 8).storeMaybeRef(tail);
}

get fun `test array valid: internal accepts one-message chunks`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(4, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [1, 1, 1, 1]),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt.size()).toEqual(5);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal sends one message through bulk array`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(1, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [1]),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt.size()).toEqual(2);
    expect(receipt.at(0).outMessages.size()).toEqual(1);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(receipt).toHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal accepts two-message chunks`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(6, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [2, 2, 2]),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt.size()).toEqual(7);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal accepts mixed chunks`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(12, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(
            msgArr,
            [
                1,
                2,
                3,
                3,
                2,
                1,
            ],
        ),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.2") });

    expect(receipt.size()).toEqual(13);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal accepts four messages in final chunk`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(4, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [4]),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt.size()).toEqual(5);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal accepts empty intermediate chunk`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(1, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [0, 1]),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt.size()).toEqual(2);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(receipt).toHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal accepts empty final chunk`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(1, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [1, 0]),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt.size()).toEqual(2);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(receipt).toHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: internal sends 255 messages through a deep mixed snake`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(255, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildDeepMixedRawArray(msgArr),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("1") });

    expect(receipt.size()).toEqual(256);
    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test array valid: external accepts four messages in final chunk`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildValidArrayToSend(
        4,
        receiver.address,
        SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS,
    );

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        buildValidRawArray(msgArr, [4]),
    );
    val result = wallet.requestExternal(req);
    expect(result).toBeAccepted();
    val receipt = result.unwrap();

    expect(receipt.size()).toEqual(5);
    expect(receipt).toHaveTx({ exitCode: 0 });
    expect(wallet.seqno()).toEqual(1);
}
