mod helpers;

use helpers::*;
use near_api::{AccountId, Data};
use serde_json::json;
use shade_attestation::attestation::create_mock_dstack_attestation;
use shade_contract_template::ContractInfo;
use tokio::time::{Duration, sleep};

/// Tests that request_signature makes correct cross-contract call to MPC contract
#[tokio::test]
async fn test_cross_contract_call_to_mpc() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    // Deploy mock MPC contract
    let mpc_contract_id =
        deploy_mock_mpc_contract(&network_config, &genesis_account_id, &genesis_signer, "mpc")
            .await?;

    sleep(Duration::from_millis(200)).await;

    // Deploy main contract with mock MPC as the MPC contract
    // Use a short expiration time for tests: 100 seconds = 100000 ms
    let contract_id = deploy_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        CONTRACT_WASM_PATH,
        Some("new"),
        Some(json!({
            "owner_id": genesis_account_id,
            "mpc_contract_id": mpc_contract_id,
            "requires_tee": false,
            "attestation_expiration_time_ms": "100000"
        })),
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Approve default measurements and PPID for local mode registration
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

    let _ = call_transaction(
        &contract_id,
        "whitelist_agent_for_local",
        json!({
            "account_id": agent_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Register agent with 0.005 NEAR deposit
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(helpers::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Request signature - this should call the mock MPC contract
    let _ = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "0000000000000000000000000000000000000000000000000000000000000000",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Request signature - this should call the mock MPC contract (Eddsa key type)
    let _ = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "0000000000000000000000000000000000000000000000000000000000000000",
            "key_type": "Eddsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Verify initial MPC contract ID
    let contract_info: Data<ContractInfo> = call_view(
        &contract_id,
        "get_contract_info",
        json!({}),
        &network_config,
    )
    .await?;
    assert_eq!(
        contract_info.data.mpc_contract_id, mpc_contract_id,
        "Initial MPC contract ID should match deployed mock MPC"
    );

    // Update the mpc contract id to a new contract id
    let _ = call_transaction(
        &contract_id,
        "update_mpc_contract_id",
        json!({
            "mpc_contract_id": "new-mpc-contract"
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify MPC contract ID was updated using get_contract_info
    let contract_info: Data<ContractInfo> = call_view(
        &contract_id,
        "get_contract_info",
        json!({}),
        &network_config,
    )
    .await?;
    let new_mpc_id: AccountId = "new-mpc-contract".parse().unwrap();
    assert_eq!(
        contract_info.data.mpc_contract_id, new_mpc_id,
        "MPC contract ID should be updated to new-mpc-contract"
    );

    // Request signature - this should call the new mock MPC contract
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "0000000000000000000000000000000000000000000000000000000000000000",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .into_result();

    // Assert that the transaction failed with AccountDoesNotExist for mpc-contract not any other error
    match result {
        Ok(_) => {
            panic!(
                "Expected transaction to fail with AccountDoesNotExist for new-mpc-contract, but it succeeded"
            );
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("AccountDoesNotExist") && error_str.contains("new-mpc-contract"),
                "Expected AccountDoesNotExist error for mpc-contract, but got: {:?}",
                e
            );
        }
    }

    Ok(())
}
