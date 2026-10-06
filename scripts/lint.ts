import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

type Rule = { name: string; exempt: RegExp; message: string; hit: (node: ts.Node, lines: string[], sf: ts.SourceFile) => boolean };

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
const hasWhy = (node: ts.Node, lines: string[], sf: ts.SourceFile) =>
  lines.slice(lineOf(sf, node.getStart()), lineOf(sf, node.getEnd()) + 1).some(line => line.includes('// why:'));
const emptyBlock = (node: ts.Node) => ts.isBlock(node) && node.statements.length === 0;

const rules: Rule[] = [
  { name: 'recipe-literal', exempt: /^src\/(memory|prompts)\.ts$/, message: 'Recipe constant as a literal. Import CAP, NODE or VIEW from src/memory.ts.',
    hit: node => ts.isNumericLiteral(node) && [512, 128_000, 30_000].includes(Number(node.text.replaceAll('_', ''))) },
  { name: 'swallowed-error', exempt: /^$/, message: 'Error swallowed. Handle it, or add "// why: <reason>" on the same line.',
    hit: (node, lines, sf) =>
      ((ts.isCatchClause(node) && emptyBlock(node.block)) ||
        (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch'
          && node.arguments.length === 1 && ts.isArrowFunction(node.arguments[0]) && emptyBlock(node.arguments[0].body)))
      && !hasWhy(node, lines, sf) },
];

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? (entry.name === 'fixtures' ? [] : walk(path)) : path.endsWith('.ts') ? [path] : [];
});

const root = process.argv[2] ?? '.';
let hits = 0;
for (const file of ['src', 'test'].flatMap(dir => walk(join(root, dir)))) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const path = relative(root, file);
  const visit = (node: ts.Node) => {
    for (const rule of rules) if (!rule.exempt.test(path) && rule.hit(node, lines, sf)) {
      hits++;
      console.log(`${path}:${lineOf(sf, node.getStart()) + 1} ${rule.name} ${rule.message}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
process.exitCode = hits ? 1 : 0;
