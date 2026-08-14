/**
 * proposal-siblings.ts — pairing key for proposals that belong to the SAME
 * client at the SAME job site (e.g. two separate proposals for one house:
 * gutters + guards sold as two documents). The assign-job modal and the
 * calendar sidebar use it to offer "chain these — one crew, one visit".
 *
 * Pure + tiny so both client components and server actions can share it.
 */

/** Client identity half: lowercased email when present, else a name slug —
 *  same doctrine as the CRM's clientKey (crm.ts). Null = unidentifiable. */
export function clientKeyOf(
  email?: string | null,
  name?: string | null,
): string | null {
  const e = (email ?? "").trim().toLowerCase();
  if (e) return e;
  const n = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return n ? `name:${n}` : null;
}

/** Job-site half: case/punctuation/whitespace-insensitive address. Formats
 *  from the same intake flow (Places autocomplete) normalize identically;
 *  hand-typed variants match as long as the words do. */
export function siteKeyOf(address?: string | null): string | null {
  const a = (address ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return a || null;
}

/** Both halves or nothing — a proposal with no client identity or no address
 *  never chains (better to miss a pair than to bundle strangers). */
export function proposalPairKey(p: {
  clientEmail?: string | null;
  clientName?: string | null;
  address?: string | null;
}): string | null {
  const c = clientKeyOf(p.clientEmail, p.clientName);
  const s = siteKeyOf(p.address);
  return c && s ? `${c}@@${s}` : null;
}

/** The other proposals in `list` that pair with `target` (target excluded). */
export function siblingProposals<
  T extends {
    id: string;
    clientEmail?: string | null;
    clientName?: string | null;
    address?: string | null;
  },
>(list: T[], target: T | null | undefined): T[] {
  if (!target) return [];
  const key = proposalPairKey(target);
  if (!key) return [];
  return list.filter((p) => p.id !== target.id && proposalPairKey(p) === key);
}
