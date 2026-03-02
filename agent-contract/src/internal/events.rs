use crate::*;

const EVENT_STANDARD: &str = "shade-contract-template";
const EVENT_STANDARD_VERSION: &str = "1.0.0";

#[derive(Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
#[must_use = "Don't forget to `.emit()` this event"]
pub enum Event<'a> {
    AgentRegistered {
        account_id: &'a AccountId,
        measurements: &'a FullMeasurementsHex,
        ppid: &'a Ppid,
        current_time_ms: U64,
        valid_until_ms: U64,
        // Cannot log attestation, it's too large
    },
    AgentRemoved {
        account_id: &'a AccountId,
        reasons: Vec<AgentRemovalReason>,
    },
}

impl Event<'_> {
    pub fn emit(&self) {
        let data = serde_json::json!(self);
        let event_json = serde_json::json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_STANDARD_VERSION,
            "event": data["event"],
            "data": [data["data"]]
        })
        .to_string();
        log!("EVENT_JSON:{}", event_json);
    }
}
