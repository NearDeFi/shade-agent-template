export default function ApprovedPpidsBox({ ppids, loading, error }) {
  if (error) {
    return (
      <div className="verification-box">
        <h3 className="verification-box-title">Approved PPIDs</h3>
        <p className="verification-box-muted">Unable to load</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="verification-box">
        <h3 className="verification-box-title">Approved PPIDs</h3>
        <p className="verification-box-muted">Loading…</p>
      </div>
    );
  }
  const list = Array.isArray(ppids) ? ppids : [];
  return (
    <div className="verification-box">
      <h3 className="verification-box-title">Approved PPIDs</h3>
      {list.length === 0 ? (
        <p className="verification-box-value">None</p>
      ) : (
        <ul className="verification-box-list ppid-list-scroll">
          {list.map((p, i) => (
            <li key={i}>
              {typeof p === "object" && p !== null ? (
                <pre className="verification-box-pre">
                  {JSON.stringify(p, null, 2)}
                </pre>
              ) : (
                String(p)
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
