import { describe, expect, it } from 'vitest';
import {
  OrgPlanParseError,
  orgPlanFromSynthesis,
  parseDepartmentsFromMarkdown,
} from './org-plan-parse.js';

const synthesis = `BULGU 1: bir sey
KARAR: KABUL

## DEPARTMANLAR

### DEPARTMAN dept-api — Servis Katmani
GRUP: coding
DOSYALAR: src/api/**, src/services/**
YAPAN: 2
DENETLEYEN: 1
GEREKÇE: HTTP uclari ve is kurallari

### DEPARTMAN dept-veri — Veri Katmani
GRUP: db
DOSYALAR: src/db/**
YAPAN: 1
DENETLEYEN: 1
GEREKÇE: sema ve migration

### DEPARTMAN dept-ui — Arayuz
GRUP: design
DOSYALAR: src/views/**
GEREKÇE: kullanici etkilesimleri

## GÖREVLER
### GÖREV g1 — bir sey
`;

describe('konsey sentezinden org planı', () => {
  it('departmanları, gruplarını ve sorumluluk desenlerini okur', () => {
    const departments = parseDepartmentsFromMarkdown(synthesis);
    expect(departments).toHaveLength(3);
    expect(departments[0]?.id).toBe('dept-api');
    expect(departments[0]?.group).toBe('coding');
    expect(departments[0]?.responsibility_patterns).toEqual(['src/api/**', 'src/services/**']);
    expect(departments[1]?.group).toBe('db');
  });

  it('üye sayılarını okur, verilmeyeni bire düşürür', () => {
    const departments = parseDepartmentsFromMarkdown(synthesis);
    expect(departments[0]?.members.find((m) => m.role === 'worker')?.count).toBe(2);
    // dept-ui YAPAN/DENETLEYEN vermiyor: varsayılan bir.
    expect(departments[2]?.members.find((m) => m.role === 'worker')?.count).toBe(1);
  });

  it('sonraki ## bölümüne taşmaz', () => {
    expect(parseDepartmentsFromMarkdown(synthesis).map((d) => d.id))
      .toEqual(['dept-api', 'dept-veri', 'dept-ui']);
  });

  it('sorumluluk deseni olmayan departmanı sessizce kabul etmez', () => {
    expect(() => parseDepartmentsFromMarkdown(
      '## DEPARTMANLAR\n\n### DEPARTMAN d1 — Ad\nGRUP: coding\n',
    )).toThrow(OrgPlanParseError);
  });

  it('bölüm yoksa org planı üretmez (sabit şablona DÜŞMEZ)', () => {
    // Düzeltilen kusurun mühürü: eskiden metin ne derse desin sabit
    // kelime listesinden iki şablondan biri seçiliyordu.
    expect(orgPlanFromSynthesis('## Sentez\n\nBULGU 1: ...')).toBeUndefined();
  });

  it('org planını sentezden kurar ve uydurma bütçe yazmaz', () => {
    const plan = orgPlanFromSynthesis(synthesis);
    expect(plan?.departments).toHaveLength(3);
    expect(plan?.concurrency_limit).toBe(3);
    // Elimizde gerçek bir tahmin yok; sıfır "hesaplanmadı" demektir.
    // Eskiden sabit 18000 token / $0.045 yazılıp panelde gerçek tahmin gibi
    // gösteriliyordu.
    expect(plan?.estimated_tokens).toBe(0);
    expect(plan?.estimated_cost_usd).toBe(0);
    // Üç departman ve üstü anlatıcı rolünü hak eder.
    expect(plan?.non_department_roles.some((r) => r.role === 'narrator')).toBe(true);
  });

  it('iki departmanlı planda anlatıcı rolü açmaz', () => {
    const small = orgPlanFromSynthesis(
      '## DEPARTMANLAR\n\n### DEPARTMAN a — A\nGRUP: coding\nDOSYALAR: src/**\n\n### DEPARTMAN b — B\nGRUP: design\nDOSYALAR: src/views/**\n',
    );
    expect(small?.departments).toHaveLength(2);
    expect(small?.non_department_roles.some((r) => r.role === 'narrator')).toBe(false);
  });
});
