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
      <dt>MRTD</dt>
      <dd>{String(mrtd)}</dd>
      <dt>RTMR 0</dt>
      <dd>{String(rtmr0)}</dd>
      <dt>RTMR 1</dt>
      <dd>{String(rtmr1)}</dd>
      <dt>RTMR 2</dt>
      <dd>{String(rtmr2)}</dd>
      <dt>Key provider event digest</dt>
      <dd>{String(keyProvider)}</dd>
      <dt>App compose hash payload</dt>
      <dd>{String(appCompose)}</dd>
    </dl>
  );
}
