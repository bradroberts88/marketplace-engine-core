const padDatePart = (value: number): string => String(value).padStart(2, "0");

export const formatUsDate = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  return `${padDatePart(date.getUTCMonth() + 1)}/${padDatePart(date.getUTCDate())}/${date.getUTCFullYear()}`;
};

export const formatUsDateTime = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  return `${formatUsDate(value)} ${padDatePart(date.getUTCHours())}:${padDatePart(date.getUTCMinutes())} UTC`;
};