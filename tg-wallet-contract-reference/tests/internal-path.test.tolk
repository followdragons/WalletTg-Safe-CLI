import "@acton/crypto"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/errors"

/*
    This file checks the internal signed-request channel: send-message happy paths,
  internal send mode behavior, auth/header failures, and ordinary top-ups.
*/

get fun `test internal: send a simple transfer`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");
    val forwardValue = ton("0.001");
    val receiverBalanceBefore = testing.getAccountBalance(receiver);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, forwardValue)],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ from: wallet.address, to: receiver, value: forwardValue });
    val fee = receipt.at(1).tx.load().totalFees.grams;
    expect(testing.getAccountBalance(receiver)).toEqual(receiverBalanceBefore + forwardValue - fee);
    expect(wallet.seqno()).toEqual(1);
}

get fun `test internal: send two transfers`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver1 = randomAddress("receiver-1");
    val receiver2 = testing.treasury("receiver-2");

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver1, ton("0.001")), makeTransferToSend(receiver2.address, ton("0.002"))],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ from: wallet.address, to: receiver1, value: ton("0.001") });
    expect(receipt).toHaveTx({ from: wallet.address, to: receiver2.address, value: ton("0.002") });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test internal: accept send mode without ignore errors`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");
    val innerMsg = createMessage({ bounce: false, value: ton("0.001"), dest: receiver });

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [{ sendMode: SEND_MODE_PAY_FEES_SEPARATELY, messageCell: innerMsg.messageCell }],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(receipt).toHaveTx({ from: wallet.address, to: receiver, value: ton("0.001") });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test internal: reject empty message list`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: Errors.BeginParseOfNull });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: ignore request signed with wrong key`() {
    val ownerKey = crypto.generateKeyPair();
    val wrongKey = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(ownerKey);
    val receiver = randomAddress("receiver");

    val req = prepareSendMessagesI(
        wrongKey,
        seqnoHeader(0),
        [makeTransferToSend(receiver, ton("0.001"))],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: ignore signature for a different payload`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");

    val signed = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, ton("0.001"))],
    );
    val different = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, ton("0.002"))],
    );
    val receipt = wallet.requestInternal(
        deployer.address,
        { request: different.request, signature: signed.signature },
        { value: ton("0.1") },
    );

    expect(receipt).toHaveSuccessfulTx({ from: deployer.address, to: wallet.address });
    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: reject envelope with an extra reference`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, ton("0.001"))],
    );
    val envelope = createRawSignedEnvelope(keyPair, req.request.toCell());
    val malformed = beginCell().storeSlice(envelope.beginParse()).storeRef(createEmptyCell()).endCell();

    val receipt = wallet.sendAny(
        deployer.address,
        malformed,
        { value: ton("0.1") },
    );

    expect(receipt).toNotHaveTx({ from: wallet.address, to: receiver });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: reject signed request with unknown opcode`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val unknownRequest = beginCell().storeUint(0xDEADBEEF, 32).endCell();
    val envelope = createRawSignedEnvelope(keyPair, unknownRequest);

    val receipt = wallet.sendAny(
        deployer.address,
        envelope,
        { value: ton("0.1") },
    );

    expect(receipt).toHaveTx({
        from: deployer.address,
        to: wallet.address,
        exitCode: Errors.InvalidOpcode,
    });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: reject invalid seqno`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(1),
        [makeTransferToSend(randomAddress("receiver"), 1)],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });

    expect(receipt).toHaveTx({ exitCode: Errors.InvalidSeqno });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: reject expired request`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);
    val messageToSend = makeTransferToSend(randomAddress("receiver"), 1);

    val reqExpired = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0, blockchain.now() - 1),
        [messageToSend],
    );
    expect(
        wallet.requestInternal(deployer.address, reqExpired, { value: ton("0.1") }),
    ).toHaveTx({ exitCode: Errors.Expired });

    val reqExpiresNow = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0, blockchain.now()),
        [messageToSend],
    );
    expect(
        wallet.requestInternal(deployer.address, reqExpiresNow, { value: ton("0.1") }),
    ).toHaveTx({ exitCode: Errors.Expired });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: reject wrong subwallet id`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, deployer) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesI(
        keyPair,
        seqnoHeader(0, null, DEFAULT_SUBWALLET_ID + 1),
        [makeTransferToSend(randomAddress("receiver"), 1)],
    );
    val receipt = wallet.requestInternal(deployer.address, req, { value: ton("0.1") });
    expect(receipt).toHaveTx({
        exitCode: Errors.InvalidSubwalletId,
    });
    expect(wallet.seqno()).toEqual(0);
}

get fun `test internal: receive ordinary top-ups without changing seqno`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val sender = testing.treasury("sender");

    val emptyReceipt = wallet.sendAny(
        sender.address,
        createEmptyCell(),
        { value: ton("0.1"), bounce: false },
    );
    expect(emptyReceipt).toHaveSuccessfulTx({ from: sender.address, to: wallet.address });

    val commentReceipt = wallet.sendAny(
        sender.address,
        "wallet top-up".toCell(),
        { value: ton("0.1"), bounce: false },
    );
    expect(commentReceipt).toHaveSuccessfulTx({ from: sender.address, to: wallet.address });
    expect(wallet.seqno()).toEqual(0);
}
