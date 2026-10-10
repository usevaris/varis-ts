/**
 * write.ts — merges the built services into varis.json on disk.
 *
 * WHAT THIS FILE DOES
 * `writeManifest` opens the project's existing varis.json and replaces ONLY
 * its `services` array. Every other top-level field is kept exactly as it
 * was, including `owner_id` and `base_url`, which the Varis CLI's
 * `varis init` command wrote there. The services are sorted, and so are their keys, so running
 * the build twice on the same code produces a byte-identical file. That
 * keeps git diffs quiet.
 *
 * PRECONDITIONS (each one is a BuildFailure, and nothing is written)
 * - varis.json must already exist. This generator never creates it, because
 *   `owner_id` can only come from `varis init`.
 * - It must be valid JSON.
 * - It must have a non-empty string `owner_id`.
 *
 * OUTPUT FORMAT
 * - Services are sorted by slug (`localeCompare`).
 * - Keys inside each service follow FIELD_ORDER. Keys missing from
 *   FIELD_ORDER come after it, sorted alphabetically.
 * - 2-space indentation with a trailing newline, the same format as the test
 *   fixtures and most editors.
 * - The `services` key keeps its original position if it already existed.
 *   Otherwise it is added at the end (standard object spread behavior).
 *
 * EDGE CASES / CAVEATS
 * - `localeCompare` without a locale uses the machine's default locale.
 *   Slugs are lowercase ASCII with hyphens, so this is stable in practice.
 *   If slugs ever allow other characters, consider a plain `<` comparison.
 * - The write isn't atomic: writeFileSync overwrites in place. A crash at
 *   exactly that moment could leave a truncated file.
 * - An empty `services` list is written as-is. That is how removing every
 *   define call clears the manifest.
 *
 * WHERE TO MAKE CHANGES
 * - When you add a field to `ServiceDefinition` in packages/sdk/src/types.ts, add it to
 *   FIELD_ORDER in the position where it should appear in varis.json.
 */
import fs from "node:fs";
import path from "node:path";
import { BuildFailure } from "./errors.js";

/** One service as written to varis.json: definition fields plus both schemas. */
export type ManifestService = Record<string, unknown>;

/**
 * The key order for each service in varis.json. Keep it in sync with the
 * fields of `ServiceDefinition` in packages/sdk/src/types.ts. The two schemas always come last.
 */
const FIELD_ORDER = [
  "slug",
  "name",
  "description",
  "instructions",
  "service_type",
  "categories",
  "endpoint_url",
  "method",
  "price_cents",
  "version",
  "status",
  "input_schema",
  "output_schema",
];

/**
 * Rewrites the `services` list in varis.json and leaves every other field,
 * including `owner_id`, as it was. Output is sorted so repeat builds produce
 * identical files.
 */
export function writeManifest(projectDir: string, services: ManifestService[]): void {
  const file = path.join(projectDir, "varis.json");

  // Errors below use the relative name "varis.json" and line 0, meaning the
  // whole file, with no specific line.
  if (!fs.existsSync(file)) {
    throw new BuildFailure([{ file: "varis.json", line: 0, message: "varis.json not found. Run varis init first." }]);
  }

  let manifest: Record<string, unknown>;
  try {
    // The cast assumes the top level is an object. A top-level array or
    // primitive fails the owner_id check below, so the cast is safe in practice.
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new BuildFailure([{ file: "varis.json", line: 0, message: "varis.json isn't valid JSON." }]);
  }

  // owner_id ties the services to a Varis account. Without it, the manifest can't be published.
  if (typeof manifest.owner_id !== "string" || manifest.owner_id.length === 0) {
    throw new BuildFailure([{ file: "varis.json", line: 0, message: "varis.json has no owner_id. Run varis init." }]);
  }

  // Copy before sorting, because .sort() mutates the array and `services`
  // belongs to the caller. Then put each service's keys in the fixed order.
  const sorted = [...services]
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
    .map(orderFields);

  // Keep every existing top-level field and replace only `services`.
  // JSON.stringify(..., null, 2) pretty-prints with 2-space indentation.
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, services: sorted }, null, 2)}\n`);
}

/**
 * Returns a copy of `service` with its keys in a fixed order. JSON.stringify
 * writes keys in insertion order, so building a new object key by key is
 * how the order is controlled.
 */
function orderFields(service: ManifestService): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  // First, the known fields, in FIELD_ORDER. Optional fields that are absent,
  // like `version` or `status`, are skipped, not written as undefined.
  for (const key of FIELD_ORDER) {
    if (key in service) ordered[key] = service[key];
  }
  // Then any field not in FIELD_ORDER, alphabetically, so nothing is dropped
  // and the output stays deterministic.
  for (const key of Object.keys(service).sort()) {
    if (!(key in ordered)) ordered[key] = service[key];
  }
  return ordered;
}
