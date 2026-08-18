import { describe, expect, it } from 'vitest';
import { auditStandards, auditMvvmView, isViewFile } from './standards-audit.js';

const view = 'src/components/TodoList.tsx';

describe('isViewFile', () => {
  it('bilesen ve sayfa dosyalarini View sayar', () => {
    expect(isViewFile('src/components/A.tsx')).toBe(true);
    expect(isViewFile('src/pages/B.tsx')).toBe(true);
    expect(isViewFile('src/views/C.jsx')).toBe(true);
  });

  // ViewModel ve servisler bu kuralın hedefi DEĞİLDİR; onlarda fetch olması
  // beklenen davranıştır. Onları raporlamak denetimi gürültüye boğar.
  it('viewmodel ve servisleri View saymaz', () => {
    expect(isViewFile('src/viewmodels/useTodo.ts')).toBe(false);
    expect(isViewFile('src/services/todos.ts')).toBe(false);
  });

  it('tsx olmayan dosyalari View saymaz', () => {
    expect(isViewFile('src/components/helper.ts')).toBe(false);
  });
});

describe('auditMvvmView', () => {
  // docs/09: "View'da fetch/iş mantığı yasak".
  it('Viewdaki dogrudan fetch cagrisini bulur', () => {
    const findings = auditMvvmView(view, 'export function A() {\n  fetch("/api/todos");\n}\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('STD-001');
    expect(findings[0]!.severity).toBe('high');
  });

  it('kaniti dosya ve satir olarak verir', () => {
    const findings = auditMvvmView(view, 'const a = 1;\nfetch("/api");\n');
    expect(findings[0]!.evidenceRefs).toEqual([`file:${view}:2`]);
  });

  it('Viewdaki useState/useEffect kullanimini bulur', () => {
    const findings = auditMvvmView(view, 'const [a, setA] = useState(0);\n');
    expect(findings.map((f) => f.severity)).toEqual(['medium']);
  });

  // Yorum satırındaki söz, ihlal değildir. Aksi halde kuralı AÇIKLAYAN yorum
  // kendi kendine bulgu üretirdi.
  it('yorumdaki fetch sozunu ihlal saymaz', () => {
    expect(auditMvvmView(view, '// burada fetch() cagrilmaz\nexport const A = 1;\n')).toHaveLength(0);
    expect(auditMvvmView(view, '/*\n fetch("/api");\n*/\nexport const A = 1;\n')).toHaveLength(0);
  });

  it('temiz Viewda bulgu uretmez', () => {
    const clean = 'import { useTodoViewModel } from "../viewmodels/useTodo.js";\n'
      + 'export function A() { const { items } = useTodoViewModel(); return items.length; }\n';
    expect(auditMvvmView(view, clean)).toHaveLength(0);
  });

  it('View olmayan dosyayi denetlemez', () => {
    expect(auditMvvmView('src/services/todos.ts', 'fetch("/api");')).toHaveLength(0);
  });

  it('hem fetch hem durum varsa ikisini de bildirir', () => {
    const findings = auditMvvmView(view, 'const [a] = useState(0);\nfetch("/api");\n');
    expect(findings).toHaveLength(2);
  });

  // docs/09 satır 47-48 altı kontrol tanımlıyor; denetçi yalnız GÖRÜNÜM
  // katmanına bakıyordu. `services/` ve `viewmodels/` hiç denetlenmiyordu:
  // yani standardın üçte ikisi yazılı ama uygulanmıyordu.
  describe('servis katmanı (docs/09: "Service React import etmez")', () => {
    it('servis React import ederse bulgu acar', () => {
      const found = auditStandards(
        'apps/panel/src/services/projects.ts',
        "import { useState } from 'react';\nexport const a = 1;\n",
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.ruleId).toBe('STD-003');
      expect(found[0]!.summary).toContain('React');
    });

    it('React importu olmayan servis temizdir', () => {
      expect(auditStandards(
        'apps/panel/src/services/projects.ts',
        "export async function load(): Promise<number> { return 1; }\n",
      )).toEqual([]);
    });

    // Yorumdaki "react" kelimesi ihlal DEĞİLDİR.
    it('yorumdaki react kelimesini ihlal saymaz', () => {
      expect(auditStandards(
        'apps/panel/src/services/projects.ts',
        "// bu dosya react import etmez\nexport const a = 1;\n",
      )).toEqual([]);
    });
  });

  describe('viewmodel katmanı (docs/09: "ViewModel DOMa dokunmaz")', () => {
    it('viewmodel DOMa dokunursa bulgu acar', () => {
      const found = auditStandards(
        'apps/panel/src/viewmodels/useThing.ts',
        "export function useThing() { document.querySelector('#x'); }\n",
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.ruleId).toBe('STD-002');
    });

    // ASIL RİSK — YANLIŞ POZİTİF: `window.setInterval` bir ZAMANLAYICIDIR,
    // DOM erişimi değil. Mevcut viewmodel'lerin çoğu onu kullanıyor; bunu
    // ihlal saymak denetçiyi gürültüye boğar ve gürültü kapıyı aşındırır.
    it('window.setInterval kullanimini ihlal SAYMAZ', () => {
      expect(auditStandards(
        'apps/panel/src/viewmodels/useThing.ts',
        'export function useThing() { const t = window.setInterval(() => undefined, 5); return t; }\n',
      )).toEqual([]);
    });
  });

  it('gorunum kurallari eskisi gibi calisir', () => {
    const found = auditStandards(
      'apps/panel/src/components/Thing.tsx',
      'export function Thing() { const [a] = useState(1); return a; }\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.ruleId).toBe('STD-001');
  });

  // docs/09 `ui_audit` — "Erişilebilirlik: kontrast, dokunma hedefi boyutu,
  // LABEL'lar". Bu denetçinin hiç uygulaması yoktu; yalnız profil adı bir
  // sabit olarak duruyordu.
  //
  // ww'nin KENDİ paneli bu kuralda temiz (ölçüldü). Kuralın asıl işi
  // ÜRETİLEN projeleri denetlemek — docs/09 zaten böyle tanımlıyor.
  describe('ui_audit — erişilebilir ad', () => {
    it('etiketsiz inputu bulgu olarak acar', () => {
      const found = auditStandards(
        'src/components/Form.tsx',
        'export function Form() { return <input value={x} onChange={f} />; }\n',
      );
      expect(found.map((v) => v.ruleId)).toEqual(['STD-004']);
      expect(found[0]!.summary).toContain('erişilebilir ad');
    });

    it('aria-label tasiyan inputu bulgu saymaz', () => {
      expect(auditStandards(
        'src/components/Form.tsx',
        'export function Form() { return <input aria-label="Ad" value={x} />; }\n',
      )).toEqual([]);
    });

    // Çok satırlı JSX yaygındır; tek satır varsayan bir kontrol gerçek
    // kodda çalışmaz (bu ölçümü elle yaparken tam da buna takıldım).
    it('cok satirli inputta aria-labeli gorur', () => {
      expect(auditStandards(
        'src/components/Form.tsx',
        ['export function Form() {', '  return (', '    <input', '      type="range"',
         '      aria-label="Geçmişte konum"', '    />', '  );', '}'].join('\n'),
      )).toEqual([]);
    });

    // <label for> ile eşleşebilecek input'u ihlal saymak YANLIŞ POZİTİF olur.
    it('id tasiyan inputu bulgu saymaz', () => {
      expect(auditStandards(
        'src/components/Form.tsx',
        'export function Form() { return <input id="ad" value={x} />; }\n',
      )).toEqual([]);
    });

    it('gizli inputu bulgu saymaz', () => {
      expect(auditStandards(
        'src/components/Form.tsx',
        'export function Form() { return <input type="hidden" value={x} />; }\n',
      )).toEqual([]);
    });

    // Kural yalnız GÖRÜNÜM katmanına uygulanır.
    it('viewmodel dosyasinda input arayip bulgu uretmez', () => {
      expect(auditStandards(
        'src/viewmodels/useForm.ts',
        'export const template = "<input value=1>";\n',
      )).toEqual([]);
    });
  });

  // KÖR NOKTA: `isViewFile` yalnız components/views/pages altına bakıyordu,
  // yani KÖK bileşen (App.tsx) hiç denetlenmiyordu — oysa o da bir görünüm
  // ve panelin en çok dokunulan dosyası. Kuralın en önemli dosyayı atlaması,
  // kuralı yarı yarıya işlevsiz bırakır.
  describe('kök bileşen', () => {
    it('App.tsx gorunum sayilir', () => {
      const found = auditStandards(
        'apps/panel/src/App.tsx',
        'export default function App() { const [a] = useState(1); return a; }\n',
      );
      expect(found.map((v) => v.ruleId)).toEqual(['STD-001']);
    });

    // Giriş dosyası bileşen DEĞİLDİR: yalnız kökü DOM'a bağlar ve orada
    // durum tutmak zaten anlamsızdır. Onu denetlemek gürültü olurdu.
    it('main.tsx denetlenmez', () => {
      expect(auditStandards(
        'apps/panel/src/main.tsx',
        'createRoot(document.getElementById("root")!).render(<App />);\n',
      )).toEqual([]);
    });

    it('rastgele bir kok dosya gorunum sayilmaz', () => {
      expect(auditStandards(
        'apps/panel/src/vite-env.d.ts',
        'const x = 1;\n',
      )).toEqual([]);
    });
  });
});
