import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

type Rule = { name: string; exempt: RegExp; message: string; hit: (node: ts.Node) => boolean };
type Exception = { file: string; rule: string; count: number; reason: string };
type Hit = { file: string; line: number; rule: Rule };

// Adding or raising an entry needs the user's approval. No comment in the code silences a rule.
const exceptions: Exception[] = [
  { file: 'src/title.ts', rule: 'swallowed-error', count: 1, reason: 'A ctx captured before a session replacement is stale; the next session sets its own title.' },
  { file: 'src/import/sources.ts', rule: 'swallowed-error', count: 1, reason: 'A quoted value that is not JSON is plain text.' },
  { file: 'src/index.ts', rule: 'swallowed-error', count: 2, reason: 'stop() after an import ignores the import task, whose own command reports its failure; stop() in the session_start catch must not replace the original error.' },
];

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
const emptyBlock = (node: ts.Node) => ts.isBlock(node) && node.statements.length === 0;

const rules: Rule[] = [
  { name: 'recipe-literal', exempt: /^src\/(memory|prompts)\.ts$/, message: 'Recipe constant as a literal. Import CAP, NODE or VIEW from src/memory.ts.',
    hit: node => ts.isNumericLiteral(node) && [512, 128_000, 30_000].includes(Number(node.text.replaceAll('_', ''))) },
  { name: 'swallowed-error', exempt: /^$/, message: 'Error swallowed. Handle it, or add an entry with a reason to exceptions in scripts/lint.ts, which needs the user\'s approval.',
    hit: node => (ts.isCatchClause(node) && emptyBlock(node.block)) ||
      (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch'
        && node.arguments.length === 1 && ts.isArrowFunction(node.arguments[0]) && emptyBlock(node.arguments[0].body)) },
];

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? (entry.name === 'fixtures' ? [] : walk(path)) : path.endsWith('.ts') ? [path] : [];
});

const root = process.argv[2] ?? '.';
const hits: Hit[] = [];
for (const file of ['src', 'test'].flatMap(dir => walk(join(root, dir)))) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const path = relative(root, file);
  const visit = (node: ts.Node) => {
    for (const rule of rules) if (!rule.exempt.test(path) && rule.hit(node)) hits.push({ file: path, line: lineOf(sf, node.getStart()) + 1, rule });
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

let failed = false;
const fail = (line: string) => { failed = true; console.log(line); };
const pairs = new Set([...hits.map(hit => `${hit.file}\t${hit.rule.name}`), ...exceptions.map(entry => `${entry.file}\t${entry.rule}`)]);
for (const pair of pairs) {
  const [file, name] = pair.split('\t');
  const found = hits.filter(hit => hit.file === file && hit.rule.name === name);
  const allowed = exceptions.find(entry => entry.file === file && entry.rule === name)?.count ?? 0;
  if (found.length > allowed) {
    for (const hit of found) fail(`${hit.file}:${hit.line} ${name} ${hit.rule.message}`);
    fail(`scripts/lint.ts: ${file} has ${found.length} ${name} hits and allows ${allowed}. Fix the code, or add an approved entry to exceptions.`);
  } else if (found.length < allowed) fail(`scripts/lint.ts: the ${name} exception for ${file} allows ${allowed} but the file has ${found.length}. Lower its count or remove it.`);
}
process.exitCode = failed ? 1 : 0;
