import { useState } from "react";
import ParsedMeasurement from "./ParsedMeasurement";

export default function ApprovedMeasurementsBox({
  measurements,
  loading,
  error,
}) {
  const [index, setIndex] = useState(0);

  if (error) {
    return (
      <div className="verification-box">
        <h3 className="verification-box-title">Approved measurements</h3>
        <p className="verification-box-muted">Unable to load</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="verification-box">
        <h3 className="verification-box-title">Approved measurements</h3>
        <p className="verification-box-muted">Loading…</p>
      </div>
    );
  }
  const list = Array.isArray(measurements) ? measurements : [];
  const total = list.length;
  const currentIndex = Math.min(Math.max(0, index), Math.max(0, total - 1));
  const current = total > 0 ? list[currentIndex] : null;

  return (
    <div className="verification-box">
      <h3 className="verification-box-title">Approved measurements</h3>
      {list.length === 0 ? (
        <p className="verification-box-value">None</p>
      ) : (
        <>
          <div className="measurements-nav">
            <button
              type="button"
              className="btn agent-nav-btn"
              disabled={total <= 1 || currentIndex <= 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              aria-label="Previous measurement"
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
              aria-label="Next measurement"
            >
              →
            </button>
          </div>
          <ParsedMeasurement m={current} />
        </>
      )}
    </div>
  );
}
