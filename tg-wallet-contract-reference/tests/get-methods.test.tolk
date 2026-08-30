import "@acton/testing/expect"
import "@wrappers/WalletTrampoline.gen"
import "@wrappers/utils"
import "@contracts/WalletTg/revisions"

/*
    This file checks storage-backed getter methods: seqno, public key, subwallet id, etc.
*/

get fun `test get seqno`() {
    val expectedSeqno = 12345;
    val storage = makeStorage(0, expectedSeqno);

    val (wallet, _) = deployWallet(storage);
    expect(wallet.seqno()).toEqual(expectedSeqno);
}

get fun `test get public key`() {
    val expectedPublicKey = 0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF;
    val storage = makeStorage(expectedPublicKey);

    val (wallet, _) = deployWallet(storage);
    expect(wallet.getPublicKey()).toEqual(expectedPublicKey);
}

get fun `test get subwallet id`() {
    val expectedSubwalletId = 123;
    val storage = makeStorage(0, 0, expectedSubwalletId);

    val (wallet, _) = deployWallet(storage);
    expect(wallet.getSubwalletId()).toEqual(expectedSubwalletId);
}

get fun `test get revision of newly deployed is last known`() {
    val (wallet, _) = deployWallet(makeStorage());
    expect(wallet.revision()).toEqual(Revision.Rev00_Initial);
}
