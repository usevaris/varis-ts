/**
 * convert.ts — turns TypeScript TYPES into JSON Schemas.
 *
 * WHAT THIS FILE DOES
 * In `varis.services.define<Input, Output>({ ... })`, the two type arguments
 * describe what the service accepts and returns. `convertSchemas` asks the
 * type checker what those types really are, after it has resolved every
 * alias, interface, `Pick<>`, `Partial<>`, intersection, and so on. It then
 * walks the resolved type and produces a JSON Schema that agents use to call
 * the service. The results become `input_schema` and `output_schema` in
 * varis.json.
 *
 * Example:
 *   interface Input { /** City name *\/ city: string; units?: "c" | "f" }
 *   ->
 *   { type: "object",
 *     properties: { city: { description: "City name", type: "string" },
 *                   units: { type: "string", enum: ["c", "f"] } },
 *     required: ["city"] }
 *
 * HOW TYPES MAP TO SCHEMAS (see `convert`, `convertUnion`, `convertObject`)
 *   string / number / boolean / null  -> { type: ... }
 *   "a" / 42 / true (literal types)   -> { type: ..., const: value }
 *   "a" | "b" (all strings)           -> { type: "string", enum: [...] }
 *   1 | 2 (all numbers)               -> { type: "number", enum: [...] }
 *   string | null, A | B, ...         -> { anyOf: [...] }
 *   T[] / Array<T> / ReadonlyArray<T> -> { type: "array", items: ... }
 *   object / interface / A & B        -> { type: "object", properties, required }
 *   { [key: string]: T }, Record<..>  -> adds additionalProperties: T
 *   optional field `x?: T`            -> left out of `required`
 *   comment on a field or named type  -> `description` (see describe.ts)
 *
 * WHAT IS REJECTED (each one records an error, and no partial schema is produced)
 *   any, unknown, undefined (on its own), void, never, bigint, symbol,
 *   functions and methods, Date, Map, Set, Promise, tuples, recursive types.
 *
 * INPUT MUST BE AN OBJECT
 * Agents send arguments by name, so `Input` has to convert to
 * `{ type: "object" }`. `Output` can be any supported type. The one
 * exception: an `Input` of `void`, `undefined`, or `never` means the service
 * takes no input, and converts to `{ type: "object", properties: {} }`, the
 * same as `{}`. As an `Output`, they are still rejected.
 *
 * HOW ERRORS FLOW
 * Deep inside the recursion, a bad type throws the private `Unsupported`
 * exception. `convertAt` catches it for each of Input and Output and turns
 * it into a BuildError. This means:
 *   - One bad field stops the conversion of that whole schema, and only the
 *     FIRST problem in each schema is reported.
 *   - Input and Output are converted separately, so both can report an error
 *     in the same run.
 *   - Every error points at the type argument (`Input` or `Output`) in the
 *     define call, not at the field's own declaration. The `at` path in the
 *     message, like "Input.address.lines[]", tells the developer which field.
 *
 * EDGE CASES WORTH KNOWING
 * - The ORDER of the checks in `convert` matters. `boolean` is internally a
 *   union (`true | false`), so the Boolean check must run before `isUnion()`.
 *   Literal checks must run before the broad String/Number checks.
 * - Inside unions, TypeScript splits `boolean` into `true | false`. For
 *   example, `x?: boolean` arrives as `true | false | undefined`.
 *   `convertUnion` joins it back into `{ type: "boolean" }`.
 * - `undefined` is dropped from unions, because optionality is expressed
 *   through `required` instead.
 * - String enums (`enum E { A = "a" }`) are unions of string literals, so
 *   they become `{ type: "string", enum: [...] }`.
 * - Recursion detection uses a STACK (the types on the current path), not a
 *   set of every type visited. A type used in two sibling fields is fine and
 *   is simply inlined twice. Only a type that contains itself is rejected.
 * - The Date/Map/Set/Promise check compares SYMBOL NAMES. A developer's own
 *   interface named `Map` would be rejected too.
 * - Class instance types are treated as objects. Their methods are
 *   properties with function types, so any class with methods is rejected
 *   ("is a function").
 * - Only string index signatures are converted. Number index signatures
 *   (`[i: number]: T`) are ignored.
 * - Branded primitives such as `string & { __brand: "Id" }` are
 *   intersections, so they go through `convertObject` and come out as
 *   objects, not strings. Handle them there if that ever matters.
 * - Objects with no index signature get no `additionalProperties` key, which
 *   in JSON Schema means extra keys are ALLOWED.
 *
 * WHERE TO MAKE CHANGES
 * - Support a new primitive or special type: add a branch in `convert`,
 *   placed carefully in the check order.
 * - Reject another built-in class: add it to NON_JSON_OBJECTS.
 * - Add a JSON Schema keyword taken from JSDoc tags (e.g. @minimum):
 *   `convertObject`, next to where `description` is read.
 * - Change which comments become descriptions: describe.ts.
 */
import ts from "@typescript/typescript6";
import { describeProperty, describeType } from "./describe.js";
import { type BuildError, errorAt } from "./errors.js";

/** A JSON Schema object. Kept loose on purpose, because we only build these and never read them. */
export type JsonSchema = { [key: string]: unknown };

/** The two schemas for one service, with key names as they appear in varis.json. */
export interface Schemas {
  input_schema: JsonSchema;
  output_schema: JsonSchema;
}

/** Signals a type with no JSON Schema equivalent. Caught per schema. */
class Unsupported extends Error {}

/**
 * Built-in object types that ARE objects to TypeScript but don't survive
 * JSON.stringify, mapped to the fix we suggest. Matched by symbol name in
 * `convertObject`.
 */
const NON_JSON_OBJECTS: Record<string, string> = {
  Date: "Dates aren't JSON. Use a string, for example an ISO 8601 timestamp.",
  Map: "Maps aren't JSON. Use an object type instead.",
  Set: "Sets aren't JSON. Use an array instead.",
  Promise: "Promises aren't JSON. Use the resolved type instead.",
};

/**
 * Converts define's two type arguments into JSON Schemas. Supports strings,
 * numbers, booleans, null, literals and literal unions, arrays, objects,
 * optional fields, index signatures, and unions of those. Anything else
 * records an error rather than producing a partial schema.
 *
 * Returns undefined if either schema failed. The reasons are already pushed to `errors`.
 */
export function convertSchemas(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  errors: BuildError[],
): Schemas | undefined {
  // The `<Input, Output>` written in the call. Both must be written
  // explicitly. TypeScript can't infer them, because the definition object
  // doesn't use them.
  const typeArguments = call.typeArguments;
  if (!typeArguments || typeArguments.length !== 2) {
    errors.push(
      errorAt(
        call,
        "Pass the input and output types: define<Input, Output>({ ... }).",
      ),
    );
    return undefined;
  }

  // `typeArguments` is a ts.NodeArray. The double cast gives it a tuple type
  // so it can be destructured. This is safe because the length is checked above.
  const [inputNode, outputNode] = typeArguments as unknown as [
    ts.TypeNode,
    ts.TypeNode,
  ];
  // Convert both before returning, so errors from both show up in one run.
  // The labels start the error path, like "Input.user.name".
  const input = isNoInput(checker.getTypeFromTypeNode(inputNode))
    ? noInputSchema()
    : convertAt(inputNode, "Input", checker, errors);
  const output = convertAt(outputNode, "Output", checker, errors);

  // Input converted fine, but to something other than an object, for
  // example `define<string, ...>` or a union of objects (anyOf).
  if (input && input.type !== "object") {
    errors.push(
      errorAt(
        inputNode,
        "Input must be an object type, because agents send arguments by name.",
      ),
    );
    return undefined;
  }
  if (!input || !output) return undefined;

  return { input_schema: input, output_schema: output };
}

/**
 * True when `Input` says "this service takes no input": `void`, `undefined`,
 * or `never`. These have no JSON Schema of their own, but as an Input they
 * mean one thing, so they become the same schema as `{}`. `void` is what
 * most developers write for a function with no arguments.
 */
function isNoInput(type: ts.Type): boolean {
  return (type.flags &
    (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0;
}

/**
 * An object with no properties: what `{}` converts to. Agents send
 * `"input": {}`, or leave input out, which the gateway treats as `{}`. A GET
 * service gets no query string, and a POST service the body `{}`.
 */
function noInputSchema(): JsonSchema {
  return { type: "object", properties: {} };
}

/**
 * Converts one type argument, and turns an `Unsupported` exception into a
 * recorded BuildError that points at that type argument.
 */
function convertAt(
  node: ts.TypeNode,
  label: string,
  checker: ts.TypeChecker,
  errors: BuildError[],
): JsonSchema | undefined {
  try {
    // getTypeFromTypeNode turns the syntax (`Input`) into the checker's fully
    // resolved type: aliases followed, generics applied, and so on.
    return convert(checker.getTypeFromTypeNode(node), label, {
      checker,
      location: node,
      stack: [],
    });
  } catch (error) {
    // Real bugs, anything other than Unsupported, propagate. cli.ts reports them as crashes.
    if (!(error instanceof Unsupported)) throw error;
    errors.push(errorAt(node, error.message));
    return undefined;
  }
}

/** State passed down through the recursive conversion. */
interface Context {
  checker: ts.TypeChecker;
  /**
   * The type argument node being converted. Needed by
   * `getTypeOfSymbolAtLocation` to resolve property types in the right scope.
   */
  location: ts.Node;
  /**
   * The object and array types on the path from the root to here, used to
   * detect recursive types. Never mutated. Each level makes a new array.
   */
  stack: ts.Type[];
}

/**
 * The core dispatcher: one resolved type in, one JSON Schema out. Throws
 * `Unsupported` for types with no JSON equivalent.
 *
 * `at` is a readable path to this type, like "Input.tags[]", used only in
 * error messages.
 *
 * !! The order of the checks below matters. See the notes on each one. !!
 */
function convert(type: ts.Type, at: string, context: Context): JsonSchema {
  const { checker } = context;
  // `flags` is a bitmask describing what kind of type this is. Test it with `&`.
  const flags = type.flags;

  // any and unknown say nothing about the shape, so no schema can be derived.
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    throw new Unsupported(`${at} is any or unknown. Give it a concrete type.`);
  }
  // Plain `boolean`. It MUST come before isUnion(), because TypeScript
  // represents boolean as the union `true | false`.
  if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  // `true` or `false` as a literal type. The public API has no way to read
  // a boolean literal's value, so compare its printed name instead.
  if (flags & ts.TypeFlags.BooleanLiteral) {
    return { type: "boolean", const: checker.typeToString(type) === "true" };
  }
  // Literal types like "metric" or 42. They must come before the broad
  // String/Number checks below. String enum members also match here.
  if (type.isStringLiteral()) return { type: "string", const: type.value };
  if (type.isNumberLiteral()) return { type: "number", const: type.value };
  if (flags & ts.TypeFlags.String) return { type: "string" };
  if (flags & ts.TypeFlags.Number) return { type: "number" };
  if (flags & ts.TypeFlags.Null) return { type: "null" };

  // A | B | ... , including optional fields, which arrive as `T | undefined`.
  if (type.isUnion()) return convertUnion(type, at, context);

  // Objects, interfaces, arrays, tuples, functions, class instances, and
  // intersections (A & B). convertObject sorts out which one it is.
  if (flags & ts.TypeFlags.Object || type.isIntersection()) {
    return convertObject(type, at, context);
  }

  // Everything else: undefined, void, never, bigint, symbol, template
  // literal types, and so on.
  throw new Unsupported(
    `${at} has type ${
      checker.typeToString(type)
    }, which has no JSON Schema equivalent.`,
  );
}

/**
 * Converts a union type. It tries the most compact schema first:
 *   only true|false           -> { type: "boolean" }
 *   one member left           -> that member's schema (T | undefined -> T)
 *   all string literals       -> { type: "string", enum }
 *   all number literals       -> { type: "number", enum }
 *   anything else             -> { anyOf: [...] }
 */
function convertUnion(
  type: ts.UnionType,
  at: string,
  context: Context,
): JsonSchema {
  // Optional fields arrive as `T | undefined`. Optionality is recorded in `required`.
  let members = type.types.filter((member) =>
    !(member.flags & ts.TypeFlags.Undefined)
  );

  // Inside a union, TypeScript splits boolean into true | false. Rejoin it.
  const literals = members.filter((member) =>
    member.flags & ts.TypeFlags.BooleanLiteral
  );
  // Both `true` and `false` present means the original type said `boolean`.
  // A lone `true` or `false`, as in `"auto" | false`, stays a literal member
  // and becomes { const } in the anyOf below.
  const hasBoolean = literals.length === 2;
  if (hasBoolean) {
    // Remove the pair. It's added back as one { type: "boolean" } at the end.
    members = members.filter((member) =>
      !(member.flags & ts.TypeFlags.BooleanLiteral)
    );
  }

  // `boolean | undefined`, i.e. an optional boolean field.
  if (members.length === 0 && hasBoolean) return { type: "boolean" };
  // `T | undefined`, i.e. an optional field of any other type. It's not
  // really a union, so convert T directly.
  if (members.length === 1 && !hasBoolean) {
    return convert(members[0]!, at, context);
  }

  // "a" | "b" | "c" -> a compact string enum, instead of anyOf with three consts.
  if (!hasBoolean && members.every((member) => member.isStringLiteral())) {
    return {
      type: "string",
      enum: members.map((member) => (member as ts.StringLiteralType).value),
    };
  }
  // 1 | 2 | 3 -> a compact number enum.
  if (!hasBoolean && members.every((member) => member.isNumberLiteral())) {
    return {
      type: "number",
      enum: members.map((member) => (member as ts.NumberLiteralType).value),
    };
  }

  // A mixed union, like `string | null` or `A | B`. Convert each member.
  // If any member is unsupported, the whole schema fails (Unsupported propagates).
  const anyOf = members.map((member) => convert(member, at, context));
  // Put back the boolean removed above, as a single entry.
  if (hasBoolean) anyOf.push({ type: "boolean" });
  return { anyOf };
}

/**
 * Converts anything object-shaped. It first rejects the object types JSON
 * can't represent: recursive types, functions, Date/Map/Set/Promise, and
 * tuples. Arrays become `{ type: "array" }`. Everything else becomes
 * `{ type: "object" }`, built from its properties.
 */
function convertObject(
  type: ts.Type,
  at: string,
  context: Context,
): JsonSchema {
  const { checker, location, stack } = context;

  // Already on the current path means this type contains itself, as in
  // `interface Node { children: Node[] }`. JSON Schema would need $ref,
  // which we don't produce.
  if (stack.includes(type)) {
    throw new Unsupported(
      `${at} refers to itself. Recursive types aren't supported.`,
    );
  }
  // Anything callable (`() => void`) or constructible (`new () => X`) is a
  // function. This also catches methods on class instances, since each
  // method is a property with a function type.
  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  ) {
    throw new Unsupported(`${at} is a function. Functions aren't JSON.`);
  }

  // The declared name of the type, like "Array", "Date", or "MyInterface".
  // Anonymous object types are named "__type". Intersections have no
  // symbol, so they get "".
  const symbolName = type.getSymbol()?.getName() ?? "";
  const nonJson = NON_JSON_OBJECTS[symbolName];
  if (nonJson) throw new Unsupported(`${at}: ${nonJson}`);

  // Generic instantiations like Array<string> or [string, number] are
  // "type references" that point at a generic `target`. The cast is
  // unchecked, and for plain objects `target` is simply undefined.
  const reference = type as ts.TypeReference;
  if (reference.target && reference.target.objectFlags & ts.ObjectFlags.Tuple) {
    throw new Unsupported(
      `${at} is a tuple. Use an array or an object type instead.`,
    );
  }

  // Context for children: the same, plus this type pushed onto the recursion stack.
  const inner: Context = { ...context, stack: [...stack, type] };

  // T[] is sugar for Array<T>, so both arrive with the symbol name "Array".
  // `readonly T[]` arrives as "ReadonlyArray".
  if (symbolName === "Array" || symbolName === "ReadonlyArray") {
    // The single type argument is the item type, e.g. string in string[].
    const [item] = checker.getTypeArguments(reference);
    if (!item) throw new Unsupported(`${at} is an array with no item type.`);
    return { type: "array", items: convert(item, `${at}[]`, inner) };
  }

  // Everything else is a plain object: interfaces, type literals, mapped
  // types like Record/Partial/Pick, and intersections. A comment above a
  // named type describes the whole object, and comes first in its JSON.
  const typeDescription = describeType(type, checker);
  const schema: JsonSchema = typeDescription
    ? { description: typeDescription, type: "object" }
    : { type: "object" };
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  // getPropertiesOfType returns the FINAL property set: inherited members,
  // intersections merged, and mapped types (Pick, Omit, Partial) applied.
  for (const property of checker.getPropertiesOfType(type)) {
    const name = property.getName();
    // The property's type as seen from the type argument node. Optional
    // properties come back as `T | undefined`, which convertUnion unwraps.
    let child = convert(
      checker.getTypeOfSymbolAtLocation(property, location),
      `${at}.${name}`,
      inner,
    );

    // The comment on the property, as plain text. Agents read it to
    // understand the field, so it goes into the schema. It replaces the
    // description of the field's own type: `home: Address` with a comment
    // on `home` says more about this field than the comment on Address.
    const description = describeProperty(property, checker);
    if (description) {
      const { description: _typeDescription, ...rest } = child;
      // First, so it appears at the top of the field's JSON.
      child = { description, ...rest };
    }

    properties[name] = child;
    // `x?: T` sets the Optional flag. Every other property is required.
    if (!(property.flags & ts.SymbolFlags.Optional)) required.push(name);
  }

  // `properties` is always present, even if empty (`{}`). `required` is
  // left out when empty, because JSON Schema tools prefer that.
  schema.properties = properties;
  if (required.length > 0) schema.required = required;

  // A string index signature (`[key: string]: T`, or Record<string, T>)
  // means "any other key is allowed, and its value is T".
  const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (index) {
    schema.additionalProperties = convert(index.type, `${at}[key]`, inner);
  }

  return schema;
}
