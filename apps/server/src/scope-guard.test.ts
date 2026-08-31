import { describe, expect, it } from 'vitest';
import { isPathSafe, validateTaskScope } from './scope-guard.js';

describe('ScopeGuard — isPathSafe', () => {
  it('guvenli goreli yollara izin verir', () => {
    expect(isPathSafe('src/components/Button.tsx')).toBe(true);
    expect(isPathSafe('src/viewmodels/useButton.ts')).toBe(true);
    expect(isPathSafe('index.html')).toBe(true);
  });

  it('kok dizin ve .. kacislarini engeller', () => {
    expect(isPathSafe('/etc/passwd')).toBe(false);
    expect(isPathSafe('../secret.txt')).toBe(false);
    expect(isPathSafe('src/../../root.txt')).toBe(false);
  });

  it('sistem ve gizli dosyalara yazimi engeller', () => {
    expect(isPathSafe('.env')).toBe(false);
    expect(isPathSafe('.git/config')).toBe(false);
    expect(isPathSafe('node_modules/pkg/index.js')).toBe(false);
  });
});

describe('ScopeGuard — validateTaskScope', () => {
  it('izin verilen hedef dosyayi onaylar', () => {
    const res = validateTaskScope('src/components/Timer.tsx', [
      'src/components/Timer.tsx',
      'src/viewmodels/useTimer.ts',
    ]);
    expect(res.allowed).toBe(true);
  });

  it('plan kapsami disindaki dosyayi reddeder', () => {
    const res = validateTaskScope('src/services/secret.ts', [
      'src/components/Timer.tsx',
    ]);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Plan kapsamı dışı');
  });

  it('hedef listesi bosken genel guvenlik kontrolu yapar', () => {
    expect(validateTaskScope('src/app.js', []).allowed).toBe(true);
    expect(validateTaskScope('.env', []).allowed).toBe(false);
  });
});
