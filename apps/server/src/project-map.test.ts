import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeProjectSourceFile, buildProjectMap } from './project-map.js';

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('project-map', () => {
  it('controller route ve fonksiyon konumlarını AST üzerinden çıkarır', () => {
    const file = analyzeProjectSourceFile('src/projects.controller.ts', `
import { Controller, Get, Post } from '@nestjs/common';

export function slugOf(name: string): string {
  return name.toLowerCase();
}

export const parseBody = async () => ({ ok: true });

@Controller('projects/:projectId/tasks')
export class TasksController {
  @Get()
  list() { return []; }

  @Post(':taskId/retry')
  async retry() { return {}; }
}
`);

    expect(file.exports).toEqual(['TasksController', 'parseBody', 'slugOf']);
    expect(file.functions.map((item) => ({
      name: item.name,
      kind: item.kind,
      parent: item.parent,
      async: item.async,
    }))).toEqual([
      { name: 'slugOf', kind: 'function', parent: '', async: false },
      { name: 'parseBody', kind: 'arrow_function', parent: '', async: true },
      { name: 'list', kind: 'method', parent: 'TasksController', async: false },
      { name: 'retry', kind: 'method', parent: 'TasksController', async: true },
    ]);
    expect(file.routes).toEqual([
      {
        controller: 'TasksController',
        methodName: 'list',
        httpMethod: 'GET',
        routePath: '/projects/:projectId/tasks',
        filePath: 'src/projects.controller.ts',
        line: 12,
      },
      {
        controller: 'TasksController',
        methodName: 'retry',
        httpMethod: 'POST',
        routePath: '/projects/:projectId/tasks/:taskId/retry',
        filePath: 'src/projects.controller.ts',
        line: 15,
      },
    ]);
  });

  it('workspace kaynaklarını tarar, üretilmiş klasörleri atlar ve özet sayaçları üretir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ww-project-map-'));
    cleanup.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'src', 'api.controller.ts'), `
import { Controller, Get } from '@nestjs/common';
@Controller('api')
export class ApiController {
  @Get('health')
  health() { return 'ok'; }
}
`, 'utf8');
    await writeFile(path.join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n', 'utf8');
    await writeFile(path.join(root, 'src', 'math.test.ts'), 'export const coversAdd = () => true;\n', 'utf8');
    await writeFile(path.join(root, 'dist', 'ignored.ts'), 'export const ignored = true;\n', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'ignored.ts'), 'export const alsoIgnored = true;\n', 'utf8');

    const map = await buildProjectMap(root, { now: () => '2026-08-29T00:00:00.000Z' });

    expect(map.generatedAt).toBe('2026-08-29T00:00:00.000Z');
    expect(map.files.map((file) => file.filePath)).toEqual(['src/api.controller.ts', 'src/math.test.ts', 'src/math.ts']);
    expect(map.files.find((file) => file.filePath === 'src/math.test.ts')?.layer).toBe('test');
    expect(map.fileCount).toBe(3);
    expect(map.functionCount).toBe(3);
    expect(map.routeCount).toBe(1);
    expect(map.routes[0]).toMatchObject({
      controller: 'ApiController',
      methodName: 'health',
      httpMethod: 'GET',
      routePath: '/api/health',
      filePath: 'src/api.controller.ts',
    });
    expect(map.functions.map((item) => `${item.filePath}:${item.name}`))
      .toEqual(['src/api.controller.ts:health', 'src/math.test.ts:coversAdd', 'src/math.ts:add']);
  });
});
