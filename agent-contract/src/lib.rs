use hex;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    env::{self, block_timestamp_ms},
    ext_contract,
    json_types::U64,
    log, near, require,
    serde::Serialize,
    serde_json,
    store::{IterableMap, IterableSet},
};
use shade_attestation::{
    attestation::DstackAttestation,
    measurements::{FullMeasurements, FullMeasurementsHex, create_mock_full_measurements_hex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

pub use internal::events::Event;
pub use internal::helpers::AgentRemovalReason;
pub use views::{AgentValidity, AgentView, ContractInfo};

mod internal;
mod owner;
pub mod views;
mod your_functions;

pub type Ppid = HexBytes<16>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: u64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub approved_ppids: IterableSet<Ppid>,
    pub agents: IterableMap<AccountId, Agent>,
    pub whitelisted_agents_for_local: IterableSet<AccountId>,
}

#[near(serializers = [borsh])]
pub struct Agent {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    ApprovedPpids,
    Agents,
    WhitelistedAgentsForLocal,
}

const STORAGE_BYTES_TO_REGISTER: u128 = 486;

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(
        requires_tee: bool,
        attestation_expiration_time_ms: U64,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
    ) -> Self {
        Self {
            requires_tee,
            attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
            owner_id,
            mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
            agents: IterableMap::new(StorageKey::Agents),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        // Require the agent to pay for the storage cost
        // You should update the STORAGE_BYTES_TO_REGISTER const if you store more data
        let storage_cost = env::storage_byte_cost()
            .checked_mul(STORAGE_BYTES_TO_REGISTER)
            .unwrap();
        require!(
            env::attached_deposit() >= storage_cost,
            &format!(
                "Attached deposit must be greater than storage cost {:?}",
                storage_cost.exact_amount_display()
            )
        );

        // Verify the attestation and get the measurements and PPID for the agent
        let (measurements, ppid) = self.verify_attestation(attestation.clone());

        let valid_until_ms = block_timestamp_ms() + self.attestation_expiration_time_ms;

        Event::AgentRegistered {
            account_id: &env::predecessor_account_id(),
            measurements: &measurements,
            ppid: &ppid,
            current_time_ms: U64::from(block_timestamp_ms()),
            valid_until_ms: U64::from(valid_until_ms),
        }
        .emit();

        // Register the agent
        self.agents.insert(
            env::predecessor_account_id(),
            Agent {
                measurements,
                ppid,
                valid_until_ms,
            },
        );

        true
    }
}
