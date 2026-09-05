#!/usr/bin/env node
// Issue #1177: TypeScript's structural function types do not retain whether a value
// needs a `this` receiver. Keep detached class/interface method references out of src.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import allowlist from "./unboundMethodAllowlist.json" with { type: "json" };

const BOUND_RECEIVER_MEMBERS = new Set(["bind", "call", "apply"]);

const isMethodDeclaration = (declaration) =>
  ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration);

const isWithin = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("../") && !path.includes("/../"));
};

const unwrapParenthesesAndNonNull = (node) => {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)) {
    current = current.parent;
  }
  return current;
};

const isCallTarget = (node) => {
  const expression = unwrapParenthesesAndNonNull(node);
  return (ts.isCallExpression(expression.parent) && expression.parent.expression === expression)
    || (ts.isTaggedTemplateExpression(expression.parent) && expression.parent.tag === expression);
};

const isBoundReceiver = (node) => {
  const expression = unwrapParenthesesAndNonNull(node);
  const parent = expression.parent;
  return ts.isPropertyAccessExpression(parent)
    && parent.expression === expression
    && BOUND_RECEIVER_MEMBERS.has(parent.name.text)
    && ts.isCallExpression(parent.parent)
    && parent.parent.expression === parent;
};

const isBooleanConstructorArgument = (node) =>
  ts.isCallExpression(node.parent)
  && node.parent.arguments.length === 1
  && node.parent.arguments[0] === node
  && ts.isIdentifier(node.parent.expression)
  && node.parent.expression.text === "Boolean";

const isExistenceCheck = (node) => {
  let current = unwrapParenthesesAndNonNull(node);
  const parent = current.parent;

  if (isBooleanConstructorArgument(current)) return true;
  if (ts.isTypeOfExpression(parent) && parent.expression === current) return true;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (
    (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
    && parent.expression === current
  ) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === current) return true;
  if (
    ts.isBinaryExpression(parent)
    && (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) return true;
  return false;
};

const propertyName = (node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : null;

const symbolAtPropertyName = (checker, node) =>
  ts.isPropertyAccessExpression(node)
    ? checker.getSymbolAtLocation(node.name)
    : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      ? checker.getSymbolAtLocation(node)
        ?? checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text)
      : undefined;

const allowlistKey = (entry) => `${entry.file}\u0000${entry.member}`;

/**
 * @typedef {{ file: string, member: string, reason: string }} UnboundMethodAllowlistEntry
 * @typedef {{ file: string, line: number, column: number, member: string }} UnboundMethodFinding
 * @typedef {{ sourceDirectory: string, allowlist: readonly UnboundMethodAllowlistEntry[] }} UnboundMethodScanOptions
 */

/**
 * @param {ts.Program} program
 * @param {UnboundMethodScanOptions} options
 * @returns {{ findings: UnboundMethodFinding[], staleAllowlistEntries: UnboundMethodAllowlistEntry[] }}
 */
export const findUnboundMethodReferences = (program, options) => {
  const checker = program.getTypeChecker();
  const findings = [];
  const usedAllowlistEntries = new Set();
  const allowlistByKey = new Map(options.allowlist.map((entry) => [allowlistKey(entry), entry]));

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isWithin(options.sourceDirectory, sourceFile.fileName)) continue;

    const visit = (node) => {
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && propertyName(node) !== null) {
        const member = propertyName(node);
        if (
          member !== null
          && !isCallTarget(node)
          && !isBoundReceiver(node)
          && !isExistenceCheck(node)
          && !ts.isPropertyAccessExpression(node.parent)
        ) {
          const symbol = symbolAtPropertyName(checker, node);
          const declarations = symbol?.getDeclarations() ?? [];
          const declaredInOwnSource = declarations.length > 0
            && declarations.every((declaration) => isWithin(options.sourceDirectory, declaration.getSourceFile().fileName));

          if (declaredInOwnSource && declarations.every(isMethodDeclaration)) {
            const file = relative(dirname(options.sourceDirectory), sourceFile.fileName).split("\\").join("/");
            const key = allowlistKey({ file, member });
            if (allowlistByKey.has(key)) {
              usedAllowlistEntries.add(key);
            } else {
              const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
              findings.push({ file, line: position.line + 1, column: position.character + 1, member });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return {
    findings,
    staleAllowlistEntries: options.allowlist.filter((entry) => !usedAllowlistEntries.has(allowlistKey(entry))),
  };
};

export const createRuntimeProgram = (backendDirectory) => {
  const configPath = resolve(backendDirectory, "tsconfig.runtime.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }
  return ts.createProgram(parsed.fileNames, parsed.options);
};

const run = () => {
  const backendDirectory = fileURLToPath(new URL("..", import.meta.url));
  const result = findUnboundMethodReferences(createRuntimeProgram(backendDirectory), {
    sourceDirectory: resolve(backendDirectory, "src"),
    allowlist,
  });

  if (result.findings.length === 0 && result.staleAllowlistEntries.length === 0) {
    console.log("✔ no unreviewed detached method references");
    return;
  }

  if (result.findings.length > 0) {
    console.error("✖ Detached method references found:");
    for (const finding of result.findings) {
      console.error(`  ${finding.file}:${finding.line}:${finding.column} ${finding.member}: detached method reference; bind it or pass an arrow`);
    }
  }
  if (result.staleAllowlistEntries.length > 0) {
    console.error("✖ Stale unbound-method allowlist entries found:");
    for (const entry of result.staleAllowlistEntries) {
      console.error(`  ${entry.file} ${entry.member}: ${entry.reason}`);
    }
  }
  process.exitCode = 1;
};

if (import.meta.url === `file://${process.argv[1]}`) run();
