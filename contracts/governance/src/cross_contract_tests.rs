//! Cross-contract call safety tests.
//!
//! Although Soroban's VM prevents classic reentrancy at the protocol level,
//! these tests explicitly verify that the governance contract behaves correctly
//! when a malicious token contract attempts to re-enter governance functions
//! during a cross-contract call.
//!
//! Scenarios covered:
//! 1. Malicious token re-enters `cast_vote` during `balance_at` → attack fails
//! 2. Malicious token re-enters `finalise` during `total_supply` → attack fails
//! 3. Governance state is intact and usable after all attack attempts
//! 4. Governance executes a `TreasuryAction` and disburses XLM from treasury
//! 5. Governance executes a `TreasuryAction` and disburses a SEP-41 token
//! 6. Non-governance callers cannot disburse treasury funds

#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    Address, Env, String, Vec,
};

use crate::{
    types::{ProposalState, Vote},
    GovernanceContract, GovernanceContractClient,
};
use cosmosvote_token::{TokenContract, TokenContractClient};

// ---------------------------------------------------------------------------
// Malicious token that attempts to re-enter cast_vote during balance_at
// ---------------------------------------------------------------------------

#[soroban_sdk::contracttype]
#[derive(Clone)]
enum ReentrantKey {
    Gov,
    ProposalId,
    Voter,
    Balance(Address),
    AttackSucceeded,
}

fn store_gov(env: &Env, v: &Address) {
    env.storage().instance().set(&ReentrantKey::Gov, v);
}
fn load_gov(env: &Env) -> Address {
    env.storage().instance().get(&ReentrantKey::Gov).unwrap()
}
fn store_proposal_id(env: &Env, v: u64) {
    env.storage().instance().set(&ReentrantKey::ProposalId, &v);
}
fn load_proposal_id(env: &Env) -> u64 {
    env.storage().instance().get(&ReentrantKey::ProposalId).unwrap_or(0)
}
fn store_voter(env: &Env, v: &Address) {
    env.storage().instance().set(&ReentrantKey::Voter, v);
}
fn load_voter(env: &Env) -> Address {
    env.storage().instance().get(&ReentrantKey::Voter).unwrap()
}
fn store_balance(env: &Env, owner: &Address, v: i128) {
    env.storage().persistent().set(&ReentrantKey::Balance(owner.clone()), &v);
}
fn load_balance(env: &Env, owner: &Address) -> i128 {
    env.storage().persistent().get(&ReentrantKey::Balance(owner.clone())).unwrap_or(0)
}
fn store_attack_succeeded(env: &Env, v: bool) {
    env.storage().instance().set(&ReentrantKey::AttackSucceeded, &v);
}
fn load_attack_succeeded(env: &Env) -> bool {
    env.storage().instance().get(&ReentrantKey::AttackSucceeded).unwrap_or(false)
}

/// Token that attempts to call back into governance's cast_vote during balance_at.
#[contract]
struct ReentrantVoteToken;

#[contractimpl]
impl ReentrantVoteToken {
    /// Called by governance during cast_vote to check voting weight.
    pub fn get_delegated_weight(env: Env, voter: Address, _delegators: Vec<Address>) -> i128 {
        // Attempt to re-enter cast_vote while governance is already executing it
        let gov_client = GovernanceContractClient::new(&env, &load_gov(&env));
        let pid = load_proposal_id(&env);
        let result = gov_client.try_cast_vote(&voter, &pid, &Vote::Yes);
        store_attack_succeeded(&env, result.is_ok());
        load_balance(&env, &voter)
    }

    pub fn get_delegation(_env: Env, _owner: Address) -> Option<Address> {
        None
    }

    pub fn balance(env: Env, owner: Address) -> i128 {
        load_balance(&env, &owner)
    }

    pub fn total_supply(_env: Env) -> i128 {
        1_000_000_000i128
    }

    pub fn balance_at(env: Env, owner: Address, _ledger: u64) -> i128 {
        load_balance(&env, &owner)
    }
}

// ---------------------------------------------------------------------------
// Malicious token that attempts to re-enter finalise during total_supply
// ---------------------------------------------------------------------------

#[soroban_sdk::contracttype]
#[derive(Clone)]
enum FinaliseReentrantKey {
    Gov,
    ProposalId,
    AttackSucceeded,
}

fn fstore_gov(env: &Env, v: &Address) {
    env.storage().instance().set(&FinaliseReentrantKey::Gov, v);
}
fn fload_gov(env: &Env) -> Address {
    env.storage().instance().get(&FinaliseReentrantKey::Gov).unwrap()
}
fn fstore_proposal_id(env: &Env, v: u64) {
    env.storage().instance().set(&FinaliseReentrantKey::ProposalId, &v);
}
fn fload_proposal_id(env: &Env) -> u64 {
    env.storage().instance().get(&FinaliseReentrantKey::ProposalId).unwrap_or(0)
}
fn fstore_attack_succeeded(env: &Env, v: bool) {
    env.storage().instance().set(&FinaliseReentrantKey::AttackSucceeded, &v);
}
fn fload_attack_succeeded(env: &Env) -> bool {
    env.storage().instance().get(&FinaliseReentrantKey::AttackSucceeded).unwrap_or(false)
}

/// Token that attempts to call back into governance's finalise during total_supply.
#[contract]
struct ReentrantFinaliseToken;

#[contractimpl]
impl ReentrantFinaliseToken {
    pub fn total_supply(env: Env) -> i128 {
        // Attempt to re-enter finalise while governance is already executing it
        let gov_client = GovernanceContractClient::new(&env, &fload_gov(&env));
        let pid = fload_proposal_id(&env);
        let result = gov_client.try_finalise(&pid);
        fstore_attack_succeeded(&env, result.is_ok());
        1_000_000_000i128
    }

    pub fn balance(_env: Env, _owner: Address) -> i128 {
        10_000_000i128
    }

    pub fn balance_at(_env: Env, _owner: Address, _ledger: u64) -> i128 {
        10_000_000i128
    }

    pub fn get_delegation(_env: Env, _owner: Address) -> Option<Address> {
        None
    }

    pub fn get_delegated_weight(_env: Env, _voter: Address, _delegators: Vec<Address>) -> i128 {
        10_000_000i128
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_proposal(gov: &GovernanceContractClient, env: &Env, proposer: &Address) -> u64 {
    gov.create_proposal(
        proposer,
        &String::from_str(env, "Test Proposal"),
        &String::from_str(env, "Description"),
        &1_000_000i128,
        &604_800u64,
        &None,
        &None,
    )
}

// ---------------------------------------------------------------------------
// Test 1: Re-entering cast_vote during get_delegated_weight is blocked
// ---------------------------------------------------------------------------

#[test]
fn test_reentrant_cast_vote_is_blocked() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Register the malicious token
    let token_id = env.register(ReentrantVoteToken, ());
    store_balance(&env, &attacker, 10_000_000i128);

    let gov_id = env.register(GovernanceContract, ());
    let gov = GovernanceContractClient::new(&env, &gov_id);
    gov.initialize(&admin, &token_id, &0i128, &0u64, &0u32, &false, &None, &0u32);

    // Wire up the malicious token to point back at governance
    store_gov(&env, &gov_id);

    let proposal_id = make_proposal(&gov, &env, &attacker);
    store_proposal_id(&env, proposal_id);

    // Attacker calls cast_vote; malicious token tries to re-enter cast_vote during get_delegated_weight
    gov.cast_vote(&attacker, &proposal_id, &Vote::Yes);

    // The outer cast_vote succeeded normally — votes counted once
    let proposal = gov.get_proposal(&proposal_id);
    assert_eq!(proposal.votes_yes, 10_000_000i128, "outer vote should be counted once");

    // The reentrant attempt must not have succeeded
    assert!(
        !load_attack_succeeded(&env),
        "reentrant cast_vote during get_delegated_weight must be blocked"
    );
}

// ---------------------------------------------------------------------------
// Test 2: Re-entering finalise during total_supply is blocked
// ---------------------------------------------------------------------------

#[test]
fn test_reentrant_finalise_is_blocked() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let voter = Address::generate(&env);

    // Register the malicious token
    let token_id = env.register(ReentrantFinaliseToken, ());

    let gov_id = env.register(GovernanceContract, ());
    let gov = GovernanceContractClient::new(&env, &gov_id);
    gov.initialize(&admin, &token_id, &0i128, &0u64, &0u32, &false, &None, &0u32);

    // Wire up the malicious token to point back at governance
    fstore_gov(&env, &gov_id);

    let proposal_id = make_proposal(&gov, &env, &voter);
    fstore_proposal_id(&env, proposal_id);

    // Cast a vote so the proposal can be finalised
    gov.cast_vote(&voter, &proposal_id, &Vote::Yes);

    // Advance past the voting period so finalise is allowed
    env.ledger().with_mut(|l| {
        l.timestamp += 604_801u64;
    });

    // finalise triggers total_supply on the malicious token, which tries to re-enter finalise
    gov.finalise(&proposal_id);

    // The reentrant attempt must not have succeeded
    assert!(
        !fload_attack_succeeded(&env),
        "reentrant finalise during total_supply must be blocked"
    );

    // Governance state remains usable
    let proposal = gov.get_proposal(&proposal_id);
    assert_eq!(proposal.state, ProposalState::Passed);
}

// ---------------------------------------------------------------------------
// Governance + Treasury cross-contract interaction tests
// ---------------------------------------------------------------------------

use cosmosvote_treasury::{TreasuryContract, TreasuryContractClient};
use crate::types::TreasuryAction;

/// Deploy governance, token, and treasury wired together, returning their clients.
fn setup_gov_treasury(
    env: &Env,
) -> (
    GovernanceContractClient<'static>,
    TokenContractClient<'static>,
    TreasuryContractClient<'static>,
    Address,
    Address,
) {
    let admin = Address::generate(env);
    let voter = Address::generate(env);

    // SEP-41 token used for voting weight and token disbursements
    let token_id = env.register(TokenContract, ());
    let token = TokenContractClient::new(env, &token_id);
    token.initialize(&admin, &String::from_str(env, "Vote"), &String::from_str(env, "VOTE"), &7u32);
    token.mint(&voter, &1_000_000i128);

    // Treasury owned by governance
    let treasury_id = env.register(TreasuryContract, ());
    let treasury = TreasuryContractClient::new(env, &treasury_id);

    // Governance contract
    let gov_id = env.register(GovernanceContract, ());
    let gov = GovernanceContractClient::new(env, &gov_id);

    // Treasury must recognise governance as its authorised executor
    treasury.initialize(&admin, &gov_id);

    gov.initialize(&admin, &token_id, &0i128, &0u64, &0u32, &false, &None, &0u32);

    (gov, token, treasury, voter, treasury_id)
}

/// Create, pass, and execute a proposal carrying a TreasuryAction.
fn pass_and_execute(
    env: &Env,
    gov: &GovernanceContractClient,
    voter: &Address,
    action: &TreasuryAction,
) -> u64 {
    let proposal_id = gov.create_proposal(
        voter,
        &String::from_str(env, "Treasury Disbursement"),
        &String::from_str(env, "Disburse funds"),
        &1_000_000i128,
        &604_800u64,
        &None,
        &Some(action.clone()),
    );

    gov.cast_vote(voter, &proposal_id, &Vote::Yes);

    env.ledger().with_mut(|l| {
        l.timestamp += 604_801u64;
    });

    gov.finalise(&proposal_id);
    gov.execute(&proposal_id);

    proposal_id
}

// ---------------------------------------------------------------------------
// Test 3: XLM disbursement via governance execution
// ---------------------------------------------------------------------------

#[test]
fn test_governance_executes_xlm_disbursement() {
    let env = Env::default();
    env.mock_all_auths();

    let (gov, _token, treasury, voter, _treasury_id) = setup_gov_treasury(&env);

    let recipient = Address::generate(&env);
    let amount = 500_000i128;

    // Fund the treasury with XLM
    treasury.deposit_xlm(&voter, &amount);
    assert_eq!(treasury.get_xlm_balance(), amount);

    let action = TreasuryAction::DisburseXlm {
        recipient: recipient.clone(),
        amount,
    };

    let proposal_id = pass_and_execute(&env, &gov, &voter, &action);

    // Proposal executed successfully
    let proposal = gov.get_proposal(&proposal_id);
    assert_eq!(proposal.state, ProposalState::Executed);

    // Treasury disbursement occurred
    assert_eq!(treasury.get_xlm_balance(), 0i128, "treasury XLM should be drained");
    assert_eq!(treasury.get_xlm_disbursed(&recipient), amount, "recipient should receive XLM");
}

// ---------------------------------------------------------------------------
// Test 4: SEP-41 token disbursement via governance execution
// ---------------------------------------------------------------------------

#[test]
fn test_governance_executes_token_disbursement() {
    let env = Env::default();
    env.mock_all_auths();

    let (gov, token, treasury, voter, _treasury_id) = setup_gov_treasury(&env);

    let recipient = Address::generate(&env);
    let amount = 250_000i128;

    // Fund the treasury with SEP-41 tokens
    token.transfer(&voter, &treasury.address, &amount);
    assert_eq!(token.balance(&treasury.address), amount);

    let action = TreasuryAction::DisburseToken {
        token: token.address.clone(),
        recipient: recipient.clone(),
        amount,
    };

    let proposal_id = pass_and_execute(&env, &gov, &voter, &action);

    let proposal = gov.get_proposal(&proposal_id);
    assert_eq!(proposal.state, ProposalState::Executed);

    // Treasury disbursement occurred
    assert_eq!(token.balance(&treasury.address), 0i128, "treasury token balance should be drained");
    assert_eq!(token.balance(&recipient), amount, "recipient should receive tokens");
}

// ---------------------------------------------------------------------------
// Test 5: Non-governance caller cannot disburse treasury funds
// ---------------------------------------------------------------------------

#[test]
fn test_unauthorized_disbursement_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (_gov, _token, treasury, voter, _treasury_id) = setup_gov_treasury(&env);

    let attacker = Address::generate(&env);
    let recipient = Address::generate(&env);
    let amount = 100_000i128;

    treasury.deposit_xlm(&voter, &amount);

    // A non-governance caller attempts to disburse directly
    let result = treasury.try_disburse_xlm(&attacker, &recipient, &amount);
    assert!(result.is_err(), "non-governance caller must not disburse treasury funds");

    // Treasury balance is untouched
    assert_eq!(treasury.get_xlm_balance(), amount);
    assert_eq!(treasury.get_xlm_disbursed(&recipient), 0i128);
}
