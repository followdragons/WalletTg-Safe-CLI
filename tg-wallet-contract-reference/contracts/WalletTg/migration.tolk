import "storage"

/// After a bytecode upgrade by validator voting, c4 contains old storage.
/// Its "c4 revision" is determined by the 0xXX prefix of c4.
/// Here we run the migration from the current c4 revision to LAST (from OldStorage_XX to Storage).
/// Runs at most once: it always does `contract.setData`.
@noinline
fun runMigrationAndUpdateC4(): void {
    // nothing to be done yet
    // later, we'll migrate UnionOfOldStorages to Storage
}
