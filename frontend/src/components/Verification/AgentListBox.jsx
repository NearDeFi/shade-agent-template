import { useState } from "react";
import ParsedMeasurement from "./ParsedMeasurement";

const REMOVAL_REASON_LABELS = {
  ExpiredAttestation: "Attestation has expired.",
  InvalidMeasurements: "Measurements are no longer valid.",
  InvalidPpid: "PPID is no longer valid.",
  NotWhitelistedForLocal: "The agent is no longer whitelisted.",
};

function reasonToSentence(reason) {
  if (typeof reason === "string") {
    return REMOVAL_REASON_LABELS[reason] ?? reason;
  }
  return String(reason);
}

function formatValidity(validity) {
  if (!validity) return "—";
  if (validity === "Valid" || validity.Valid !== undefined) return "Valid";
  if (validity.Invalid && Array.isArray(validity.Invalid)) {
    const sentences = validity.Invalid.map(reasonToSentence);
    return (
      <>
        Invalid:{" "}
        {sentences.map((s, i) => (
          <span key={i}>
            {s}
            {i < sentences.length - 1 ? " " : ""}
          </span>
        ))}
      </>
    );
  }
  return JSON.stringify(validity);
}

function formatValidUntil(ms) {
  if (ms == null || typeof ms !== "number") return "—";
  const d = new Date(Number(ms));
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function renderValue(value) {
  if (value == null) return "—";
  if (typeof value === "object") {
    return (
      <pre className="verification-box-pre agent-field-pre">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return String(value);
}

export default function AgentListBox({ agents, loading, error }) {
  const [index, setIndex] = useState(0);

  if (error) {
    return (
      <div className="verification-box agent-list-box">
        <h3 className="verification-box-title">Registered agents</h3>
        <p className="verification-box-muted">Unable to load agents</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="verification-box agent-list-box">
        <h3 className="verification-box-title">Agents</h3>
        <p className="verification-box-muted">Loading…</p>
      </div>
    );
  }

  const list = Array.isArray(agents) ? agents : [];
  const total = list.length;
  const hasAgents = total > 0;
  const currentIndex = Math.min(Math.max(0, index), Math.max(0, total - 1));
  const agent = hasAgents ? list[currentIndex] : null;

  return (
    <div className="verification-box agent-list-box">
      <h3 className="verification-box-title">Agents</h3>
      {!hasAgents ? (
        <p className="verification-box-muted">No agents found</p>
      ) : (
        <>
          <div className="agent-list-nav">
            <button
              type="button"
              className="btn agent-nav-btn"
              disabled={total <= 1 || currentIndex <= 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              aria-label="Previous agent"
            >
              ←
            </button>
            <span className="agent-list-counter">
              {currentIndex + 1} / {total}
            </span>
            <button
              type="button"
              className="btn agent-nav-btn"
              disabled={total <= 1 || currentIndex >= total - 1}
              onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
              aria-label="Next agent"
            >
              →
            </button>
          </div>
          <dl className="agent-details">
            <dt>Account ID</dt>
            <dd className="agent-account-id">{agent?.account_id ?? "—"}</dd>
            <dt>Validity</dt>
            <dd>{formatValidity(agent?.validity)}</dd>
            <dt>Valid until</dt>
            <dd>
              {formatValidUntil(
                agent?.valid_until_ms != null
                  ? Number(agent.valid_until_ms)
                  : null,
              )}
            </dd>
            <dt>Measurements</dt>
            <dd>
              {agent?.measurements != null &&
              typeof agent.measurements === "object" ? (
                <ParsedMeasurement m={agent.measurements} compact />
              ) : (
                renderValue(agent?.measurements)
              )}
            </dd>
            <dt>PPID</dt>
            <dd>{renderValue(agent?.ppid)}</dd>
          </dl>
        </>
      )}
    </div>
  );
}
