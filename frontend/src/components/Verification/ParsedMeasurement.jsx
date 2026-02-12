export default function ParsedMeasurement({ m, compact }) {
  if (m == null || typeof m !== "object") {
    return <p className="verification-box-value">{String(m)}</p>;
  }
  const rtmrs = m.rtmrs ?? m;
  const mrtd = rtmrs.mrtd ?? m.mrtd ?? "—";
  const rtmr0 = rtmrs.rtmr0 ?? m.rtmr0 ?? "—";
  const rtmr1 = rtmrs.rtmr1 ?? m.rtmr1 ?? "—";
  const rtmr2 = rtmrs.rtmr2 ?? m.rtmr2 ?? "—";
  const keyProvider = m.key_provider_event_digest ?? "—";
  const appCompose = m.app_compose_hash_payload ?? "—";
  const className = compact
    ? "measurement-parsed measurement-parsed-compact"
    : "measurement-parsed";
  return (
    <dl className={className}>
      <dt>RTMRs</dt>
      <dd>
        <span className="measurement-label">mrtd</span> {String(mrtd)}
      </dd>
      <dd>
        <span className="measurement-label">rtmr0</span> {String(rtmr0)}
      </dd>
      <dd>
        <span className="measurement-label">rtmr1</span> {String(rtmr1)}
      </dd>
      <dd>
        <span className="measurement-label">rtmr2</span> {String(rtmr2)}
      </dd>
      <dt>key_provider_event_digest</dt>
      <dd>{String(keyProvider)}</dd>
      <dt>app_compose_hash_payload</dt>
      <dd>{String(appCompose)}</dd>
    </dl>
  );
}
