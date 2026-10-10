import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { type BuildError, BuildFailure } from "../src/errors.js";
import { findWarnings } from "../src/warnings.js";

const SDK_ENTRY = path.resolve(import.meta.dirname, "../../sdk/src/index.ts");
const projects: string[] = [];

/** Creates a throwaway project whose @usevaris/sdk import resolves to packages/sdk/src. */
function makeProject(
  files: Record<string, string>,
  manifest: object | null = { owner_id: "own_123" },
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "varis-build-"));
  projects.push(dir);

  const all: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        target: "es2022",
        noEmit: true,
        skipLibCheck: true,
        types: [],
        paths: { "@usevaris/sdk": [SDK_ENTRY] },
      },
      include: ["src"],
    }),
    ...files,
  };
  if (manifest) all["varis.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  for (const [name, content] of Object.entries(all)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function readManifest(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, "varis.json"), "utf8"));
}

function buildErrors(dir: string): BuildError[] {
  try {
    build(dir);
  } catch (error) {
    if (error instanceof BuildFailure) return error.errors;
    throw error;
  }
  throw new Error("Expected the build to fail.");
}

/** A valid definition body. `overrides` replaces whole lines by field name. */
function fields(slug: string, overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    slug: `"${slug}"`,
    name: `"Service ${slug}"`,
    description: `"A test service that does something useful."`,
    service_type: `"data"`,
    categories: `["science"]`,
    endpoint_url: `"https://api.example.com/${slug}"`,
    price_cents: "3",
    ...overrides,
  };
  return Object.entries(base)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `  ${key}: ${value},`)
    .join("\n");
}

afterEach(() => {
  for (const dir of projects.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build", () => {
  it("finds services across files and writes them sorted, keeping owner_id", () => {
    const dir = makeProject({
      "src/weather/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, { temp: number }>({
${fields("weather")}
});`,
      "src/deep/nested/alpha.ts": `
import { Varis } from "@usevaris/sdk";
const varis = new Varis();
varis.services.define<{ q: string }, string>({
${fields("alpha")}
});`,
    });

    expect(build(dir)).toEqual({ services: ["alpha", "weather"] });

    const manifest = readManifest(dir);
    expect(manifest.owner_id).toBe("own_123");
    expect(manifest.services.map((service: any) => service.slug)).toEqual([
      "alpha",
      "weather",
    ]);
    expect(manifest.services[1]).toMatchObject({
      endpoint_url: "https://api.example.com/weather",
      price_cents: 3,
      categories: ["science"],
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      output_schema: {
        type: "object",
        properties: { temp: { type: "number" } },
        required: ["temp"],
      },
    });
  });

  it("converts arrays, optional fields, literal unions, booleans, null, records, and doc comments", () => {
    const dir = makeProject({
      "src/types.ts": `
export interface Input {
  /** The city to look up. */
  city: string;
  units?: "metric" | "imperial";
  include_history: boolean;
}
export interface Output {
  data: Array<{ max_temp: number; min_temp: number | null }>;
  tags: Record<string, string>;
}`,
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
import type { Input, Output } from "./types.js";
new Varis().services.define<Input, Output>({
${fields("weather")}
});`,
    });

    build(dir);
    const [service] = readManifest(dir).services;

    expect(service.input_schema).toEqual({
      type: "object",
      properties: {
        city: { description: "The city to look up.", type: "string" },
        units: { type: "string", enum: ["metric", "imperial"] },
        include_history: { type: "boolean" },
      },
      required: ["city", "include_history"],
    });
    expect(service.output_schema).toEqual({
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              max_temp: { type: "number" },
              min_temp: { anyOf: [{ type: "null" }, { type: "number" }] },
            },
            required: ["max_temp", "min_temp"],
          },
        },
        tags: {
          type: "object",
          properties: {},
          additionalProperties: { type: "string" },
        },
      },
      required: ["data", "tags"],
    });
  });

  it("writes the default method, GET, when a definition omits it", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("weather")}
});`,
    });

    build(dir);
    const [service] = readManifest(dir).services;

    expect(service.method).toBe("GET");
    // Right after endpoint_url, per FIELD_ORDER.
    const keys = Object.keys(service);
    expect(keys.indexOf("method")).toBe(keys.indexOf("endpoint_url") + 1);
  });

  it("accepts a flat GET input: scalars, literal unions, optional fields, arrays of scalars", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
type Input = {
  city: string;
  days?: number;
  units: "metric" | "imperial";
  hourly: boolean;
  tags: string[];
};
new Varis().services.define<Input, string>({
${fields("weather", { method: `"GET"` })}
});`,
    });

    expect(build(dir)).toEqual({ services: ["weather"] });
    expect(readManifest(dir).services[0].method).toBe("GET");
  });

  it("fails a GET service with a nested input, naming the field, and writes nothing", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
type Input = { city: string; address: { zip: string } };
new Varis().services.define<Input, string>({
${fields("nested")}
});`,
    });
    const before = fs.readFileSync(path.join(dir, "varis.json"), "utf8");

    const errors = buildErrors(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: path.join("src", "route.ts"), line: 4 });
    expect(errors[0]!.message).toContain('The Input field "address"');
    expect(errors[0]!.message).toContain('method: "POST"');
    expect(fs.readFileSync(path.join(dir, "varis.json"), "utf8")).toBe(before);
  });

  it("fails a GET service whose input is an array of objects or nullable", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
type Input = { points: Array<{ x: number }>; note: string | null };
new Varis().services.define<Input, string>({
${fields("points", { method: `"GET"` })}
});`,
    });

    const messages = buildErrors(dir).map((error) => error.message);
    expect(messages.some((m) => m.includes('"points"'))).toBe(true);
    expect(messages.some((m) => m.includes('"note"'))).toBe(true);
  });

  it("builds a POST service with a nested input", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
type Input = { city: string; address: { zip: string } };
new Varis().services.define<Input, string>({
${fields("nested", { method: `"POST"` })}
});`,
    });

    expect(build(dir)).toEqual({ services: ["nested"] });
    expect(readManifest(dir).services[0].method).toBe("POST");
  });

  it("reports a method other than GET or POST from the type checker", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("put", { method: `"PUT"` })}
});`,
    });

    const errors = buildErrors(dir);
    expect(errors.some((error) => error.message.includes('"PUT"'))).toBe(true);
  });

  it("writes every default when a definition declares only what it must", () => {
    const dir = makeProject(
      {
        "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
  slug: "minimal",
  name: "Minimal",
  description: "A service declared with only the required fields.",
  service_type: "data",
  categories: ["science"],
  path: "/v1/minimal",
});`,
      },
      { owner_id: "own_123", base_url: "https://api.example.com" },
    );

    build(dir);
    const [service] = readManifest(dir).services;

    expect(service).toMatchObject({
      endpoint_url: "https://api.example.com/v1/minimal",
      method: "GET",
      price_cents: 0,
      version: "1.0.0",
      status: "published",
    });
    // varis.json matches what the API publishes: no path, only the URL.
    expect(service).not.toHaveProperty("path");
  });

  it("keeps a declared value over its default", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("priced", { version: `"2.1.0"`, status: `"draft"` })}
});`,
    });

    build(dir);
    expect(readManifest(dir).services[0]).toMatchObject({
      price_cents: 3,
      version: "2.1.0",
      status: "draft",
    });
  });

  it("joins base_url and path with one slash, however base_url ends", () => {
    const dir = makeProject(
      {
        "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("joined", { endpoint_url: "", path: `"/weather"` })}
});`,
      },
      { owner_id: "own_123", base_url: "https://api.example.com/v1/" },
    );

    build(dir);
    expect(readManifest(dir).services[0].endpoint_url).toBe(
      "https://api.example.com/v1/weather",
    );
  });

  it("uses endpoint_url as written, ignoring base_url", () => {
    const dir = makeProject(
      {
        "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("elsewhere", { endpoint_url: `"https://other.example.com/x"` })}
});`,
      },
      { owner_id: "own_123", base_url: "https://api.example.com" },
    );

    build(dir);
    expect(readManifest(dir).services[0].endpoint_url).toBe(
      "https://other.example.com/x",
    );
  });

  it("fails a path with no base_url in varis.json", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("orphan", { endpoint_url: "", path: `"/weather"` })}
});`,
    });

    const errors = buildErrors(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: path.join("src", "route.ts"), line: 3 });
    expect(errors[0]!.message).toContain("path needs base_url in varis.json");
  });

  it("fails when neither endpoint_url nor path is set", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("nowhere", { endpoint_url: "" })}
});`,
    });

    expect(buildErrors(dir)[0]!.message).toContain("Set path");
  });

  it("fails when both endpoint_url and path are set", () => {
    const dir = makeProject(
      {
        "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("both", { path: `"/weather"` })}
});`,
      },
      { owner_id: "own_123", base_url: "https://api.example.com" },
    );

    expect(buildErrors(dir)[0]!.message).toContain("not both");
  });

  it("rejects a path without a leading slash through the type", () => {
    const dir = makeProject(
      {
        "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("slashless", { endpoint_url: "", path: `"weather"` })}
});`,
      },
      { owner_id: "own_123", base_url: "https://api.example.com" },
    );

    expect(buildErrors(dir).some((e) => e.message.includes("weather"))).toBe(true);
  });

  it("rejects an unusable base_url in varis.json", () => {
    for (const baseUrl of [
      "http://api.example.com",
      "https://localhost:3000",
      "https://api.example.com?env=prod",
      42,
    ]) {
      const dir = makeProject(
        {
          "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("x", { endpoint_url: "", path: `"/weather"` })}
});`,
        },
        { owner_id: "own_123", base_url: baseUrl },
      );

      const errors = buildErrors(dir);
      expect(errors.some((e) => e.file === "varis.json" && e.message.includes("base_url"))).toBe(true);
    }
  });

  it("rejects an endpoint_url the API would refuse", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, string>({
${fields("local", { endpoint_url: `"http://localhost:3000/x"` })}
});`,
    });

    expect(buildErrors(dir)[0]!.message).toContain("endpoint_url must use https");
  });

  it("finds a renamed instance", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis as V } from "@usevaris/sdk";
const client = new V();
const services = client.services;
services.define<{ a: string }, string>({
${fields("renamed")}
});`,
    });

    expect(build(dir).services).toEqual(["renamed"]);
  });

  it("ignores a lookalike define", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
void Varis;
const varis = { services: { define<I, O>(_definition: unknown) {} } };
varis.services.define<{ a: string }, string>({ slug: "fake" });`,
    });

    expect(build(dir).services).toEqual([]);
  });

  it("fails on a computed value and leaves varis.json untouched", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
const url = "https://api.example.com/x";
new Varis().services.define<{ a: string }, string>({
${fields("computed", { endpoint_url: "url" })}
});`,
    });
    const before = fs.readFileSync(path.join(dir, "varis.json"), "utf8");

    const errors = buildErrors(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: path.join("src", "route.ts"),
      line: 10,
    });
    expect(errors[0]!.message).toContain('"endpoint_url" must be a literal');
    expect(fs.readFileSync(path.join(dir, "varis.json"), "utf8")).toBe(before);
  });

  it("fails on a type with no JSON Schema equivalent", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, { at: Date }>({
${fields("dated")}
});`,
    });

    const [error] = buildErrors(dir);
    expect(error).toMatchObject({
      file: path.join("src", "route.ts"),
      line: 3,
    });
    expect(error!.message).toContain("Output.at: Dates aren't JSON");
  });

  it("treats a void, undefined, or never Input as no input, like {}", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
const varis = new Varis();
varis.services.define<void, { ok: boolean }>({
${fields("void-input")}
});
varis.services.define<undefined, { ok: boolean }>({
${fields("undefined-input")}
});
varis.services.define<never, { ok: boolean }>({
${fields("never-input")}
});
varis.services.define<{}, { ok: boolean }>({
${fields("empty-input", { method: `"POST"` })}
});`,
    });

    build(dir);
    const services = readManifest(dir).services;
    expect(services).toHaveLength(4);
    for (const service of services) {
      expect(service.input_schema).toEqual({ type: "object", properties: {} });
    }
  });

  it("still rejects void as an Output", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<void, void>({
${fields("void-output")}
});`,
    });

    const errors = buildErrors(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Output has type void");
  });

  it("fails when Input isn't an object", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<string, string>({
${fields("scalar")}
});`,
    });

    expect(buildErrors(dir)[0]!.message).toContain(
      "Input must be an object type",
    );
  });

  it("fails when the type arguments are missing", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define({
${fields("untyped")}
});`,
    });

    expect(buildErrors(dir).map((error) => error.message)).toContain(
      "Pass the input and output types: define<Input, Output>({ ... }).",
    );
  });

  it("reports a missing required field from the type checker", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("undescribed", { description: "" })}
});`,
    });

    expect(
      buildErrors(dir).some((error) => error.message.includes("description")),
    ).toBe(true);
  });

  it("fails on a duplicate slug", () => {
    const dir = makeProject({
      "src/a.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("same")}
});`,
      "src/b.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("same")}
});`,
    });

    expect(buildErrors(dir)[0]!.message).toContain(
      'The slug "same" is already defined in src/a.ts on line 3.',
    );
  });

  it("produces identical output on a repeat build", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("stable")}
});`,
    });

    build(dir);
    const first = fs.readFileSync(path.join(dir, "varis.json"), "utf8");
    build(dir);

    expect(fs.readFileSync(path.join(dir, "varis.json"), "utf8")).toBe(first);
  });

  it("fails without varis.json", () => {
    const dir = makeProject({ "src/route.ts": "export {};" }, null);

    expect(buildErrors(dir)[0]!.message).toBe(
      "varis.json not found. Run varis init first.",
    );
  });
});

describe("findWarnings", () => {
  it("warns when @usevaris/build is in dependencies", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        type: "module",
        dependencies: { "@usevaris/build": "^0.1.0" },
      }),
    });

    const warnings = findWarnings(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@usevaris/build in dependencies");
  });

  it("stays quiet when @usevaris/build is a devDependency or absent", () => {
    const dev = makeProject({
      "package.json": JSON.stringify({
        type: "module",
        devDependencies: { "@usevaris/build": "^0.1.0" },
      }),
    });
    const absent = makeProject({});

    expect(findWarnings(dev)).toEqual([]);
    expect(findWarnings(absent)).toEqual([]);
  });

  it("skips the check when package.json is invalid", () => {
    const dir = makeProject({ "package.json": "{ not json" });

    expect(findWarnings(dir)).toEqual([]);
  });
});

describe("descriptions from comments", () => {
  /** Builds one POST service from `source` (which declares Input and Output) and returns its two schemas. POST, so Input may nest. */
  function schemasOf(source: string): { input: any; output: any } {
    const dir = makeProject({
      "src/service.ts": `
import { Varis } from "@usevaris/sdk";
${source}
new Varis().services.define<Input, Output>({
${fields("described", { method: `"POST"` })}
});`,
    });
    build(dir);
    const [service] = readManifest(dir).services;
    return { input: service.input_schema, output: service.output_schema };
  }

  it("reads JSDoc, block, line, and end-of-line comments on fields", () => {
    const { input } = schemasOf(`
type Input = {
  /** A JSDoc comment. */
  a: string;
  /* A block comment. */
  b: string;
  // A line comment.
  c: string;
  d: string; // An end-of-line comment.
};
type Output = { ok: boolean };`);

    expect(input.properties).toEqual({
      a: { description: "A JSDoc comment.", type: "string" },
      b: { description: "A block comment.", type: "string" },
      c: { description: "A line comment.", type: "string" },
      d: { description: "An end-of-line comment.", type: "string" },
    });
  });

  it("reads comments on types written inline in define", () => {
    const dir = makeProject({
      "src/service.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{
  /* The full name of the city. */
  city: string;
}, {
  // The greeting to show the user.
  message: string;
}>({
${fields("inline")}
});`,
    });
    build(dir);
    const [service] = readManifest(dir).services;

    expect(service.input_schema.properties.city.description).toBe("The full name of the city.");
    expect(service.output_schema.properties.message.description).toBe("The greeting to show the user.");
  });

  it("describes the schema from the comment above a named type", () => {
    const { input, output } = schemasOf(`
/** What to look up. */
interface Input { city: string }
// The forecast.
type Output = { temp: number };`);

    expect(Object.keys(input)[0]).toBe("description");
    expect(input.description).toBe("What to look up.");
    expect(output.description).toBe("The forecast.");
  });

  it("joins consecutive line comments and keeps JSDoc line breaks", () => {
    const { input } = schemasOf(`
type Input = {
  // First line.
  // Second line.
  a: string;
  /**
   * Line one.
   * Line two.
   */
  b: string;
};
type Output = { ok: boolean };`);

    expect(input.properties.a.description).toBe("First line.\nSecond line.");
    expect(input.properties.b.description).toBe("Line one.\nLine two.");
  });

  it("never gives a field the previous field's end-of-line comment", () => {
    const { input } = schemasOf(`
type Input = {
  a: string; // About a.
  b: string;
};
type Output = { ok: boolean };`);

    expect(input.properties.a.description).toBe("About a.");
    expect(input.properties.b).toEqual({ type: "string" });
  });

  it("ignores comments separated by a blank line, and tool directives", () => {
    const { input } = schemasOf(`
// A file header, not documentation.

type Input = {
  // Section heading.

  a: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  B_C: string;
};
type Output = { ok: boolean };`);

    expect(input.description).toBeUndefined();
    expect(input.properties.a).toEqual({ type: "string" });
    expect(input.properties.B_C).toEqual({ type: "string" });
  });

  it("prefers a field's comment over its type's, and uses the type's when the field has none", () => {
    const { input } = schemasOf(`
/** A postal address. */
interface Address { line: string }
type Input = {
  /** Where to deliver. */
  home: Address;
  work: Address;
};
type Output = { ok: boolean };`);

    expect(input.properties.home.description).toBe("Where to deliver.");
    expect(input.properties.work.description).toBe("A postal address.");
  });

  it("adds no description from the standard library's types", () => {
    const { input } = schemasOf(`
type Input = { tags: Record<string, string>; picked: Partial<{ a: string }> };
type Output = { ok: boolean };`);

    expect(input.properties.tags.description).toBeUndefined();
    expect(input.properties.picked.description).toBeUndefined();
  });
});

describe("instructions", () => {
  it("writes instructions after the description, and leaves them out when not set", () => {
    const dir = makeProject({
      "src/service.ts": `
import { Varis } from "@usevaris/sdk";
const varis = new Varis();
varis.services.define<{ organisation_id: string }, { ok: boolean }>({
${fields("with-instructions", {
  instructions: `"Call search-organisations first, and pass its id as organisation_id."`,
})}
});
varis.services.define<{ q: string }, { ok: boolean }>({
${fields("without-instructions")}
});`,
    });

    build(dir);
    const [withInstructions, withoutInstructions] = readManifest(dir).services;

    expect(withInstructions.instructions).toBe(
      "Call search-organisations first, and pass its id as organisation_id.",
    );
    expect(Object.keys(withInstructions).slice(0, 4)).toEqual([
      "slug",
      "name",
      "description",
      "instructions",
    ]);
    expect(withoutInstructions).not.toHaveProperty("instructions");
  });

  it("rejects instructions that aren't a string through the type", () => {
    const dir = makeProject({
      "src/service.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ q: string }, { ok: boolean }>({
${fields("bad-instructions", { instructions: "42" })}
});`,
    });

    const errors = buildErrors(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("not assignable to type 'string'");
  });
});
