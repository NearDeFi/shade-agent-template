mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use shade_contract_template::ContractInfo;
use tokio::time::{Duration, sleep};

/// Tests owner transfer and new owner operations
#[tokio::test]
async fn test_owner_transfer_and_new_owner_operations()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Create new owner account
    let (new_owner_id, new_owner_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "new_owner",
    )
    .await?;

    // Verify initial owner
    let contract_info: Data<ContractInfo> = call_view(
        &contract_id,
        "get_contract_info",
        json!({}),
        &network_config,
    )
    .await?;
    assert_eq!(
        contract_info.data.owner_id, genesis_account_id,
        "Initial owner should be genesis account"
    );

    // Transfer ownership
    let _ = call_transaction(
        &contract_id,
        "update_owner_id",
        json!({
            "owner_id": new_owner_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(500)).await;

    // Verify owner was updated using get_contract_info
    let contract_info: Data<ContractInfo> = call_view(
        &contract_id,
        "get_contract_info",
        json!({}),
        &network_config,
    )
    .await?;
    assert_eq!(
        contract_info.data.owner_id, new_owner_id,
        "Owner should be updated to new owner"
    );

    // Verify old owner cannot approve measurements
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
    .assert_failure();

    // Verify new owner can approve measurements (default already approved by deploy; re-approving is idempotent)
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        &new_owner_id,
        &new_owner_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify measurements are approved
    let approved_measurements: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_approved_measurements",
        json!({
            "from_index": null,
            "limit": null
        }),
        &network_config,
    )
    .await?;

    assert!(
        approved_measurements.data.len() >= 1,
        "Default measurements should be in approved list"
    );

    Ok(())
}
