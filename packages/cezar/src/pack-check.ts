/** Tarball bundle check — the pure half of `scripts/check-pack.mjs`.
 *
 *  Phase R1 of the cockpit redesign shipped an npm tarball with no UI in it
 *  (`files` listed the sources, not the Vite build). This module pins that bug
 *  class: given the file list `npm pack --dry-run --json` reports, decide
 *  whether the package would ship a working cockpit. Kept dependency-free and
 *  side-effect-free so the decision is unit-testable; the script owns the
 *  `npm pack` invocation and the exit code.
 */

export const IMPACT_PACK_FILES = [
  'dist/impact/template.html',
  'dist/impact/demo-review.json',
  'skills/change-impact/SKILL.md',
  'skills/change-impact/references/analysis-contract.md',
  'skills/change-impact/references/visual-contract.md',
  'skills/change-impact/references/public-api.md',
] as const;
/** One package's entry in `npm pack --json` output. */
export interface PackReport {
  filename?: string;
  files?: { path: string }[];
}

/** The first package report from `npm pack --json`, whatever npm's shape: an
 *  array up to npm 11, an object keyed by package name from npm 12. */
export function firstPackReport(packJson: unknown): PackReport | undefined {
  if (!packJson || typeof packJson !== 'object') return undefined;
  return (Array.isArray(packJson) ? packJson : Object.values(packJson))[0] as PackReport | undefined;
}

/** Human-readable problems with a would-be tarball; empty array = publishable.
 *
 *  Requirements (spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`, Serving):
 *  - `web/dist/index.html` — the built shell every GET serves.
 *  - at least one `web/dist/assets/*` file — the hashed JS/CSS bundles; an
 *    index.html alone renders a blank page.
 */
export function findPackGaps(packedFiles: readonly string[]): string[] {
  const gaps: string[] = [];
  // The impact renderer reads its template beside the compiled module, and the bundled
  // change-impact skill ships as files (spec 2026-10-22-html-artifacts-and-impact, Q6/Q7).
  for (const asset of IMPACT_PACK_FILES) {
    if (!packedFiles.includes(asset)) gaps.push(`${asset} is missing — \`cez impact\` would ship without it (scripts/copy-assets.mjs, "files")`);
  }
  if (!packedFiles.includes('web/dist/index.html')) {
    gaps.push('web/dist/index.html is missing — the tarball would ship no UI shell (run `npm run build:web`)');
  }
  if (!packedFiles.some((f) => f.startsWith('web/dist/assets/') && f.length > 'web/dist/assets/'.length)) {
    gaps.push('no web/dist/assets/* bundle in the tarball — the shell would load with no JS/CSS');
  }
  return gaps;
}

/** If bundled workers were built, every immutable catalog entry must reach the tarball. */
export function findBundledPackGaps(packedFiles: readonly string[]): string[] {
  if (!packedFiles.includes('dist/bundled-chat/catalog.json')) return []
  return ['slack', 'discord', 'telegram'].flatMap(id => packedFiles.includes(`dist/bundled-chat/${id}/index.js`)
    ? []
    : [`dist/bundled-chat/${id}/index.js is missing — the bundled provider catalog would be unusable`])
}

/** The packed catalog must load — every digest matches the worker file that ships, after
 *  postbuild — and list both providers; otherwise every install silently runs compatibility. */
export async function findBundledCatalogGaps(load: () => Promise<readonly { id: string }[]>): Promise<string[]> {
  let ids: string[]
  try { ids = (await load()).map(manifest => manifest.id) } catch (error) {
    return [`dist/bundled-chat/catalog.json is unusable (${error instanceof Error ? error.message : String(error)}) — bundled workers would never activate`]
  }
  return ['slack', 'discord', 'telegram'].filter(id => !ids.includes(id)).map(id => `dist/bundled-chat/catalog.json does not list ${id}`)
}
