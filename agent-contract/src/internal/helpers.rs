use crate::*;

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRemovalReason {
    ManualRemoval,
    ExpiredAttestation,
    InvalidMeasurements,
    InvalidPpid,
    NotWhitelistedForLocal,
}

impl Contract {
    // Require the caller to be the owner
    pub(crate) fn require_owner(&mut self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Caller is not the owner"
        );
    }

    // Require the caller to be a valid agent or remove it from the agents map
    // Just because an agent is registered does not mean it is currently valid
    // Returns Some(Promise) if agent is invalid (to fail the request), None if valid
    pub(crate) fn require_valid_agent(&mut self) -> Option<Promise> {
        let account_id = env::predecessor_account_id();

        // Get the agent and check if it is registered
        let agent = self.agents.get(&account_id).expect("Agent not registered");

        // Check if the agent is invalid and return a promise to panic if it is
        let removal_reasons = self.check_invalid_reasons(&account_id, &agent);

        if !removal_reasons.is_empty() {
            self.agents.remove(&account_id);
            Event::AgentRemoved {
                account_id: &account_id,
                reasons: removal_reasons.clone(),
            }
            .emit();

            let args_json = serde_json::json!({
                "reasons": removal_reasons
            });

            let promise = Promise::new(env::current_account_id()).function_call(
                "fail_on_invalid_agent".to_string(),
                serde_json::to_vec(&args_json).expect("Failed to serialize reasons"),
                NearToken::from_near(0),
                Gas::from_tgas(10),
            );
            return Some(promise);
        }
        None
    }

    pub(crate) fn check_invalid_reasons(
        &self,
        account_id: &AccountId,
        agent: &Agent,
    ) -> Vec<AgentRemovalReason> {
        let mut reasons = Vec::new();
        if agent.valid_until_ms < block_timestamp_ms() {
            reasons.push(AgentRemovalReason::ExpiredAttestation);
        }
        if !self.approved_measurements.contains(&agent.measurements) {
            reasons.push(AgentRemovalReason::InvalidMeasurements);
        }
        if !self.approved_ppids.contains(&agent.ppid) {
            reasons.push(AgentRemovalReason::InvalidPpid);
        }
        if !self.requires_tee {
            if !self.whitelisted_agents_for_local.contains(account_id) {
                reasons.push(AgentRemovalReason::NotWhitelistedForLocal);
            }
        }
        reasons
    }
}

#[near]
impl Contract {
    #[private]
    pub fn fail_on_invalid_agent(reasons: Vec<AgentRemovalReason>) {
        env::panic_str(&format!("Invalid agent: {:?}", reasons));
    }
}
