mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{Duration, sleep};

#[tokio::test]
async fn test_update_contract() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Read the WASM bytes
    let wasm_bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/contracts/contract_update.wasm"
    ))?;

    // Pass gas (10 TGas) + WASM bytes concatenated
    // First 8 bytes: gas as u64 little-endian, then WASM code
    let gas_value: u64 = 10;
    let mut input = gas_value.to_le_bytes().to_vec();
    input.extend_from_slice(&wasm_bytes);

    call_transaction_raw(
        &contract_id,
        "update_contract",
        input,
        &genesis_account_id,
        &genesis_signer,
        &network_config,
    )
    .await?
    .into_result()
    .expect("update_contract should succeed");

    sleep(Duration::from_millis(200)).await;

    // Get the stored string (should be the owner_id from the migrated old state)
    let stored_string_result: Data<String> = call_view(
        &contract_id,
        "get_stored_string",
        json!({}),
        &network_config,
    )
    .await?;

    let initial_value = stored_string_result.data;

    // Verify it's the owner_id (genesis_account_id)
    assert_eq!(
        initial_value,
        genesis_account_id.to_string(),
        "Stored string should be the owner_id from old state"
    );

    // Set a new stored string
    let new_value = "Hello new contract!";
    let _ = call_transaction(
        &contract_id,
        "set_stored_string",
        json!({
            "stored_string": new_value
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Get the stored string again to verify it was updated
    let updated_result: Data<String> = call_view(
        &contract_id,
        "get_stored_string",
        json!({}),
        &network_config,
    )
    .await?;

    let updated_value = updated_result.data;

    // Verify it was updated
    assert_eq!(updated_value, new_value, "Stored string should be updated");

    Ok(())
}
