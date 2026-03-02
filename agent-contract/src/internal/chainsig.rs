use crate::*;

#[derive(Debug, Serialize)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[derive(Debug, Serialize)]
pub struct SignRequest {
    pub payload_v2: Payload,
    pub path: String,
    pub domain_id: u64,
}

#[allow(dead_code)]
#[ext_contract(mpc_contract)]
trait MPCContract {
    fn sign(&self, request: SignRequest);
}

const GAS: Gas = Gas::from_tgas(15);
const ATTACHED_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

impl Contract {
    pub(crate) fn internal_request_signature(
        &self,
        path: String,
        payload: String,
        key_type: String,
    ) -> Promise {
        // Convert the payload to the correct type
        let (payload_v2, domain_id) = match key_type.as_str() {
            "Ecdsa" => (Payload::Ecdsa(payload), 0),
            "Eddsa" => (Payload::Eddsa(payload), 1),
            _ => {
                panic!("Invalid key type");
            }
        };

        // Create the request
        let request = SignRequest {
            payload_v2,
            path,
            domain_id,
        };

        // Call the sign function on the MPC contract
        mpc_contract::ext(self.mpc_contract_id.clone())
            .with_static_gas(GAS)
            .with_attached_deposit(ATTACHED_DEPOSIT)
            .sign(request)
    }
}
