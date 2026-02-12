mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use shade_attestation::attestation::create_mock_dstack_attestation;
use tokio::time::{Duration, sleep};

/// Tests pagination with large dataset
#[tokio::test]
async fn test_large_dataset_pagination_real_contract()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Create 20 agents, whitelist and register each (default measurements/PPID already approved by deploy)
    let mut agent_ids = Vec::new();
    for i in 0..20 {
        let (agent_id, agent_signer) = create_user_account(
            &network_config,
            &genesis_account_id,
            &genesis_signer,
            &format!("agent{}", i),
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

        agent_ids.push(agent_id);
    }

    sleep(Duration::from_millis(500)).await;

    // Test pagination - get first 5
    let first_page: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_agents",
        json!({
            "from_index": 0,
            "limit": 5
        }),
        &network_config,
    )
    .await?;

    assert_eq!(first_page.data.len(), 5, "First page should have 5 agents");

    // Test pagination - get next 5
    let second_page: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_agents",
        json!({
            "from_index": 5,
            "limit": 5
        }),
        &network_config,
    )
    .await?;

    assert_eq!(
        second_page.data.len(),
        5,
        "Second page should have 5 agents"
    );

    // Test pagination - get last 5 agents
    let last_page: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_agents",
        json!({
            "from_index": 15,
            "limit": 10
        }),
        &network_config,
    )
    .await?;

    assert_eq!(last_page.data.len(), 5, "Last page should have 5 agents");

    // Test pagination - get all agents
    let all_agents: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_agents",
        json!({
            "from_index": null,
            "limit": null
        }),
        &network_config,
    )
    .await?;

    assert_eq!(all_agents.data.len(), 20, "Should have all 20 agents");

    // Test pagination with limit larger than total agents
    let large_limit: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_agents",
        json!({
            "from_index": 0,
            "limit": 100
        }),
        &network_config,
    )
    .await?;

    assert_eq!(
        large_limit.data.len(),
        20,
        "Should return all agents even with large limit"
    );

    Ok(())
}
