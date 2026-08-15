import Editor from '@monaco-editor/react';

export function FileEditor({ filePath, summary }: { readonly filePath?: string | undefined; readonly summary?: string | undefined }) {
  const value = filePath === undefined ? '// Bir dosya seçin' : `// ${filePath}\n// ${summary ?? 'Fihrist özeti bulunamadı.'}`;
  return <div className="file-editor"><Editor height="360px" language="typescript" theme="vs-dark" value={value} options={{ readOnly: true, minimap: { enabled: false }, wordWrap: 'on' }} /></div>;
}
