// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectMapPanel } from './ProjectMapPanel.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const respond = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

const mapBody = {
  root: '/workspace/demo',
  generatedAt: '2026-08-29T10:00:00.000Z',
  fileCount: 2,
  functionCount: 2,
  routeCount: 1,
  routes: [{
    controller: 'ApiController',
    methodName: 'health',
    httpMethod: 'GET',
    routePath: '/api/health',
    filePath: 'src/api.controller.ts',
    line: 12,
  }],
  functions: [
    {
      name: 'health',
      filePath: 'src/api.controller.ts',
      line: 12,
      exported: true,
      async: false,
      kind: 'method',
      parent: 'ApiController',
    },
    {
      name: 'helper',
      filePath: 'src/internal.ts',
      line: 3,
      exported: false,
      async: false,
      kind: 'function',
      parent: '',
    },
  ],
  files: [
    {
      filePath: 'src/api.controller.ts',
      layer: 'controller',
      exports: ['ApiController'],
      functions: [{
        name: 'health',
        filePath: 'src/api.controller.ts',
        line: 12,
        exported: true,
        async: false,
        kind: 'method',
        parent: 'ApiController',
      }],
      routes: [{
        controller: 'ApiController',
        methodName: 'health',
        httpMethod: 'GET',
        routePath: '/api/health',
        filePath: 'src/api.controller.ts',
        line: 12,
      }],
    },
    {
      filePath: 'src/internal.ts',
      layer: 'service',
      exports: [],
      functions: [{
        name: 'helper',
        filePath: 'src/internal.ts',
        line: 3,
        exported: false,
        async: false,
        kind: 'function',
        parent: '',
      }],
      routes: [],
    },
  ],
};

describe('ProjectMapPanel', () => {
  it('proje haritasini metrikler, route ve fonksiyonlarla cizer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(mapBody) as never);

    render(<ProjectMapPanel projectId="p1" />);

    await waitFor(() => expect(screen.getByText('src/api.controller.ts')).toBeDefined());
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('/api/health')).toBeDefined();
    expect(screen.getAllByText(/ApiController.health/).length).toBeGreaterThanOrEqual(1);
  });

  it('arama dosya listesini daraltir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(mapBody) as never);

    render(<ProjectMapPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText('src/internal.ts')).toBeDefined());
    fireEvent.change(screen.getByLabelText('Proje haritasında ara'), {
      target: { value: 'health' },
    });

    expect(screen.getByText('src/api.controller.ts')).toBeDefined();
    expect(screen.queryByText('src/internal.ts')).toBeNull();
  });
});
