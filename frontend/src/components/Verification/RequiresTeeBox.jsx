export default function RequiresTeeBox({ requiresTee, loading, error }) {
  if (error) {
    return (
      <div className="verification-box requires-tee-box">
        <h3 className="verification-box-title">Requires TEE</h3>
        <p className="verification-box-muted">Unable to load</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="verification-box requires-tee-box">
        <h3 className="verification-box-title">Requires TEE</h3>
        <p className="verification-box-muted">Loading…</p>
      </div>
    );
  }
  return (
    <div className="verification-box requires-tee-box">
      <h3 className="verification-box-title">Requires TEE</h3>
      <p className="verification-box-value">{requiresTee ? "Yes" : "No"}</p>
    </div>
  );
}
