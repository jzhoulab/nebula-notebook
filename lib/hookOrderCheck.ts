/**
 * Static guard: React hooks must not appear after an early return.
 *
 * Every hook has to run on every render, so a hook placed below an early
 * return (`if (!isOpen) return null;`) runs only on some renders — React then
 * throws #310, "Rendered more hooks than during the previous render", and the
 * component dies behind the error boundary. This shipped once (the compute
 * allocation modal crashed on open, 2026-08-31).
 *
 * The rule is normally enforced by eslint-plugin-react-hooks in an editor;
 * this project has no ESLint and no editor in the loop, so the same check runs
 * in the test suite (and therefore in CI) using the TypeScript parser that is
 * already a dependency.
 */

import * as ts from 'typescript';

export interface HookOrderViolation {
  file: string;
  line: number;
  hook: string;
  returnLine: number;
}

const HOOK_RE = /^use[A-Z0-9]/;

function hookName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const expr = node.expression;
  if (ts.isIdentifier(expr) && HOOK_RE.test(expr.text)) return expr.text;
  // React.useEffect(...)
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name) && HOOK_RE.test(expr.name.text)) {
    return expr.name.text;
  }
  return null;
}

/** Hook calls in this statement, NOT descending into nested function bodies. */
function hookCallsIn(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (n !== node && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassDeclaration(n))) {
      return; // callback bodies are a different scope
    }
    if (hookName(n)) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Report hooks that would not run on every render of their component.
 * Applies to any function that calls hooks at its top level — components and
 * custom hooks alike, which is exactly the rule's scope.
 */
export function findHookOrderViolations(fileName: string, source: string): HookOrderViolation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: HookOrderViolation[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const checkBody = (body: ts.Block) => {
    const stmts = body.statements;
    const callsHooks = stmts.some((s) => hookCallsIn(s).length > 0);
    if (!callsHooks) return;
    const returnIdx = stmts.findIndex((s) => ts.isReturnStatement(s) || containsTopLevelReturn(s));
    if (returnIdx === -1) return;
    const returnLine = lineOf(stmts[returnIdx]);
    for (let i = returnIdx + 1; i < stmts.length; i += 1) {
      for (const call of hookCallsIn(stmts[i])) {
        violations.push({ file: fileName, line: lineOf(call), hook: hookName(call)!, returnLine });
      }
    }
  };

  /** `if (cond) return x;` / `if (cond) { return x; }` — an early return. */
  const containsTopLevelReturn = (stmt: ts.Statement): boolean => {
    if (!ts.isIfStatement(stmt)) return false;
    const branch = stmt.thenStatement;
    if (ts.isReturnStatement(branch)) return true;
    return ts.isBlock(branch) && branch.statements.some(ts.isReturnStatement);
  };

  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
        node.body && ts.isBlock(node.body)) {
      checkBody(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}
