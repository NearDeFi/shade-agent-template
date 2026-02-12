use crate::*;

// Write your own functions here

// Request a signature for a transaction payload if its a valid agent
#[near]
impl Contract {
    pub fn request_signature(
        &mut self,
        path: String,
        payload: String,
        key_type: String,
    ) -> Promise {
        // Require the caller to be a valid agent, panic if not
        if let Some(failure_promise) = self.require_valid_agent() {
            return failure_promise;
        }

        self.internal_request_signature(path, payload, key_type)
    }
}
