use crate::*;

#[near]
impl Contract {
    // Update the attestation expiration time
    pub fn update_attestation_expiration_time(&mut self, attestation_expiration_time_ms: U64) {
        self.require_owner();
        self.attestation_expiration_time_ms = attestation_expiration_time_ms.into();
    }

    // Update the owner account ID
    pub fn update_owner_id(&mut self, owner_id: AccountId) {
        self.require_owner();
        self.owner_id = owner_id;
    }

    // Update the MPC contract ID
    pub fn update_mpc_contract_id(&mut self, mpc_contract_id: AccountId) {
        self.require_owner();
        self.mpc_contract_id = mpc_contract_id;
    }

    // Add a new set of measurements to the approved list
    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        self.approved_measurements.insert(measurements);
    }

    // Remove a set of measurements from the approved list
    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        require!(
            self.approved_measurements.remove(&measurements),
            "Measurements not in approved list"
        );
    }

    // Add an array of PPIDs to the approved list
    pub fn approve_ppids(&mut self, ppids: Vec<Ppid>) {
        self.require_owner();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    // Remove an array of PPIDs from the approved list.
    pub fn remove_ppids(&mut self, ppids: Vec<Ppid>) {
        self.require_owner();
        for id in ppids {
            require!(self.approved_ppids.remove(&id), "PPID not in approved list");
        }
    }

    // Remove an agent from the registered list
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        require!(
            self.agents.remove(&account_id).is_some(),
            "Agent not registered"
        );
        Event::AgentRemoved {
            account_id: &account_id,
            reasons: vec![AgentRemovalReason::ManualRemoval],
        }
        .emit();
    }

    // Function to update the contract code
    // Input format: [gas_bytes (8 bytes u64 little-endian)] + [wasm_code_bytes...]
    // See tests/update_contract_tests.rs for an example of how to call this function
    pub fn update_contract(&mut self) -> Promise {
        self.require_owner();

        let input = env::input().expect("Error: No input").to_vec();

        require!(
            input.len() >= 8,
            "Input must be at least 8 bytes: first 8 bytes are gas (u64), followed by WASM code"
        );

        // First 8 bytes are gas (u64 in little-endian)
        let gas_bytes: [u8; 8] = input[0..8].try_into().unwrap();
        let gas_tgas = u64::from_le_bytes(gas_bytes);

        // Rest is the WASM code
        let code = input[8..].to_vec();

        require!(!code.is_empty(), "WASM code cannot be empty");

        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate".to_string(),
                b"".to_vec(),
                NearToken::from_near(0),
                Gas::from_tgas(gas_tgas),
            )
            .as_return()
    }

    // Local only functions

    // Whitelist an agent, it will still need to register afterwards
    pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
        if self.requires_tee {
            panic!("Whitelisting agents is not supported for TEE");
        }
        self.require_owner();
        // Only insert if not already whitelisted
        self.whitelisted_agents_for_local.insert(account_id);
    }

    // Remove an agent from the list of whitelisted agents
    pub fn remove_agent_from_whitelist_for_local(&mut self, account_id: AccountId) {
        if self.requires_tee {
            panic!("Removing agents is not supported for TEE");
        }
        self.require_owner();
        require!(
            self.whitelisted_agents_for_local.remove(&account_id),
            "Agent not in whitelist for local"
        );
    }
}
