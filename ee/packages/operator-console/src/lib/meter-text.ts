import type { OrganizationDirectoryRow } from "./staff-auth-api";

/** The console is an English staff surface, so its meters are pinned rather than left to
 *  the host locale: otherwise the same conversation count reads `12.5` in the directory
 *  and `12,5` on the detail page of a German-locale browser. */
const meterNumber = new Intl.NumberFormat("en-US");

export const formatMeterNumber = (value: number): string => meterNumber.format(value);

export function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : meterNumber.format(limit);
}

type DirectoryMeters = Pick<OrganizationDirectoryRow, "monthlyAnswers" | "monthlyConversations">;

/**
 * The headline monthly meter for a directory row. Catalog tiers meter conversations
 * and leave the answer limit null, so reading the answer meter alone would print
 * "unlimited" for a capped tier.
 */
export const directoryMeterText = (row: DirectoryMeters): string => {
  if (row.monthlyConversations) {
    return `${meterNumber.format(row.monthlyConversations.used)} / ${limitText(row.monthlyConversations.limit)} conv`;
  }
  return `${meterNumber.format(row.monthlyAnswers.used)} / ${limitText(row.monthlyAnswers.limit)}`;
};
