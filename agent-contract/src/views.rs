use crate::*;

#[near(serializers = [json])]
pub struct ContractInfo {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: U64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
}

#[near(serializers = [json])]
pub enum AgentValidity {
    Valid,
    Invalid(Vec<AgentRemovalReason>),
}

#[near(serializers = [json])]
pub struct AgentView {
    pub account_id: AccountId,
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: U64,
    pub validity: AgentValidity,
}

#[near]
impl Contract {
    // Get the contract info
    pub fn get_contract_info(&self) -> ContractInfo {
        ContractInfo {
            requires_tee: self.requires_tee,
            attestation_expiration_time_ms: U64::from(self.attestation_expiration_time_ms),
            owner_id: self.owner_id.clone(),
            mpc_contract_id: self.mpc_contract_id.clone(),
        }
    }

    // Get the list of approved PPIDs (paginated via from_index and limit)
    pub fn get_approved_ppids(&self, from_index: &Option<u32>, limit: &Option<u32>) -> Vec<Ppid> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.approved_ppids.len() as u32);

        self.approved_ppids
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    // Get the list of approved measurements
    pub fn get_approved_measurements(
        &self,
        from_index: &Option<u32>,
        limit: &Option<u32>,
    ) -> Vec<FullMeasurementsHex> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.approved_measurements.len() as u32);

        self.approved_measurements
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    // Get the details of a registered agent
    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        self.agents.get(&account_id).map(|agent| {
            let reasons = self.check_invalid_reasons(&account_id, agent);
            let validity = if reasons.is_empty() {
                AgentValidity::Valid
            } else {
                AgentValidity::Invalid(reasons)
            };
            AgentView {
                account_id: account_id.clone(),
                measurements: agent.measurements.clone(),
                ppid: agent.ppid.clone(),
                valid_until_ms: U64::from(agent.valid_until_ms),
                validity,
            }
        })
    }

    // Get the list of registered agents and their details
    pub fn get_agents(&self, from_index: &Option<u32>, limit: &Option<u32>) -> Vec<AgentView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.agents.len() as u32);

        self.agents
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|(account_id, agent)| {
                let reasons = self.check_invalid_reasons(account_id, agent);
                let validity = if reasons.is_empty() {
                    AgentValidity::Valid
                } else {
                    AgentValidity::Invalid(reasons)
                };
                AgentView {
                    account_id: account_id.clone(),
                    measurements: agent.measurements.clone(),
                    ppid: agent.ppid.clone(),
                    valid_until_ms: U64::from(agent.valid_until_ms),
                    validity,
                }
            })
            .collect()
    }

    // Local only functions

    // Get the list of whitelisted agents for local mode
    pub fn get_whitelisted_agents_for_local(&self) -> Vec<AccountId> {
        if self.requires_tee {
            panic!("Getting whitelisted agents is not supported for TEE");
        }
        self.whitelisted_agents_for_local.iter().cloned().collect()
    }
}
