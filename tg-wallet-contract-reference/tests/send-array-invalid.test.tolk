import "@acton/crypto"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/errors"
import "@contracts/WalletTg/messages"

/*
    This file checks malformed raw `array<MessageToSend>` payloads: garbage instead of
  arrays, len-vs-actual mismatches, broken chunks, etc.
*/

fun buildInvalidArrayToSend(count: int, dest: address, sendMode: int): array<MessageToSend> {
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

fun buildInvalidRawArrayChunk(
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

fun buildInvalidRawArrayWithHead(len: int, head: cell?): builder {
    return beginCell().storeUint(len, 8).storeMaybeRef(head);
}

fun buildInvalidRawArray(
    msgArr: array<MessageToSend>,
    chunkSizes: array<int>,
    lenOverride: int,
): builder {
    var tail: cell? = null;
    var chunkIndex = chunkSizes.size();
    var nextItem = msgArr.size();
    while (chunkIndex > 0) {
        chunkIndex -= 1;
        val chunkSize = chunkSizes.get(chunkIndex);
        nextItem -= chunkSize;
        tail = buildInvalidRawArrayChunk(msgArr, nextItem, chunkSize, tail);
    }
    return buildInvalidRawArrayWithHead(lenOverride, tail);
}

get fun `test array invalid: internal rejects garbage instead of array`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val garbage = beginCell().storeUint(0xAA, 8).storeRef(createEmptyCell());

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        garbage,
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: 9 });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: internal rejects len larger than actual messages`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildInvalidArrayToSend(1, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildInvalidRawArray(msgArr, [1], 2),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: Errors.InvalidOutArrayLen });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: internal rejects len smaller than actual messages`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildInvalidArrayToSend(2, receiver.address, SEND_MODE_PAY_FEES_SEPARATELY);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildInvalidRawArray(msgArr, [1, 1], 1),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: Errors.InvalidOutArrayLen });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: internal rejects zero len with non-null empty head`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val emptyHead = beginCell().storeMaybeRef(null).endCell();

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        buildInvalidRawArrayWithHead(0, emptyHead),
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: Errors.InvalidOutArrayLen });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: internal rejects chunk without maybe-ref header`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val malformed = buildInvalidRawArrayWithHead(1, createEmptyCell());

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        malformed,
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: 9 });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: internal rejects item without send mode bits`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val badChunk = beginCell().storeMaybeRef(null).storeRef(createEmptyCell()).endCell();
    val malformed = buildInvalidRawArrayWithHead(1, badChunk);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        malformed,
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: 9 });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: internal rejects chunk with trailing garbage`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val messageToSend = makeTransferToSend(receiver.address, ton("0.001"));
    val badChunk = beginCell().storeMaybeRef(null).storeAny<MessageToSend>(messageToSend).storeUint(1, 1).endCell();
    val malformed = buildInvalidRawArrayWithHead(1, badChunk);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        malformed,
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: 9 });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test array invalid: external rejects len mismatch after accept`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val receiver = testing.treasury("receiver");
    val msgArr = buildInvalidArrayToSend(
        1,
        receiver.address,
        SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS,
    );

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        buildInvalidRawArray(msgArr, [1], 2),
    );
    val result = wallet.requestExternal(req);

    expect(result).toBeAccepted();
    val receipt = result.unwrap();
    expect(receipt).toHaveTx({ exitCode: Errors.InvalidOutArrayLen });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver.address });
    expect(wallet.seqno()).toEqual(1);
}
