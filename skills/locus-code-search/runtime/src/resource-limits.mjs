const DEFAULT_MAX_RESIDENT_PROJECTS = 8;
const MAX_CONFIGURED_PROJECTS = 64;

function parseResidentProjectLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_RESIDENT_PROJECTS;
  return Math.min(MAX_CONFIGURED_PROJECTS, parsed);
}

/** Maximum project roots whose heavyweight resources may stay resident. */
export const MAX_RESIDENT_PROJECTS = parseResidentProjectLimit(
  process.env.LOCUS_MAX_RESIDENT_PROJECTS,
);
