//! Regression tests ensuring every `ContractError` variant can be triggered
//! and reports the expected numeric error code.
//!
//! Each test below explicitly constructs the error and asserts its code so
//! that adding a new variant without a corresponding test is caught in review
//! and by the CI coverage gate.

use crate::errors::ContractError;

/// Helper: assert the numeric code of a `ContractError` variant.
fn assert_code(err: ContractError, expected: u32) {
    assert_eq!(err as u32, expected, "unexpected code for {:?}", err);
}

#[test]
fn test_unauthorized_code() {
    assert_code(ContractError::Unauthorized, 1);
}

#[test]
fn test_not_initialized_code() {
    assert_code(ContractError::NotInitialized, 2);
}

#[test]
fn test_already_initialized_code() {
    assert_code(ContractError::AlreadyInitialized, 3);
}

#[test]
fn test_invalid_proposal_code() {
    assert_code(ContractError::InvalidProposal, 4);
}

#[test]
fn test_proposal_not_found_code() {
    assert_code(ContractError::ProposalNotFound, 5);
}

#[test]
fn test_proposal_not_active_code() {
    assert_code(ContractError::ProposalNotActive, 6);
}

#[test]
fn test_proposal_expired_code() {
    assert_code(ContractError::ProposalExpired, 7);
}

#[test]
fn test_already_voted_code() {
    assert_code(ContractError::AlreadyVoted, 8);
}

#[test]
fn test_voting_closed_code() {
    assert_code(ContractError::VotingClosed, 9);
}

#[test]
fn test_quorum_not_met_code() {
    assert_code(ContractError::QuorumNotMet, 10);
}

#[test]
fn test_insufficient_balance_code() {
    assert_code(ContractError::InsufficientBalance, 11);
}

#[test]
fn test_invalid_amount_code() {
    assert_code(ContractError::InvalidAmount, 12);
}

#[test]
fn test_invalid_threshold_code() {
    assert_code(ContractError::InvalidThreshold, 13);
}

#[test]
fn test_invalid_duration_code() {
    assert_code(ContractError::InvalidDuration, 14);
}

#[test]
fn test_invalid_input_code() {
    assert_code(ContractError::InvalidInput, 15);
}

#[test]
fn test_overflow_code() {
    assert_code(ContractError::Overflow, 16);
}

#[test]
fn test_underflow_code() {
    assert_code(ContractError::Underflow, 17);
}

#[test]
fn test_not_found_code() {
    assert_code(ContractError::NotFound, 18);
}

#[test]
fn test_already_exists_code() {
    assert_code(ContractError::AlreadyExists, 19);
}

#[test]
fn test_paused_code() {
    assert_code(ContractError::Paused, 20);
}

#[test]
fn test_not_paused_code() {
    assert_code(ContractError::NotPaused, 21);
}

#[test]
fn test_invalid_state_code() {
    assert_code(ContractError::InvalidState, 22);
}

#[test]
fn test_cross_contract_call_failed_code() {
    assert_code(ContractError::CrossContractCallFailed, 23);
}

#[test]
fn test_invalid_contract_address_code() {
    assert_code(ContractError::InvalidContractAddress, 24);
}

#[test]
fn test_unknown_code() {
    assert_code(ContractError::Unknown, 25);
}
