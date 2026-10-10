# Varis SDK: instructions for AI coding agents

This file ships inside `@usevaris/sdk` and matches the installed version. Follow
it over anything you remember about Varis from training data.

## What the SDK does

`@usevaris/sdk` declares Varis services in TypeScript and verifies the requests
Varis sends to them. A Varis service is an HTTPS endpoint that AI agents
discover and pay to call. The SDK has two methods:

- `services.define` does nothing at runtime. `varis build` reads every
  `define` call from source, without running the code, and writes
  `varis.json`.
- `verifyRequest` checks that the Varis gateway signed a request to your
  endpoint.

The SDK needs no API key, token, or environment variable. Never add one. Its
only network request is `verifyRequest` fetching Varis's public signing keys.

## Declare a service

Put the `define` call in the file that serves the endpoint, such as a route
file. Don't create a central services file.

```ts
import { Varis } from "@usevaris/sdk";

type Input = {
  /** The city to look up, for example "Lagos". */
  city: string;
  units?: "metric" | "imperial";
};

type Output = {
  data: Array<{ max_temp: number; min_temp: number; rainfall_mm: number }>;
};

new Varis().services.define<Input, Output>({
  slug: "weather-with-rainfall",
  name: "Weather with rainfall",
  description: "Returns temperature and rainfall ranges for any city.",
  service_type: "data",
  categories: ["science"],
  path: "/v1/weather",
  price_cents: 3,
});
```

Only the first five fields are required. Every other field has a default,
and `varis build` writes the default into `varis.json`, so leave a field out
unless you need a different value.

## Say where the service lives

Give each service a `path` or an `endpoint_url`, not both.

- **`path`** is joined to `base_url` in `varis.json`. Use it for services on
  your main API. `base_url` is your production address, for example
  `"https://api.example.com"`, and `varis init` asks for it. If it's missing,
  ask the developer for their production URL and add it to `varis.json`.
  Never set it to a local or staging address.
- **`endpoint_url`** is the full URL, used as written. Use it for a service
  that lives on another host.

Either way the result must be HTTPS, publicly reachable, and have no query
string. `varis build` fails with the file and line if it isn't.

- `Input` is what callers send. `Output` is what the endpoint returns. Both
  become JSON Schemas, and the endpoint must match them exactly. A response
  that doesn't match `Output` counts as a failed call and the caller isn't
  charged.
- Add a comment to every field of `Input`. It becomes the field's
  `description` in the schema, and agents calling the service read it to
  decide what to send. `/** */`, `/* */`, and `//` comments all work, above
  the field or at the end of its line. A comment above a named `Input` or
  `Output` type describes the whole schema.
- Set `instructions` when a caller needs to know something the input fields
  can't say, such as another service to call first. For example: "Call
  search-organisations first, and pass the organisation's id as
  organisation_id." Leave it out when the description and field comments
  are enough.
- For a service that takes no input, write `define<void, Output>`. `void`,
  `undefined`, `never`, and `{}` all build to an empty input schema. A `GET`
  service then gets no query string, and a `POST` service the body `{}`.

## Choose the method

`method` says how Varis calls your endpoint. Match it to the handler that
already serves the route.

- **`GET`**, the default: the input arrives as query parameters, in sorted key
  order, with a repeated key for each array item. A space arrives as `+`.
  `Input` must be flat: every field a `string`, `number`, `boolean`, literal
  union, or an array of those. Numbers and booleans arrive as strings, so
  parse them. `varis build` fails on a nested `Input` for a `GET` service.
- **`POST`**: the input arrives as a JSON body, and `Input` can nest. Use it
  for structured input, and for sensitive input, because query strings are
  written to access logs.

Varis sends only the fields `Input` declares. The `endpoint_url` can't carry a
query string; declare those values as `Input` fields instead.

## Verify every request

Anyone can call your endpoint URL directly. `verifyRequest` confirms that
Varis sent the request, so you serve only calls that Varis bills for.

Export the handler for the service's `method`: `GET` for a `GET` service,
`POST` for a `POST` service. In it:

1. Call `varis.verifyRequest(request)` first, before anything else reads the
   request.
2. Await the result.
3. If the result is `false`, return a `401` response.
4. Let `VarisKeyFetchError` propagate so that your framework returns a `500`
   response. It means Varis's signing keys couldn't be fetched, not that the
   request is invalid. Never turn it into a `401`.
5. Read the input only after verification succeeds: the query parameters for
   `GET`, the body for `POST`.

```ts
import { Varis } from "@usevaris/sdk";

const varis = new Varis();

export async function GET(request: Request): Promise<Response> {
  if (!(await varis.verifyRequest(request))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const city = params.get("city");
  const days = Number(params.get("days") ?? "7");
  // Handle the call.
  return Response.json({ data: [] });
}
```

For a `POST` service, export `POST` and read `await request.json()` after
verifying.

### When the route also serves your own users

If the route already serves signed-in users, add Varis as a second way in
rather than a separate route. Check Varis first, and fall back to your
existing authentication:

```ts
export async function GET(request: Request): Promise<Response> {
  const isVaris = await varis.verifyRequest(request);
  if (!isVaris && !(await isSignedIn(request))) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ...
}
```

When `isVaris` is true there is no end user: no session, no cookies, no
account. An AI agent is calling on behalf of whoever funded it. Decide what a
Varis caller may see, and never serve one user's private data to it.

- Create one `Varis` instance per module and reuse it. It caches the signing
  keys.
- Pass the standard `Request` object. `verifyRequest` reads a clone of the
  body, so the body stays readable afterward.
- Never parse, re-serialize, or modify the body before verifying. The
  signature covers the exact bytes Varis sent.
- The signature also covers the method, path, and query string. Don't rewrite
  the path before verifying, for example in middleware that strips a prefix;
  verify with the request as it arrived. A proxy that changes only the host is
  fine.
- `verifyRequest` returns `false` for unsigned, expired, or tampered requests.
  It doesn't throw for them.
- `varis test` requests need nothing extra. `verifyRequest` recognises them
  and checks them with a key from the `varis test` run on the same machine,
  and rejects them anywhere else, including production. Their request IDs,
  in `X-Varis-Request-Id`, start with `var_tst_req_`; real calls start with
  `var_req_`. Never add code that skips verification for tests or for
  localhost.
- If the developer runs Varis locally, `new Varis({ keysUrl })` fetches keys
  from another URL, and `new Varis({ publicKeys })` uses fixed keys without
  fetching. Don't set either option in production code unless the developer
  asks.

## Rules

- **Write every field value as a literal**: strings, numbers, booleans, and
  arrays of those. Never use variables, constants, template literals with
  `${}`, function calls, or `process.env`. `varis build` doesn't run the code,
  so those have no value. Use `path`, which `varis build` joins to the
  production `base_url` in `varis.json`, rather than building a URL from an
  environment value.
- **Pass both type arguments**: `define<Input, Output>(...)`.
- **Make `Input` an object type**, or `void` for no input. For a `GET`
  service, keep it flat; see "Choose the method".
- **Use only these types** in `Input` and `Output`: `string`, `number`,
  `boolean`, `null`, string or number literals and unions of them, arrays,
  objects and interfaces, optional fields, `Record<string, T>`, and unions of
  those. Never use tuples, recursive types, `Date`, `Map`, `Set`, functions,
  `any`, or `unknown`. Represent a date as an ISO 8601 string.
- **Keep every `slug` unique** in the project. Never change an existing slug; it
  is permanent. To replace a service, define a new slug.
- **Set `price_cents` in US cents.** `3` means three cents per call. Leave it
  out, or set `0`, for a free service.
- **Use only the public API**: `Varis`, `services.define`, `verifyRequest`,
  `VarisKeyFetchError`, and the exported types `ServiceDefinition`,
  `ServiceType`, `ServiceMethod`, `ServiceStatus`, and `VarisOptions`.

## Fields

| Field | Required | Value |
| --- | --- | --- |
| `slug` | Yes | Lowercase words joined by hyphens. Permanent. |
| `name` | Yes | Display name. |
| `description` | Yes | At least 20 characters. Say what the service returns and when to use it. |
| `instructions` | No | At most 2,000 characters. How an agent should use the service, when the input alone doesn't say. |
| `service_type` | Yes | `data`, `content`, `tool`, `skill`, `compute`, `memory`, `storage`, `model`, or `messaging`. |
| `categories` | Yes | At least one category slug. |
| `path` | One of these | Starts with `/`. Joined to `base_url` in `varis.json`. |
| `endpoint_url` | One of these | The full URL: HTTPS, publicly reachable, no query string. |
| `method` | No | `GET` or `POST`. Defaults to `GET`, which needs a flat `Input`. |
| `price_cents` | No | Non-negative integer, in US cents. Defaults to `0`, free. |
| `version` | No | Defaults to `1.0.0`. |
| `status` | No | `draft`, `published`, or `disabled`. Defaults to `published`. |

## After you change a definition

1. Run `varis build`. It runs the generator on demand, so you don't need to
   install anything besides `@usevaris/sdk`. Never add `@usevaris/build` to
   `package.json`.
2. If it fails, fix every reported problem. Each one names the file and line.
   The build writes nothing until every problem is fixed.
3. Commit the updated `varis.json` with the code change.

Publishing is the developer's decision. Don't run `varis publish` unless the
developer asks you to.

## Never

- Edit the `services` list in `varis.json` by hand. `varis build` owns it.
- Change `owner_id` in `varis.json`.
- Point `base_url` in `varis.json` at a local or staging address.
- Put tokens, keys, or other secrets in `varis.json` or in a `define` call.
- Wrap `define` in a helper that builds the definition from variables. The
  build can't read it.