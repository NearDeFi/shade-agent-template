use crate::*;
use near_sdk::test_utils::{VMContextBuilder, accounts};
use near_sdk::{AccountId, NearToken, testing_env};
use shade_attestation::{
    attestation::create_mock_dstack_attestation,
    measurements::{FullMeasurementsHex, MeasurementsHex, create_mock_full_measurements_hex},
    tcb_info::HexBytes,
};

// Only testing requires_tee = false since we cannot produce a valid attestation for a TEE in unit tests

// Deposit constants for tests
const DEPOSIT_005_NEAR: NearToken = NearToken::from_yoctonear(5_000_000_000_000_000_000_000); // 0.005 NEAR
const DEPOSIT_003_NEAR: NearToken = NearToken::from_yoctonear(3_000_000_000_000_000_000_000); // 0.003 NEAR
const DEPOSIT_ZERO: NearToken = NearToken::from_yoctonear(0);

// Helper function to create a mock context
fn get_context(predecessor: AccountId, is_view: bool) -> VMContextBuilder {
    get_context_with_deposit(predecessor, is_view, None)
}

// Helper function to create a mock context with attached deposit
fn get_context_with_deposit(
    predecessor: AccountId,
    is_view: bool,
    deposit: Option<NearToken>,
) -> VMContextBuilder {
    get_context_with_deposit_and_timestamp(predecessor, is_view, deposit, None)
}

// Helper function to create a mock context with attached deposit and block timestamp
fn get_context_with_deposit_and_timestamp(
    predecessor: AccountId,
    is_view: bool,
    deposit: Option<NearToken>,
    block_timestamp_ms: Option<u64>,
) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(accounts(0))
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .is_view(is_view);
    if let Some(dep) = deposit {
        builder.attached_deposit(dep);
    }
    if let Some(ts) = block_timestamp_ms {
        builder.block_timestamp(ts * 1_000_000); // Convert ms to nanoseconds
    }
    builder
}

/// Returns measurements that differ from default (one byte different in mrtd).
fn non_default_measurements() -> FullMeasurementsHex {
    let mut mrtd = [0u8; 48];
    mrtd[0] = 1;
    FullMeasurementsHex {
        rtmrs: MeasurementsHex {
            mrtd: HexBytes::from(mrtd),
            rtmr0: HexBytes::from([0; 48]),
            rtmr1: HexBytes::from([0; 48]),
            rtmr2: HexBytes::from([0; 48]),
        },
        key_provider_event_digest: HexBytes::from([0; 48]),
        app_compose_hash_payload: HexBytes::from([0; 32]),
    }
}

/// Returns PPID that differs from default (all zeros).
fn non_default_ppid() -> Ppid {
    HexBytes::from([1u8; 16])
}

// Helper function to initialize contract (with default measurements and PPID approved for local mode)
fn setup_contract() -> Contract {
    let owner = accounts(0);
    let mpc_contract = accounts(1);
    let context = get_context(owner.clone(), false);
    testing_env!(context.build());
    // Use a short expiration time for tests: 100 seconds = 100000 ms
    let mut contract = Contract::new(
        false,
        U64::from(100000u64), // 100 seconds in milliseconds
        owner,
        mpc_contract,
    );
    contract.approve_measurements(create_mock_full_measurements_hex());
    contract.approve_ppids(vec![Ppid::default()]);
    contract
}

// Test contract initialization with correct owner, MPC contract, and empty collections
#[test]
fn test_new() {
    let owner = accounts(0);
    let mpc_contract = accounts(1);
    let context = get_context(owner.clone(), false);
    testing_env!(context.build());

    // Use a short expiration time for tests: 100 seconds = 100000 ms
    let attestation_expiration_time_ms = U64::from(100000u64);
    let contract = Contract::new(
        false,
        attestation_expiration_time_ms,
        owner.clone(),
        mpc_contract.clone(),
    );

    let contract_info = contract.get_contract_info();
    assert_eq!(contract_info.owner_id, owner);
    assert_eq!(contract_info.mpc_contract_id, mpc_contract);
    assert_eq!(contract_info.requires_tee, false);
    assert_eq!(contract_info.attestation_expiration_time_ms.0, 100000u64);
    assert_eq!(contract.get_approved_measurements(&None, &None).len(), 0);
    assert_eq!(contract.get_approved_ppids(&None, &None).len(), 0);
    assert_eq!(contract.get_agents(&None, &None).len(), 0);
    assert_eq!(contract.get_whitelisted_agents_for_local().len(), 0);
}

// Test that owner can approve measurements and it appears in the approved list
#[test]
fn test_approve_measurements() {
    let mut contract = setup_contract();

    let measurements = create_mock_full_measurements_hex();
    contract.approve_measurements(measurements.clone());

    assert!(
        contract
            .get_approved_measurements(&None, &None)
            .contains(&measurements)
    );
    assert_eq!(contract.get_approved_measurements(&None, &None).len(), 1);
}

// Test that non-owner cannot approve measurements
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_approve_measurements_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.approve_measurements(create_mock_full_measurements_hex());
}

// Test that owner can remove measurements from the approved list
#[test]
fn test_remove_measurements() {
    let mut contract = setup_contract();

    let extra = create_mock_full_measurements_hex();
    contract.approve_measurements(extra.clone());
    let count_before = contract.get_approved_measurements(&None, &None).len();
    assert_eq!(count_before, 1);

    contract.remove_measurements(extra.clone());
    assert!(
        !contract
            .get_approved_measurements(&None, &None)
            .contains(&extra)
    );
}

// Test that non-owner cannot remove measurements from the approved list
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_measurements_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    contract.approve_measurements(create_mock_full_measurements_hex());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_measurements(create_mock_full_measurements_hex());
}

// Test that remove_measurements panics when measurements are not in the approved list
#[test]
#[should_panic(expected = "Measurements not in approved list")]
fn test_remove_measurements_not_found() {
    let mut contract = setup_contract();
    // Try to remove measurements that were never approved
    contract.remove_measurements(non_default_measurements());
}

// Test that remove_ppids panics when PPID is not in the approved list
#[test]
#[should_panic(expected = "PPID not in approved list")]
fn test_remove_ppids_not_found() {
    let mut contract = setup_contract();
    // Try to remove PPID that was never approved
    contract.remove_ppids(vec![non_default_ppid()]);
}

// Test that owner can whitelist an agent for local and agent appears in whitelist (not yet registered)
#[test]
fn test_whitelist_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let whitelisted = contract.get_whitelisted_agents_for_local();
    assert!(whitelisted.contains(&agent));
    // Not registered yet, so get_agent returns None
    assert!(contract.get_agent(agent.clone()).is_none());
}

// Test that whitelisting an agent twice doesn't create duplicates
#[test]
fn test_whitelist_agent_twice() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());
    contract.whitelist_agent_for_local(agent.clone()); // Should not panic

    let whitelisted = contract.get_whitelisted_agents_for_local();
    assert_eq!(whitelisted.len(), 1);
}

// Test that whitelisting an already registered agent doesn't unregister it
#[test]
fn test_whitelist_agent_after_registration() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent
    contract.whitelist_agent_for_local(agent.clone());

    // Register agent (default measurements and PPID already approved in setup)
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered and valid
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));

    // Whitelist agent again (should not unregister)
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.whitelist_agent_for_local(agent.clone());

    // Verify agent is still registered and valid
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));
}

// Test that non-owner cannot whitelist an agent
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_whitelist_agent_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.whitelist_agent_for_local(agent);
}

// Test that remove_agent_for_local panics when agent is not in the whitelist
#[test]
#[should_panic(expected = "Agent not in whitelist for local")]
fn test_remove_agent_for_local_not_found() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    // Agent was never whitelisted
    contract.remove_agent_from_whitelist_for_local(agent);
}

// Test that owner can remove an agent from the whitelist (local)
#[test]
fn test_remove_agent_from_whitelist() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());
    assert!(contract.get_whitelisted_agents_for_local().contains(&agent));

    contract.remove_agent_from_whitelist_for_local(agent.clone());
    assert!(!contract.get_whitelisted_agents_for_local().contains(&agent));
    assert!(contract.get_agent(agent).is_none());
}

// Test that non-owner cannot remove an agent from the whitelist
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_agent_for_local_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_agent_from_whitelist_for_local(agent);
}

// Test that owner can remove a registered agent from the agents map
#[test]
fn test_remove_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());
    assert!(contract.get_agent(agent.clone()).is_some());

    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_agent(agent.clone());
    assert!(contract.get_agent(agent).is_none());
}

// Test that remove_agent panics when agent is not registered
#[test]
#[should_panic(expected = "Agent not registered")]
fn test_remove_agent_not_found() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    // Agent was never registered
    contract.remove_agent(agent);
}

// Test that non-owner cannot remove a registered agent
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_agent_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    contract.whitelist_agent_for_local(agent.clone());
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_agent(agent);
}

// Test that a whitelisted agent can register with sufficient deposit
#[test]
fn test_register_agent_without_tee() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Owner whitelists the agent (default measurements and PPID already approved in setup)
    contract.whitelist_agent_for_local(agent.clone());

    // Agent registers with fake attestation and 0.005 NEAR deposit
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());

    let result = contract.register_agent(create_mock_dstack_attestation());
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));
}

// Test that an agent can register twice and the registration is updated
#[test]
fn test_register_agent_twice() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent first time with 0.005 NEAR deposit
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    let result = contract.register_agent(create_mock_dstack_attestation());
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));

    // Register agent again with 0.005 NEAR deposit
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    let result = contract.register_agent(create_mock_dstack_attestation());
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));
}

// Test that an agent cannot register if not whitelisted for local
#[test]
#[should_panic(expected = "Agent needs to be whitelisted for local mode")]
fn test_register_agent_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    let context = get_context_with_deposit(agent, false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());

    contract.register_agent(create_mock_dstack_attestation());
}

// Test that register_agent fails with insufficient deposit (0 NEAR)
#[test]
#[should_panic(expected = "Attached deposit must be greater than storage cost")]
fn test_register_agent_insufficient_deposit_zero() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Try to register with 0 NEAR deposit
    let context = get_context_with_deposit(agent, false, Some(DEPOSIT_ZERO));
    testing_env!(context.build());

    contract.register_agent(create_mock_dstack_attestation());
}

// Test that register_agent fails with insufficient deposit (0.003 NEAR)
#[test]
#[should_panic(expected = "Attached deposit must be greater than storage cost")]
fn test_register_agent_insufficient_deposit_low() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Try to register with 0.003 NEAR deposit (less than storage cost)
    let context = get_context_with_deposit(agent, false, Some(DEPOSIT_003_NEAR));
    testing_env!(context.build());

    contract.register_agent(create_mock_dstack_attestation());
}

// Test that owner can update the owner ID
#[test]
fn test_update_owner_id() {
    let mut contract = setup_contract();
    let new_owner = accounts(3);

    contract.update_owner_id(new_owner.clone());
    let contract_info = contract.get_contract_info();
    assert_eq!(contract_info.owner_id, new_owner);
}

// Test that non-owner cannot update the owner ID
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_update_owner_id_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let new_owner = accounts(3);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.update_owner_id(new_owner);
}

// Test that owner can update the MPC contract ID
#[test]
fn test_update_mpc_contract_id() {
    let mut contract = setup_contract();
    let new_mpc = accounts(4);

    contract.update_mpc_contract_id(new_mpc.clone());
    let contract_info = contract.get_contract_info();
    assert_eq!(contract_info.mpc_contract_id, new_mpc);
}

// Test that non-owner cannot update the MPC contract ID
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_update_mpc_contract_id_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let new_mpc = accounts(4);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.update_mpc_contract_id(new_mpc);
}

// Test that owner can update the attestation expiration time
#[test]
fn test_update_attestation_expiration_time() {
    let mut contract = setup_contract();
    let new_expiration_time = U64::from(200000u64); // 200 seconds

    contract.update_attestation_expiration_time(new_expiration_time.clone());
    let contract_info = contract.get_contract_info();
    assert_eq!(contract_info.attestation_expiration_time_ms.0, 200000u64);
}

// Test that non-owner cannot update the attestation expiration time
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_update_attestation_expiration_time_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let new_expiration_time = U64::from(200000u64);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.update_attestation_expiration_time(new_expiration_time);
}

// Test that get_contract_info returns the correct values
#[test]
fn test_get_contract_info() {
    let contract = setup_contract();
    let contract_info = contract.get_contract_info();
    assert_eq!(contract_info.requires_tee, false);
    assert_eq!(contract_info.attestation_expiration_time_ms.0, 100000u64);
}

// Test that get_approved_measurements returns approved measurements and pagination works
#[test]
fn test_get_approved_measurements() {
    let mut contract = setup_contract();

    let default = create_mock_full_measurements_hex();
    contract.approve_measurements(default.clone());

    let all = contract.get_approved_measurements(&None, &None);
    assert_eq!(all.len(), 1);
    assert!(all.contains(&default));

    // Test pagination
    let first_two = contract.get_approved_measurements(&Some(0), &Some(2));
    assert_eq!(first_two.len(), 1);
}

// Test that get_agents returns only registered agents, pagination works, and validity reflects current approvals
#[test]
fn test_get_agents() {
    let mut contract = setup_contract();
    let agent1 = accounts(2);
    let agent2 = accounts(3);
    let agent3 = accounts(4);

    contract.whitelist_agent_for_local(agent1.clone());
    contract.whitelist_agent_for_local(agent2.clone());
    contract.whitelist_agent_for_local(agent3.clone());

    // None registered yet
    assert_eq!(contract.get_agents(&None, &None).len(), 0);

    // Register agent1 and agent2; agent3 remains unregistered
    let context = get_context_with_deposit(agent1.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context_with_deposit(agent2.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    assert!(contract.get_agent(agent3.clone()).is_none());

    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 2);

    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(matches!(agent1_info.validity, AgentValidity::Valid));

    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(matches!(agent2_info.validity, AgentValidity::Valid));

    // Pagination
    assert_eq!(contract.get_agents(&Some(0), &Some(1)).len(), 1);

    // Remove default measurements; approval flags should update
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_measurements(create_mock_full_measurements_hex());

    let agents = contract.get_agents(&None, &None);
    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(
        matches!(agent1_info.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidMeasurements))
    );

    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(
        matches!(agent2_info.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidMeasurements))
    );
}

// Test that get_agent returns correct agent information (None when not registered, Some when registered)
#[test]
fn test_get_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Agent not whitelisted / not registered
    assert!(contract.get_agent(agent.clone()).is_none());

    // Whitelist agent but don't register
    contract.whitelist_agent_for_local(agent.clone());
    assert!(contract.get_agent(agent.clone()).is_none());

    // Register agent
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert_eq!(agent_info.account_id, agent);
    assert!(matches!(agent_info.validity, AgentValidity::Valid));
}

// Test that request_signature removes agent if the agent is registered but not whitelisted for local.
// Returns a failure promise (fail_on_invalid_agent) that resolves to panic; integration tests verify the promise resolves to error.
#[test]
fn test_request_signature_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Register agent first (while whitelisted)
    contract.whitelist_agent_for_local(agent.clone());
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered
    assert!(contract.get_agent(agent.clone()).is_some());

    // Remove agent from whitelist
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_agent_from_whitelist_for_local(agent.clone());

    // Call request_signature - should remove agent because it's not whitelisted
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Agent should be removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that request_signature fails if the agent is whitelisted but not registered
#[test]
#[should_panic(expected = "Agent not registered")]
fn test_request_signature_not_registered() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that require_valid_agent removes agent and emits event when measurements are invalid
#[test]
fn test_require_valid_agent_removes_on_invalid_measurements() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered
    assert!(contract.get_agent(agent.clone()).is_some());

    // Remove measurements from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_measurements(create_mock_full_measurements_hex());

    // Call require_valid_agent - should remove agent and emit event (not panic)
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.require_valid_agent();

    // Verify agent is removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that require_valid_agent removes agent and emits event when PPID is invalid
#[test]
fn test_require_valid_agent_removes_on_invalid_ppid() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered
    assert!(contract.get_agent(agent.clone()).is_some());

    // Remove PPID from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_ppids(vec![Ppid::default()]);

    // Call require_valid_agent - should remove agent and emit event (not panic)
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.require_valid_agent();

    // Verify agent is removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that require_valid_agent removes agent and emits event when not whitelisted for local
#[test]
fn test_require_valid_agent_removes_on_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered
    assert!(contract.get_agent(agent.clone()).is_some());

    // Remove agent from whitelist
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_agent_from_whitelist_for_local(agent.clone());

    // Call require_valid_agent - should remove agent and emit event (not panic)
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.require_valid_agent();

    // Verify agent is removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that require_valid_agent removes agent and emits event with multiple reasons
#[test]
fn test_require_valid_agent_removes_with_multiple_reasons() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent
    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered
    assert!(contract.get_agent(agent.clone()).is_some());

    // Remove measurements, PPID, and whitelist to trigger multiple reasons
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_measurements(create_mock_full_measurements_hex());
    contract.remove_ppids(vec![Ppid::default()]);
    contract.remove_agent_from_whitelist_for_local(agent.clone());

    // Call require_valid_agent - should remove agent and emit event with multiple reasons (not panic)
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.require_valid_agent();

    // Verify agent is removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that request_signature removes agent when measurements are removed from the approved list
#[test]
fn test_request_signature_measurements_removed() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Remove default measurements from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_measurements(create_mock_full_measurements_hex());

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(
        matches!(agent_info.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidMeasurements))
    );

    // Call request_signature - should remove agent and emit event, then continue
    // The agent is removed, so on next call it will panic
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise2 = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Agent should be removed from map after require_valid_agent removed it
    assert!(contract.get_agent(agent).is_none());
}

// Test that request_signature removes agent when PPID is removed from the approved list.
// Returns a failure promise (fail_on_invalid_agent) that resolves to panic; integration tests verify the promise resolves to error.
#[test]
fn test_request_signature_ppid_removed() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Remove default PPID from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_ppids(vec![Ppid::default()]);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(
        matches!(agent_info.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::InvalidPpid))
    );

    // Call request_signature - should remove agent and emit event, then continue
    // The agent is removed, so on next call it will panic
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise2 = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Agent should be removed from map after require_valid_agent removed it
    assert!(contract.get_agent(agent).is_none());
}

// Test that request_signature succeeds when agent is whitelisted, registered, and measurements/PPID approved (Ecdsa)
#[test]
fn test_request_signature_success() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature succeeds with Eddsa key type
#[test]
fn test_request_signature_with_eddsa() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Eddsa".to_string(),
    );
}

// Test that request_signature panics when key_type is not exactly "Ecdsa" or "Eddsa"
#[test]
#[should_panic(expected = "Invalid key type")]
fn test_request_signature_invalid_key_type() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context_with_deposit(agent.clone(), false, Some(DEPOSIT_005_NEAR));
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "invalid".to_string(),
    );
}

// Test that request_signature removes agent when attestation expires.
#[test]
fn test_request_signature_expired_attestation() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent at timestamp 1000 ms
    let context = get_context_with_deposit_and_timestamp(
        agent.clone(),
        false,
        Some(DEPOSIT_005_NEAR),
        Some(1000u64),
    );
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Fast forward time past expiration (valid_until_ms = 1000 + 100000 = 101000)
    let context =
        get_context_with_deposit_and_timestamp(agent.clone(), false, None, Some(101001u64));
    testing_env!(context.build());

    // Call request_signature - should remove agent
    // Promise will fail but this can't be tested in unit tests
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Agent should be removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that require_valid_agent removes agent when attestation expires.
// When called via request_signature, returns a failure promise; integration tests verify the promise resolves to error.
#[test]
fn test_require_valid_agent_removes_on_expired_attestation() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent at timestamp 1000 ms
    let context = get_context_with_deposit_and_timestamp(
        agent.clone(),
        false,
        Some(DEPOSIT_005_NEAR),
        Some(1000u64),
    );
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Verify agent is registered and valid
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));

    // Fast forward time past expiration (attestation_expiration_time_ms is 100000 ms = 100 seconds)
    // So valid_until_ms should be 1000 + 100000 = 101000
    // Set time to 101001 ms (1 ms past expiration)
    let context =
        get_context_with_deposit_and_timestamp(agent.clone(), false, None, Some(101001u64));
    testing_env!(context.build());

    // Call require_valid_agent - should remove agent and emit event (not panic)
    contract.require_valid_agent();

    // Verify agent is removed from map
    assert!(contract.get_agent(agent).is_none());
}

// Test that get_agent shows validity correctly (Valid vs Invalid with ExpiredAttestation)
#[test]
fn test_get_agent_expiration_fields() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent at timestamp 1000 ms
    let context = get_context_with_deposit_and_timestamp(
        agent.clone(),
        false,
        Some(DEPOSIT_005_NEAR),
        Some(1000u64),
    );
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Check agent info - should be valid (not expired)
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(matches!(agent_info.validity, AgentValidity::Valid));
    assert_eq!(agent_info.valid_until_ms.0, 101000u64); // 1000 + 100000

    // Fast forward time past expiration
    // Note: We use is_view: false because contract drop needs to flush storage
    // View methods can still be called with is_view: false
    let context =
        get_context_with_deposit_and_timestamp(agent.clone(), false, None, Some(101001u64));
    testing_env!(context.build());

    // Check agent info - should be invalid (expired)
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(
        matches!(agent_info.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::ExpiredAttestation))
    );
    assert_eq!(agent_info.valid_until_ms.0, 101000u64);
}

// Test that get_agents shows validity correctly
#[test]
fn test_get_agents_expiration_fields() {
    let mut contract = setup_contract();
    let agent1 = accounts(2);
    let agent2 = accounts(3);

    contract.whitelist_agent_for_local(agent1.clone());
    contract.whitelist_agent_for_local(agent2.clone());

    // Register agent1 at timestamp 1000 ms
    let context = get_context_with_deposit_and_timestamp(
        agent1.clone(),
        false,
        Some(DEPOSIT_005_NEAR),
        Some(1000u64),
    );
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Register agent2 at timestamp 2000 ms
    let context = get_context_with_deposit_and_timestamp(
        agent2.clone(),
        false,
        Some(DEPOSIT_005_NEAR),
        Some(2000u64),
    );
    testing_env!(context.build());
    contract.register_agent(create_mock_dstack_attestation());

    // Check at timestamp 1001 ms - both should be valid
    // Note: We use is_view: false because contract drop needs to flush storage
    // View methods can still be called with is_view: false
    let context = get_context_with_deposit_and_timestamp(accounts(0), false, None, Some(1001u64));
    testing_env!(context.build());

    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 2);
    for agent_info in &agents {
        assert!(matches!(agent_info.validity, AgentValidity::Valid));
    }

    // Fast forward past agent1 expiration but not agent2
    // agent1 expires at 101000, agent2 expires at 102000
    // Note: We use is_view: false because contract drop needs to flush storage
    let context = get_context_with_deposit_and_timestamp(
        accounts(0),
        false,
        None,
        Some(101500u64), // Between the two expirations
    );
    testing_env!(context.build());

    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 2);
    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(
        matches!(agent1_info.validity, AgentValidity::Invalid(ref r) if r.contains(&AgentRemovalReason::ExpiredAttestation))
    );
    assert!(matches!(agent2_info.validity, AgentValidity::Valid));
}
