import { describe, expect, it } from 'vitest';
import { effectiveRoutingChain } from './routing-chain.js';

describe('effectiveRoutingChain', () => {
  // ASIL KUSUR: yapılandırılmış rolde zincir boş görünüyordu; kullanıcı
  // "hiçbir model çalışmayacak" diye okuyordu.
  it('birincil modeli zincirin başına koyar', () => {
    expect(effectiveRoutingChain('deepseek:chat', [])).toEqual(['deepseek:chat']);
  });

  it('yedekleri sırayla ekler', () => {
    expect(effectiveRoutingChain('a:1', ['b:1', 'c:1'])).toEqual(['a:1', 'b:1', 'c:1']);
  });

  // Yinelenen kayıt zinciri olduğundan uzun gösterir.
  it('birincil yedekler arasında da geçiyorsa tekrarlamaz', () => {
    expect(effectiveRoutingChain('a:1', ['a:1', 'b:1'])).toEqual(['a:1', 'b:1']);
  });

  it('yedeklerdeki tekrarları eler', () => {
    expect(effectiveRoutingChain('a:1', ['b:1', 'b:1'])).toEqual(['a:1', 'b:1']);
  });

  // Yapılandırılmamış rol için zincir gerçekten boştur.
  it('model yoksa boş zincir döner', () => {
    expect(effectiveRoutingChain('', ['b:1'])).toEqual([]);
    expect(effectiveRoutingChain('   ', ['b:1'])).toEqual([]);
  });
});
