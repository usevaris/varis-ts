/**
 * describe.ts — reads the comments developers write on types and fields,
 * for the `description` keyword in a JSON Schema.
 *
 * WHAT COUNTS AS A DESCRIPTION
 * For a field, the first of these that exists:
 *   1. A JSDoc comment above it: `/** The city. *\/`. TypeScript resolves
 *      these itself, through Pick, Partial, intersections, and so on.
 *   2. Plain comments directly above it: `/* The city. *\/` or `// The city.`
 *      Several in a row are joined, so a two-line `//` comment reads as one.
 *   3. A comment at the end of its own line: `city: string; // The city.`
 * For a named type (`interface Input` or `type Input = { ... }`), the same,
 * read from its declaration. Rule 3 doesn't apply to types.
 *
 * "Directly above" means no blank line in between. A comment separated by a
 * blank line is a section heading or a file header, not documentation.
 *
 * WHAT IS IGNORED
 * - A comment at the end of the PREVIOUS field's line. It sits in this
 *   field's leading trivia, but it belongs to the previous field.
 * - Tool directives: `// eslint-disable...`, `// @ts-...`, `// prettier-ignore`.
 * - Types declared in `.d.ts` files: the standard library and installed
 *   packages. Without this, every `Record<string, T>` would carry
 *   TypeScript's own "Construct a type with..." comment.
 */
import ts from "@typescript/typescript6";

/** Comments that configure tools rather than describe the code. */
const DIRECTIVE = /^(eslint-|@ts-|prettier-ignore|biome-ignore)/;

/** The description for one property of an object type, or "" if it has none. */
export function describeProperty(
  property: ts.Symbol,
  checker: ts.TypeChecker,
): string {
  const jsDoc = ts.displayPartsToString(
    property.getDocumentationComment(checker),
  ).trim();
  if (jsDoc) return jsDoc;

  for (const declaration of property.declarations ?? []) {
    const above = commentAbove(declaration);
    if (above) return above;
    const trailing = commentAfter(declaration);
    if (trailing) return trailing;
  }
  return "";
}

/**
 * The description for a named object type, read from the comment above its
 * `interface` or `type` declaration. "" for anonymous types and for types
 * declared in `.d.ts` files.
 */
export function describeType(type: ts.Type, checker: ts.TypeChecker): string {
  // `type Input = { ... }` names an anonymous type literal: the alias holds
  // the name and the comment. An interface is its own symbol.
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol || symbol.getName().startsWith("__")) return "";

  const declarations = (symbol.declarations ?? []).filter(
    (declaration) => !declaration.getSourceFile().isDeclarationFile,
  );
  if (declarations.length === 0) return "";

  const jsDoc = ts.displayPartsToString(
    symbol.getDocumentationComment(checker),
  ).trim();
  if (jsDoc) return jsDoc;

  for (const declaration of declarations) {
    const above = commentAbove(declaration);
    if (above) return above;
  }
  return "";
}

/** Plain comments directly above `node`, joined in order. */
function commentAbove(node: ts.Node): string {
  const text = node.getSourceFile().getFullText();
  // node.pos is where the node's leading trivia starts: just after the
  // previous token. node.getStart() is where its own text starts.
  const ranges = ts.getLeadingCommentRanges(text, node.pos) ?? [];

  // Walk back from the declaration, keeping comments until a blank line.
  const kept: ts.CommentRange[] = [];
  let next = node.getStart();
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    const gap = text.slice(range.end, next);
    if (newlines(gap) > 1) break;
    kept.unshift(range);
    next = range.pos;
  }

  // The first kept comment may really be the previous field's trailing
  // comment: on the same line as the token before this node. Drop it.
  const first = kept[0];
  if (first && newlines(text.slice(node.pos, first.pos)) === 0 && !opensBlock(text, node.pos)) {
    kept.shift();
  }

  return join(kept.map((range) => commentText(text, range)));
}

/** A comment on the same line as the end of `node`, after any `;` or `,`. */
function commentAfter(node: ts.Node): string {
  const text = node.getSourceFile().getFullText();
  let end = node.end;
  // A member's separator may sit outside the node's range.
  while (text[end] === " " || text[end] === "\t") end++;
  if (text[end] === ";" || text[end] === ",") end++;

  const ranges = ts.getTrailingCommentRanges(text, end) ?? [];
  return join(ranges.slice(0, 1).map((range) => commentText(text, range)));
}

/** True when the token just before `pos` is `{`: the first member of a type. */
function opensBlock(text: string, pos: number): boolean {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  return text[i] === "{";
}

/** A comment's text without its markers: `//`, `/*`, `*\/`, and leading `*`s. */
function commentText(text: string, range: ts.CommentRange): string {
  const raw = text.slice(range.pos, range.end);
  const body = range.kind === ts.SyntaxKind.SingleLineCommentTrivia
    ? raw.replace(/^\/\/+/, "")
    : raw.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
  const cleaned = body
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
    .join("\n")
    .trim();
  return DIRECTIVE.test(cleaned) ? "" : cleaned;
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join("\n").trim();
}

function newlines(text: string): number {
  return text.split("\n").length - 1;
}
