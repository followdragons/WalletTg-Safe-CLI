import "migration"
import "revisions"

/// Current storage schema of the contract.
/// A new contract revision bumps its 0xXX prefix and may append new fields.
/// See `runMigrationAndUpdateC4` about migrations after bytecode upgrade.
struct (0x00) Storage {
    /// Seqno protects against replay attacks: every incoming message contains the expected seqno.
    /// Once the contract accepts a message, it bumps storage seqno. Old messages can't be replayed.
    seqno: uint32
    /// SubwalletId allows creating multiple wallets for one private key.
    /// Default for mainnet: 0x7FFF7F11; for testnet: 0x7FFF7FFD; for subwallets, consider docs.
    subwalletId: uint32
    /// Public key used to check signatures of all incoming messages.
    /// It can be replaced by a signed change-key request.
    publicKey: uint256
}

/// Every time the contract logic is updated, we bump 0xXX of `Storage`: it's the contract's revision.
/// After validator voting, new bytecode appears in config, atomically updating the "backend" of all Telegram wallets.
/// But c4 of each account still contains the previous revision number until migration.
fun getC4Revision(): Revision {
    // SAFETY: prefix of `Storage` is 0xXX
    return contract.getData().beginParse().loadUint(8) as Revision;
}

/// Loading storage means first ensuring that c4 has the last revision, then doing a regular load.
/// Note: it can't be used as `lazy` now because of extra logic besides "return fromCell".
/// Tolk v1.5 will support lazy here.
@inline
fun Storage.load(): Storage {
    if (getC4Revision() != LAST_REVISION) {
        runMigrationAndUpdateC4();
    }
    return Storage.fromCell(contract.getData(), {
        assertEndAfterReading: false,   // no ENDS, the cell is 100% correct; TODO: remove when lazy
    });
}

/// Update c4 with the current 0xXX-prefixed storage layout.
fun Storage.save(self) {
    contract.setData(self.toCell());
}


// -------------------------------------------------------
//     Old storage layouts: previous contract revisions
//
// Every wallet logic change is a "revision".
// Prefix 0xXX of `Storage` is the CURRENT (active) bytecode revision, stored in config.
//
// For every new revision (from XX to XX+1) we
// - copy `struct (0xXX) Storage` above to `struct (0xXX) OldStorage_XX` below
// - bump revision: `struct (0xXX+1) Storage` and in `contract` directive in `WalletTg.tolk`
// - provide a migration from XX to XX+1 in `migration.tolk`
// Even if storage shape did not change!!!
// Prefix of `Storage` must be equal to the last (active) one.
//
// Note: for the full migration algorithm, read `MIGRATION.md`; there are more points there.
//

type UnionOfOldStorages =
    | void


