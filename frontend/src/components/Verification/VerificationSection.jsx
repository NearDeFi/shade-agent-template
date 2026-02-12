import { useState, useEffect } from "react";
import {
  getIsTee,
  getApprovedMeasurements,
  getApprovedPpids,
  getAgents,
} from "../../utils/near";
import RequiresTeeBox from "./RequiresTeeBox";
import ApprovedMeasurementsBox from "./ApprovedMeasurementsBox";
import ApprovedPpidsBox from "./ApprovedPpidsBox";
import AgentListBox from "./AgentListBox";

export default function VerificationSection({ onError }) {
  const [requiresTee, setRequiresTee] = useState(null);
  const [measurements, setMeasurements] = useState(null);
  const [ppids, setPpids] = useState(null);
  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      setError(null);
      try {
        const [tee, meas, p, ag] = await Promise.all([
          getIsTee(),
          getApprovedMeasurements(),
          getApprovedPpids(),
          getAgents(),
        ]);
        if (cancelled) return;
        setRequiresTee(tee);
        setMeasurements(meas);
        setPpids(p);
        setAgents(ag);
      } catch (err) {
        if (!cancelled) {
          const msg = err?.message ?? "Failed to load verification data";
          setError(msg);
          onError?.(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const teeError = requiresTee === null && !loading ? error : null;
  const measError = measurements === null && !loading ? error : null;
  const ppidsError = ppids === null && !loading ? error : null;
  const agentsError = agents === null && !loading ? error : null;

  return (
    <section className="verification-section">
      <h2 className="verification-section-title">Verification</h2>

      <RequiresTeeBox
        requiresTee={requiresTee}
        loading={loading}
        error={teeError}
      />

      <div className="verification-two-boxes">
        <ApprovedMeasurementsBox
          measurements={measurements}
          loading={loading}
          error={measError}
        />
        <ApprovedPpidsBox ppids={ppids} loading={loading} error={ppidsError} />
      </div>

      <AgentListBox agents={agents} loading={loading} error={agentsError} />
    </section>
  );
}
