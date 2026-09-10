/** European-style formatting helpers (comma decimal separator, DD/MM/YYYY dates). */

export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb >= 1000) {
    return `${(mb / 1000).toFixed(2).replace(".", ",")} GB`;
  }
  return `${mb.toFixed(1).replace(".", ",")} MB`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("de-DE").format(value);
}
