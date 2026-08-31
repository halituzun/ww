import { useProjectMapViewModel } from '../viewmodels/useProjectMapViewModel.js';
import type { ProjectMapFile, ProjectMapFunction, ProjectMapRoute } from '../services/projects.js';
import type { CSSProperties } from 'react';

const cardStyle = {
  background: 'rgba(15, 23, 42, 0.72)',
  border: '1px solid rgba(148, 163, 184, 0.16)',
  borderRadius: 8,
} satisfies CSSProperties;

function StatBox({ label, value }: {
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div style={{ ...cardStyle, padding: '12px 14px', minWidth: 130 }}>
      <div style={{ color: '#94a3b8', fontSize: 12 }}>{label}</div>
      <div style={{ color: '#f8fafc', fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function RouteLine({ route }: { readonly route: ProjectMapRoute }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 10, alignItems: 'baseline' }}>
      <span style={{ color: '#38bdf8', fontSize: 12, fontWeight: 700 }}>{route.httpMethod}</span>
      <span style={{ color: '#e2e8f0', fontSize: 12, overflowWrap: 'anywhere' }}>
        <code>{route.routePath}</code>
        <span style={{ color: '#64748b' }}> · {route.controller}.{route.methodName}:{route.line}</span>
      </span>
    </div>
  );
}

function FunctionLine({ fn }: { readonly fn: ProjectMapFunction }) {
  const name = fn.parent ? `${fn.parent}.${fn.name}` : fn.name;
  return (
    <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
      <code>{fn.async ? 'async ' : ''}{name}</code>
      <span style={{ color: '#64748b' }}> · {fn.kind}:{fn.line}</span>
      {fn.exported ? <span style={{ color: '#10b981' }}> · export</span> : null}
    </div>
  );
}

function FileCard({ file }: { readonly file: ProjectMapFile }) {
  const exported = file.functions.filter((fn) => fn.exported);
  const shownFunctions = exported.length > 0 ? exported : file.functions.slice(0, 5);
  return (
    <article style={{ ...cardStyle, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <code style={{ color: '#f8fafc', fontSize: 13, overflowWrap: 'anywhere' }}>{file.filePath}</code>
          <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>
            {file.layer} · {file.functions.length} fonksiyon · {file.routes.length} route
          </div>
        </div>
        <span style={{
          flexShrink: 0,
          color: '#94a3b8',
          background: 'rgba(30, 41, 59, 0.76)',
          border: '1px solid rgba(148, 163, 184, 0.16)',
          borderRadius: 6,
          padding: '4px 8px',
          fontSize: 12,
        }}>
          {file.exports.length} export
        </span>
      </div>

      {file.routes.length > 0 ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
          {file.routes.slice(0, 6).map((route) => (
            <RouteLine key={`${route.httpMethod}:${route.routePath}:${route.methodName}:${route.line}`} route={route} />
          ))}
        </div>
      ) : null}

      {shownFunctions.length > 0 ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 4 }}>
          {shownFunctions.map((fn) => (
            <FunctionLine key={`${fn.parent}:${fn.name}:${fn.line}`} fn={fn} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function ProjectMapPanel({ projectId }: { readonly projectId: string }) {
  const vm = useProjectMapViewModel(projectId);

  return (
    <section style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: '0 0 4px 0', color: '#f8fafc', fontSize: 16 }}>Proje Haritası</h3>
          <p style={{ margin: 0, color: '#94a3b8', fontSize: 13 }}>
            Dosya, fonksiyon ve controller uçları
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {vm.snapshotMessage ? <span style={{ color: '#10b981', fontSize: 12 }}>{vm.snapshotMessage}</span> : null}
          <button type="button" className="btn btn--secondary" onClick={() => void vm.refresh()} disabled={vm.loading}>
            Yenile
          </button>
          <button type="button" className="btn" onClick={() => void vm.persistSnapshot()} disabled={vm.saving || vm.loading}>
            Snapshot Al
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
        <StatBox label="Dosya" value={vm.stats.fileCount} />
        <StatBox label="Fonksiyon" value={vm.stats.functionCount} />
        <StatBox label="Route" value={vm.stats.routeCount} />
        <StatBox label="Export" value={vm.stats.exportedFunctionCount} />
      </div>

      <input
        type="text"
        aria-label="Proje haritasında ara"
        placeholder="Dosya, route veya fonksiyon ara..."
        value={vm.query}
        onChange={(event) => vm.setQuery(event.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: 'rgba(15, 23, 42, 0.72)',
          color: '#e2e8f0',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 13,
        }}
      />

      {vm.error ? <p className="canvas__error">{vm.error}</p> : null}
      {vm.loading && vm.map === null ? <p className="hint">Proje haritası yükleniyor...</p> : null}
      {!vm.loading && vm.map !== null && vm.files.length === 0 ? (
        <p className="hint">Bu aramayla eşleşen dosya yok.</p>
      ) : null}
      {!vm.loading && vm.map === null && !vm.error ? (
        <p className="hint">Bu proje için harita çıkarılamadı.</p>
      ) : null}

      <div style={{ display: 'grid', gap: 10 }}>
        {vm.files.slice(0, 80).map((file) => (
          <FileCard key={file.filePath} file={file} />
        ))}
      </div>
    </section>
  );
}
