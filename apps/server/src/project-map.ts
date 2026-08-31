import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { classifyLayer } from './artifact-classify.js';
import { resolveWorkspaceFile } from './workspace-file-path.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRS = new Set([
  '.git',
  '.ww-trash',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const MAX_SOURCE_BYTES = 768 * 1024;

export interface ProjectMapFunction {
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  readonly exported: boolean;
  readonly async: boolean;
  readonly kind: 'function' | 'arrow_function' | 'method';
  readonly parent: string;
}

export interface ProjectMapControllerRoute {
  readonly controller: string;
  readonly methodName: string;
  readonly httpMethod: string;
  readonly routePath: string;
  readonly filePath: string;
  readonly line: number;
}

export interface ProjectMapFile {
  readonly filePath: string;
  readonly layer: string;
  readonly exports: readonly string[];
  readonly functions: readonly ProjectMapFunction[];
  readonly routes: readonly ProjectMapControllerRoute[];
}

export interface ProjectMap {
  readonly root: string;
  readonly generatedAt: string;
  readonly fileCount: number;
  readonly functionCount: number;
  readonly routeCount: number;
  readonly files: readonly ProjectMapFile[];
  readonly functions: readonly ProjectMapFunction[];
  readonly routes: readonly ProjectMapControllerRoute[];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === kind);
}

function decoratorCallName(decorator: ts.Decorator): string {
  const expression = decorator.expression;
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return '';
}

function decoratorStringArg(decorator: ts.Decorator): string {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression)) return '';
  const first = expression.arguments[0];
  if (first === undefined) return '';
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return '';
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function routeJoin(base: string, child: string): string {
  const joined = [base, child]
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
  return joined === '' ? '/' : `/${joined}`;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function nameOfBinding(name: ts.BindingName): string {
  return ts.isIdentifier(name) ? name.text : name.getText();
}

function exportedNamesOf(node: ts.Node): readonly string[] {
  if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return [];
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return node.name === undefined ? [] : [node.name.text];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((declaration) => nameOfBinding(declaration.name));
  }
  return [];
}

function httpDecoratorMethod(name: string): string {
  const methods: Record<string, string> = {
    Delete: 'DELETE',
    Get: 'GET',
    Head: 'HEAD',
    Options: 'OPTIONS',
    Patch: 'PATCH',
    Post: 'POST',
    Put: 'PUT',
  };
  return methods[name] ?? '';
}

export function analyzeProjectSourceFile(filePath: string, content: string): ProjectMapFile {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const exports = new Set<string>();
  const functions: ProjectMapFunction[] = [];
  const routes: ProjectMapControllerRoute[] = [];

  function addFunction(input: Omit<ProjectMapFunction, 'filePath'>): void {
    functions.push(Object.freeze({ ...input, filePath }));
  }

  function visit(node: ts.Node, parentClass = ''): void {
    for (const name of exportedNamesOf(node)) exports.add(name);

    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      addFunction({
        name: node.name.text,
        line: lineOf(source, node),
        exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
        async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        kind: 'function',
        parent: '',
      });
    }

    if (ts.isVariableStatement(node)) {
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          addFunction({
            name: nameOfBinding(declaration.name),
            line: lineOf(source, declaration),
            exported,
            async: hasModifier(initializer, ts.SyntaxKind.AsyncKeyword),
            kind: 'arrow_function',
            parent: '',
          });
        }
      }
    }

    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? '(anonymous)';
      const controllerDecorator = decoratorsOf(node).find((decorator) => decoratorCallName(decorator) === 'Controller');
      const controllerBase = controllerDecorator === undefined ? undefined : decoratorStringArg(controllerDecorator);
      if (hasModifier(node, ts.SyntaxKind.ExportKeyword) && node.name !== undefined) exports.add(node.name.text);

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const methodName = member.name.getText(source);
        addFunction({
          name: methodName,
          line: lineOf(source, member),
          exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
          async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
          kind: 'method',
          parent: className,
        });
        if (controllerBase === undefined) continue;
        for (const decorator of decoratorsOf(member)) {
          const httpMethod = httpDecoratorMethod(decoratorCallName(decorator));
          if (httpMethod === '') continue;
          routes.push(Object.freeze({
            controller: className,
            methodName,
            httpMethod,
            routePath: routeJoin(controllerBase, decoratorStringArg(decorator)),
            filePath,
            line: lineOf(source, member),
          }));
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, parentClass));
  }

  visit(source);

  return Object.freeze({
    filePath,
    layer: classifyLayer(filePath),
    exports: Object.freeze([...exports].sort()),
    functions: Object.freeze(functions.sort((left, right) => left.line - right.line)),
    routes: Object.freeze(routes.sort((left, right) => left.routePath.localeCompare(right.routePath))),
  });
}

async function walkSourceFiles(root: string, dir: string, found: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walkSourceFiles(root, absolute, found);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative.startsWith('..')) continue;
    found.push(relative);
  }
}

export async function buildProjectMap(workspaceRoot: string, options: {
  readonly limit?: number;
  readonly now?: () => string;
} = {}): Promise<ProjectMap> {
  const root = path.resolve(workspaceRoot);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error('workspace kökü dizin olmalıdır');

  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error('proje haritası dosya limiti geçersiz');
  }

  const paths: string[] = [];
  await walkSourceFiles(root, root, paths);
  paths.sort();
  if (paths.length > limit) throw new Error(`proje haritası dosya limiti aşıldı: ${paths.length} > ${limit}`);

  const files: ProjectMapFile[] = [];
  for (const filePath of paths) {
    const absolute = resolveWorkspaceFile(root, filePath);
    const fileInfo = await stat(absolute);
    if (fileInfo.size > MAX_SOURCE_BYTES) continue;
    files.push(analyzeProjectSourceFile(filePath, await readFile(absolute, 'utf8')));
  }

  const functions = files.flatMap((file) => [...file.functions]);
  const routes = files.flatMap((file) => [...file.routes]);
  return Object.freeze({
    root,
    generatedAt: options.now?.() ?? new Date().toISOString(),
    fileCount: files.length,
    functionCount: functions.length,
    routeCount: routes.length,
    files: Object.freeze(files),
    functions: Object.freeze(functions),
    routes: Object.freeze(routes),
  });
}
