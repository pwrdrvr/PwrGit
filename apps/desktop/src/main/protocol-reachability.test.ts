import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { CommandName } from "@pwrgit/shared";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROTOCOL = join(ROOT, "packages/shared/src/protocol.ts");
const MAIN = join(ROOT, "apps/desktop/src/main");
const RENDERER = join(ROOT, "apps/desktop/src/renderer/src");
const TRANSPORT_TESTS = join(ROOT, "apps/desktop/e2e");

/**
 * Commands that intentionally have no shipped renderer action. Each entry
 * must still appear in a direct transport test, or this suite rejects it.
 */
const NON_RENDERER_TRANSPORT_COMMANDS = [
  "ping"
] as const satisfies readonly CommandName[];

function typescriptFiles(root: string, includeTests: boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFiles(path, includeTests));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry.name))) continue;
    if (!includeTests && /\.(?:test|spec)\.[^.]+$/.test(entry.name)) continue;
    files.push(path);
  }
  return files;
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function protocolKeys(interfaceName: "Commands" | "Events"): string[] {
  const source = parse(PROTOCOL);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName
  );
  if (declaration === undefined) {
    throw new Error(`Missing ${interfaceName} interface in ${PROTOCOL}`);
  }

  return declaration.members.map((member) => {
    if (!ts.isPropertySignature(member) || member.name === undefined) {
      throw new Error(`${interfaceName} contains a non-property member`);
    }
    if (
      ts.isIdentifier(member.name) ||
      ts.isStringLiteral(member.name) ||
      ts.isNumericLiteral(member.name)
    ) {
      return member.name.text;
    }
    throw new Error(`${interfaceName} contains a computed property`);
  });
}

function visitFiles(
  files: string[],
  inspect: (node: ts.Node, source: ts.SourceFile) => void
): void {
  for (const file of files) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      inspect(node, source);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

function stringLiterals(files: string[]): Set<string> {
  const literals = new Set<string>();
  visitFiles(files, (node) => {
    if (ts.isStringLiteralLike(node)) literals.add(node.text);
  });
  return literals;
}

function directCallArguments(
  files: string[],
  isTarget: (expression: ts.LeftHandSideExpression) => boolean
): string[] {
  const calls: string[] = [];
  visitFiles(files, (node) => {
    if (!ts.isCallExpression(node) || !isTarget(node.expression)) return;
    const first = node.arguments[0];
    if (first !== undefined && ts.isStringLiteralLike(first)) {
      calls.push(first.text);
    }
  });
  return calls;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

const mainFiles = typescriptFiles(MAIN, false);
const rendererFiles = typescriptFiles(RENDERER, false);
const transportTestFiles = typescriptFiles(TRANSPORT_TESTS, true);
const commands = protocolKeys("Commands");
const events = protocolKeys("Events");

describe("shared protocol reachability", () => {
  it("registers every command in main exactly once", () => {
    const registrations = directCallArguments(
      mainFiles,
      (expression) =>
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "bus" &&
        expression.name.text === "register"
    );

    expect(sorted(registrations)).toEqual(sorted(commands));
  });

  it("keeps every command reachable from renderer code or a direct transport test", () => {
    const rendererLiterals = stringLiterals(rendererFiles);
    const transportCalls = new Set(
      directCallArguments(
        transportTestFiles,
        (expression) =>
          ts.isPropertyAccessExpression(expression) &&
          expression.name.text === "dispatch"
      )
    );
    const allowlist = new Set<string>(NON_RENDERER_TRANSPORT_COMMANDS);

    expect(
      NON_RENDERER_TRANSPORT_COMMANDS.filter((name) =>
        rendererLiterals.has(name)
      )
    ).toEqual([]);
    expect(
      NON_RENDERER_TRANSPORT_COMMANDS.filter(
        (name) => !transportCalls.has(name)
      )
    ).toEqual([]);
    expect(
      commands.filter(
        (name) => !rendererLiterals.has(name) && !allowlist.has(name)
      )
    ).toEqual([]);
  });

  it("emits every event from main and consumes every event in renderer code", () => {
    const emissions = new Set(
      directCallArguments(
        mainFiles,
        (expression) =>
          ts.isIdentifier(expression) && expression.text === "emitEvent"
      )
    );
    const subscriptions = new Set(
      directCallArguments(
        rendererFiles,
        (expression) =>
          ts.isIdentifier(expression) && expression.text === "subscribe"
      )
    );

    expect(sorted(emissions)).toEqual(sorted(events));
    expect(sorted(subscriptions)).toEqual(sorted(events));
  });
});
