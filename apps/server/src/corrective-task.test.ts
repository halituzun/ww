import { describe, expect, it } from 'vitest';
import {
  correctiveTargetFiles,
  correctiveTaskDescription,
  viewModelPathFor,
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
});
