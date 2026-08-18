import { describe, expect, it } from 'vitest';
import {
  correctiveTargetFiles,
  correctiveTaskDescription,
  viewModelPathFor,
  correctiveTargetFilesFor,
  correctiveDescriptionFor,
} from './corrective-task.js';

describe('viewModelPathFor', () => {
  it('bilesen yolundan viewmodel yolu turetir', () => {
    expect(viewModelPathFor('src/components/Counter.tsx')).toBe('src/viewmodels/useCounter.ts');
  });

  it('jsx uzantisini de isler', () => {
    expect(viewModelPathFor('src/views/Todo.jsx')).toBe('src/viewmodels/useTodo.ts');
  });

  it('ic ice klasorde kokten tureter', () => {
    expect(viewModelPathFor('app/web/pages/Home.tsx')).toBe('app/web/viewmodels/useHome.ts');
  });
});

describe('correctiveTaskDescription', () => {
  const input = {
    summary: 'View katmanında durum var',
    viewPath: 'src/components/Counter.tsx',
    viewModelPath: 'src/viewmodels/useCounter.ts',
    evidenceRefs: ['file:src/components/Counter.tsx:4'],
  };

  // ASIL KUSUR: görev worker'ın OKUYAMAYACAĞI docs/09'a atıf yapıyordu ve
  // worker "MVVM düzenini bana söyler misiniz?" diye sorup takıldı.
  it('standardi tanimin icine yazar, dokumana atif yapmaz', () => {
    const text = correctiveTaskDescription(input);
    expect(text).toContain('useState');
    expect(text).toContain('src/viewmodels/');
    expect(text).not.toContain('docs/09');
  });

  it('hangi dosyanin yazilacagini acikca soyler', () => {
    const text = correctiveTaskDescription(input);
    expect(text).toContain('src/viewmodels/useCounter.ts');
    expect(text).toContain('src/components/Counter.tsx');
  });

  it('kaniti tasir', () => {
    expect(correctiveTaskDescription(input)).toContain('file:src/components/Counter.tsx:4');
  });
});

describe('correctiveTargetFiles', () => {
  // ASIL KUSUR: hedefler yalnızca ihlalli dosyaydı; mantığı taşımak İKİNCİ
  // dosyayı yazmayı gerektirir ve executor mühürlü hedef dışına yazdırmaz.
  // Yani düzeltme görevi fiilen imkânsızdı.
  it('view ve viewmodel dosyalarinin ikisini de hedefler', () => {
    expect(correctiveTargetFiles('src/components/Counter.tsx'))
      .toEqual(['src/components/Counter.tsx', 'src/viewmodels/useCounter.ts']);
  });

  // TUZAK: düzeltme metni ve hedefleri tamamen STD-001'e (View → ViewModel)
  // göre yazılmıştı. Yeni katman kurallarını körlemesine buraya beslemek,
  // "src/viewmodels/useUseThing.ts oluştur" gibi SAÇMA bir görev üretirdi —
  // worker onu ya yapamaz ya da yanlış dosya yaratır.
  describe('kural farkindaligi', () => {
    it('STD-002 icin viewmodelin KENDISI hedeftir', () => {
      expect(correctiveTargetFilesFor('STD-002', 'src/viewmodels/useThing.ts'))
        .toEqual(['src/viewmodels/useThing.ts']);
    });

    it('STD-003 icin servisin KENDISI hedeftir', () => {
      expect(correctiveTargetFilesFor('STD-003', 'src/services/projects.ts'))
        .toEqual(['src/services/projects.ts']);
    });

    it('STD-001 icin View + ViewModel hedefi korunur', () => {
      expect(correctiveTargetFilesFor('STD-001', 'src/components/Counter.tsx'))
        .toEqual(['src/components/Counter.tsx', 'src/viewmodels/useCounter.ts']);
    });

    it('STD-002 tanimi DOM erisimini Viewa tasimayi anlatir', () => {
      const text = correctiveDescriptionFor({
        ruleId: 'STD-002',
        summary: 'ViewModel DOM’a dokunuyor',
        filePath: 'src/viewmodels/useThing.ts',
        evidenceRefs: ['file:src/viewmodels/useThing.ts:3'],
      });
      expect(text).toContain('DOM');
      // ViewModel oluşturma talimatı BURADA yanlış olurdu.
      expect(text).not.toContain('dosyasını oluştur');
    });

    it('STD-003 tanimi React importunu kaldirmayi anlatir', () => {
      const text = correctiveDescriptionFor({
        ruleId: 'STD-003',
        summary: 'Servis React import ediyor',
        filePath: 'src/services/projects.ts',
        evidenceRefs: ['file:src/services/projects.ts:1'],
      });
      expect(text).toContain('React');
      expect(text).toContain('src/services/projects.ts');
    });
  });
});
