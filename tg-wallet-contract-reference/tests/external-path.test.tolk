import "@acton/crypto"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/errors"

/*
    This file checks the external signed-request channel: send-message happy paths,
  accept/not-accept behavior, +2 send mode guard, and auth/header failures.
*/

get fun `test external: send a simple transfer`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");
    val forwardValue = ton("0.001");
    val receiverBalanceBefore = testing.getAccountBalance(receiver);

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, forwardValue)],
    );
    val result = wallet.requestExternal(req);
    expect(result).toBeAccepted();
    val receipt = result.unwrap();

    expect(receipt).toHaveTx({ from: wallet.address, to: receiver, value: forwardValue });
    val fee = receipt.at(1).tx.load().totalFees.grams;
    expect(testing.getAccountBalance(receiver)).toEqual(receiverBalanceBefore + forwardValue - fee);
    expect(wallet.seqno()).toEqual(1);
}

get fun `test external: send two transfers`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val receiver1 = randomAddress("receiver-1");
    val receiver2 = testing.treasury("receiver-2");

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver1, ton("0.001")), makeTransferToSend(receiver2.address, ton("0.002"))],
    );
    val result = wallet.requestExternal(req);
    expect(result).toBeAccepted();
    val receipt = result.unwrap();

    expect(receipt).toHaveTx({ from: wallet.address, to: receiver1, value: ton("0.001") });
    expect(receipt).toHaveTx({ from: wallet.address, to: receiver2.address, value: ton("0.002") });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test external: reject empty message list`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [],
    );
    val result = wallet.requestExternal(req);

    expect(result).toBeAccepted();
    expect(result.unwrap()).toHaveTx({ exitCode: Errors.BeginParseOfNull });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test external: reject send mode without ignore errors`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");
    val innerMsg = createMessage({ bounce: false, value: ton("0.001"), dest: receiver });

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [{ sendMode: SEND_MODE_PAY_FEES_SEPARATELY, messageCell: innerMsg.messageCell }],
    );
    val result = wallet.requestExternal(req);

    expect(result).toBeAccepted();
    expect(result.unwrap()).toHaveTx({
        exitCode: Errors.ExternalSendMessageMustHaveIgnoreErrorsSendMode,
    });
    expect(wallet.seqno()).toEqual(1);
}

get fun `test external: reject request signed with wrong key`() {
    val ownerKey = crypto.generateKeyPair();
    val wrongKey = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(ownerKey);

    val req = prepareSendMessagesE(
        wrongKey,
        seqnoHeader(0),
        [makeTransferToSend(randomAddress("receiver"), 1)],
    );
    val result = wallet.requestExternal(req);

    expect(result).toBeNotAccepted();
    expect(result).toHaveExternalVmExitCode(Errors.InvalidSignature);
    expect(wallet.seqno()).toEqual(0);
}

get fun `test external: reject signature for a different payload`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val receiver = randomAddress("receiver");

    val signed = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, ton("0.001"))],
    );
    val different = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(receiver, ton("0.002"))],
    );
    val result = wallet.requestExternal({
        request: different.request,
        signature: signed.signature,
    });
    expect(result).toBeNotAccepted();
    expect(result).toHaveExternalVmExitCode(Errors.InvalidSignature);
    expect(wallet.seqno()).toEqual(0);
}

get fun `test external: reject envelope with trailing data`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0),
        [makeTransferToSend(randomAddress("receiver"), ton("0.001"))],
    );
    val envelope = createRawSignedEnvelope(keyPair, req.request.toCell());
    val malformed = beginCell().storeSlice(envelope.beginParse()).storeUint(0, 1).endCell();

    val result = wallet.sendAnyExternal(malformed);

    expect(result).toBeNotAccepted();
    expect(wallet.seqno()).toEqual(0);
}

get fun `test external: reject signed request with unknown opcode`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val unknownRequest = beginCell().storeUint(0xDEADBEEF, 32).endCell();
    val envelope = createRawSignedEnvelope(keyPair, unknownRequest);

    val result = wallet.sendAnyExternal(envelope);

    expect(result).toBeNotAccepted();
    expect(result).toHaveExternalVmExitCode(Errors.InvalidOpcode);
    expect(wallet.seqno()).toEqual(0);
}

get fun `test external: reject invalid seqno`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(1),
        [makeTransferToSend(randomAddress("receiver"), 1)],
    );
    val result = wallet.requestExternal(req);

    expect(result).toBeNotAccepted();
    expect(result).toHaveExternalVmExitCode(Errors.InvalidSeqno);
    expect(wallet.seqno()).toEqual(0);
}

get fun `test external: reject expired request`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);
    val messageToSend = makeTransferToSend(randomAddress("receiver"), 1);

    val reqExpired = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0, blockchain.now() - 1),
        [messageToSend],
    );
    val expired = wallet.requestExternal(reqExpired);
    expect(expired).toBeNotAccepted();
    expect(expired).toHaveExternalVmExitCode(Errors.Expired);

    val reqExpiresNow = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0, blockchain.now()),
        [messageToSend],
    );
    val expiresNow = wallet.requestExternal(reqExpiresNow);
    expect(expiresNow).toBeNotAccepted();
    expect(expiresNow).toHaveExternalVmExitCode(Errors.Expired);
    expect(wallet.seqno()).toEqual(0);
}

get fun `test external: reject wrong subwallet id`() {
    val keyPair = crypto.generateKeyPair();
    val (wallet, _) = deployWalletWithKey(keyPair);

    val req = prepareSendMessagesE(
        keyPair,
        seqnoHeader(0, null, DEFAULT_SUBWALLET_ID + 1),
        [makeTransferToSend(randomAddress("receiver"), 1)],
    );
    val result = wallet.requestExternal(req);
    expect(result).toBeNotAccepted();
    expect(result).toHaveExternalVmExitCode(Errors.InvalidSubwalletId);
    expect(wallet.seqno()).toEqual(0);
}
