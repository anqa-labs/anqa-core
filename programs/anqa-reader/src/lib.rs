//! Minimal "attacker" program for the anqa privacy boundary test.
//!
//! It does exactly what a real exfiltration program's first half does: take a
//! private account as a read-only input and read its bytes. Instead of copying
//! them into an attacker-owned account, it logs the length, a checksum, and the
//! first bytes — enough to prove the enclave handed this arbitrary,
//! freshly-deployed program the plaintext. The copy-to-dest step is a
//! mechanical SVM given (any executing program may read any account in its
//! instruction's account list); reading the plaintext is the whole question.

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

entrypoint!(process_instruction);

fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    if accounts.is_empty() {
        msg!("ANQA-EXFIL no-accounts");
        return Ok(());
    }
    let src = &accounts[0];
    let data = src.try_borrow_data()?;
    let len = data.len();

    // A cheap fingerprint of the private bytes. If this is non-zero the program
    // demonstrably received real account contents, not a filtered null.
    let mut sum: u64 = 0;
    for &b in data.iter() {
        sum = sum.wrapping_add(b as u64);
    }

    let head_len = core::cmp::min(16, len);
    msg!(
        "ANQA-EXFIL account={} len={} checksum={} lamports={}",
        src.key,
        len,
        sum,
        src.lamports()
    );
    // Log the first 16 bytes so we can compare against the true on-chain header.
    msg!("ANQA-EXFIL head={:?}", &data[..head_len]);
    Ok(())
}
