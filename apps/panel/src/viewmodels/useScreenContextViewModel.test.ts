// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useScreenContextViewModel } from './useScreenContextViewModel.js';

afterEach(cleanup);

describe('useScreenContextViewModel', () => {
  it('sekmeyi her zaman bildirir', () => {
    const { result } = renderHook(() => useScreenContextViewModel('files'));
    expect(result.current.contextFor()).toContain('files');
  });

  it('bildirilen onizleme URLsini baglama katar', () => {
    const { result } = renderHook(() => useScreenContextViewModel('preview'));
    act(() => { result.current.setActiveUrl('http://localhost:42001/'); });
    expect(result.current.contextFor()).toContain('42001');
  });

  it('bildirilen cihaz oturumunu baglama katar', () => {
    const { result } = renderHook(() => useScreenContextViewModel('preview'));
    act(() => { result.current.setActiveSession('s1'); });
    expect(result.current.contextFor()).toContain('s1');
  });

  // Önizleme kapanınca bağlam da TEMİZLENİR: kapalı bir ekranı emre
  // iliştirmek PM'i olmayan bir şeye bakmaya yönlendirir.
  it('onizleme kapanınca baglamdan duser', () => {
    const { result } = renderHook(() => useScreenContextViewModel('preview'));
    act(() => { result.current.setActiveUrl('http://localhost:42001/'); });
    act(() => { result.current.setActiveUrl(''); });
    expect(result.current.contextFor()).not.toContain('42001');
  });
});
