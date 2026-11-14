export function SpecConversionCell({
  parts,
}: {
  parts: { entered?: string; converted?: string; note?: string } | null;
}) {
  if (!parts?.entered && !parts?.converted) return "—";
  return (
    <div className="min-w-[120px] space-y-0.5 text-[10px] leading-snug">
      {parts.entered ? <p className="text-[var(--detail-muted)]">{parts.entered}</p> : null}
      {parts.converted ? <p className="font-semibold text-[var(--detail-text)]">{parts.converted}</p> : null}
      {parts.note ? <p className="text-[var(--detail-muted)]">{parts.note}</p> : null}
    </div>
  );
}