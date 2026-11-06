// File timestamps use UTC (Z); UI dates use the browser's local time zone.
export function fileTimestamp(epoch) {
  const date=new Date(epoch);
  if(!Number.isFinite(epoch)||epoch<=0||!Number.isFinite(date.getTime())) return null;
  return date.toISOString().replace('T','_').replaceAll(':','-').replace('.', '-');
}
export function sessionDate(epoch) {
  if(!fileTimestamp(epoch)) return 'ohne Startzeit';
  return new Intl.DateTimeFormat('de-DE',{
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'
  }).format(new Date(epoch));
}
export function sessionLabel(session) {
  const completion=session.complete===null?'Abschluss unbekannt':session.complete?'abgeschlossen':'unvollständig';
  return `#${session.id} · ${sessionDate(session.epoch)} · ${session.samples.length} Samples · ${completion}${session.errors?' · beschädigt':''}`;
}
export function csvFilename(session,exportedAt=Date.now()) {
  const started=fileTimestamp(session.epoch);
  return `arrow-session-${session.id}_${started||`undatiert_export_${fileTimestamp(exportedAt)}`}.csv`;
}
export function allCsvFilename(exportedAt=Date.now()) {
  return `arrow-sessions_export_${fileTimestamp(exportedAt)}.csv`;
}
