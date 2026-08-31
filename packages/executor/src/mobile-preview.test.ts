import { describe, expect, it, vi } from 'vitest';
import { AdbMobilePreviewPort, MobilePreviewService } from './mobile-preview.js';

describe('MobilePreviewService', () => {
  it('selects an AVD and exposes bounded frames/interactions', async () => {
    const port = { listAvds: vi.fn(async () => ['Pixel_8']), start: vi.fn(async () => ({ sessionId: 's1' })), screenshot: vi.fn(async () => new Uint8Array([1])), tap: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const service = new MobilePreviewService(port);
    const session = await service.open();
    expect(session.avd).toBe('Pixel_8');
    expect((await service.frame(session.sessionId)).length).toBe(1);
    await service.tap(session.sessionId, 1, 2);
  });

  it('ADB adapterı yalnız injected komut portundan çalışır ve yaşam döngüsünü kapatır', async () => {
    const calls: string[][] = [];
    let stopped = false;
    let listed = 0;
    const port = new AdbMobilePreviewPort({
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === '-list-avds') return { stdout: 'Pixel_8\n' };
        // Başlatmadan önce cihaz yok; sonra emulator-5554 belirir.
        if (args[0] === 'devices') {
          listed += 1;
          return { stdout: listed <= 1 ? 'List of devices attached\n' : 'List of devices attached\nemulator-5554\tdevice\n' };
        }
        if (args.includes('screencap')) return { stdout: '', bytes: new Uint8Array([137, 80]) };
        return { stdout: '' };
      },
      start: async () => ({ sessionId: 'surec-42', stop: async () => { stopped = true; } }),
    });
    expect(await port.listAvds()).toEqual(['Pixel_8']);
    const session = await port.start('Pixel_8');
    // Oturum kimliği artık SÜREÇ kimliği değil, gerçek adb seri numarası.
    expect(session.sessionId).toBe('emulator-5554');
    expect((await port.screenshot(session.sessionId)).length).toBe(2);
    await port.tap(session.sessionId, 10, 20);
    await port.stop(session.sessionId);
    expect(stopped).toBe(true);
    expect(calls).toContainEqual(['adb', '-s', 'emulator-5554', 'shell', 'input', 'tap', '10', '20']);
  });

  // `adb wait-for-device` BAŞKA bir cihaz bağlıyken hemen döner; yeni
  // emülatör henüz listede olmayabilir. Tek bakışta pes etmek, iki cihazlı
  // makinede başlatmayı düpedüz kırardı.
  it('yeni cihaz gecikirse listeyi tekrar yoklar', async () => {
    let listed = 0;
    const waits: number[] = [];
    const port = new AdbMobilePreviewPort({
      run: async (_c, args) => {
        if (args[0] === 'devices') {
          listed += 1;
          return listed <= 3
            ? { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\n' }
            : { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\nemulator-5554\tdevice\n' };
        }
        return { stdout: '' };
      },
      start: async () => ({ sessionId: 'surec-42', stop: async () => undefined }),
    }, { sleep: async (ms) => { waits.push(ms); } });

    expect((await port.start('Pixel_8')).sessionId).toBe('emulator-5554');
    expect(waits.length).toBeGreaterThan(0);
  });

  // GERÇEK adb'ye karşı çıkan kusur: `start()` SÜREÇ kimliğini döndürüyor,
  // sonraki her çağrı ise onu `adb -s <seri>` diye kullanıyordu. Süreç
  // kimliği bir adb seri numarası DEĞİLDİR; gerçek makinede
  // "error: device 'emu-1' not found" ile düşer. Eski test sahtesi süreç
  // kimliğini seri gibi döndürdüğü için kusuru gizliyordu.
  it('baglı cihazları adb devices ile listeler, offline olanı saymaz', async () => {
    const port = new AdbMobilePreviewPort({
      run: async (_c, args) => {
        if (args[0] === 'devices') {
          return { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\n127.0.0.1:26720\tdevice\nemulator-5556\toffline\n' };
        }
        return { stdout: '' };
      },
      start: async () => { throw new Error('süreç başlatılmamalı'); },
    });
    // offline cihaz kullanılamaz: onu listelemek paneli çalışmayan bir
    // hedefe yönlendirirdi.
    expect(await port.listDevices()).toEqual(['127.0.0.1:26624', '127.0.0.1:26720']);
  });

  it('zaten bagli cihaza baglanir, emulator BASLATMAZ', async () => {
    const calls: string[][] = [];
    const port = new AdbMobilePreviewPort({
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'devices') return { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\n' };
        if (args.includes('screencap')) return { stdout: '', bytes: new Uint8Array([137, 80]) };
        return { stdout: '' };
      },
      // emulator ikilisi kurulu olmayabilir; bağlı cihaz varken ona ihtiyaç yok.
      start: async () => { throw new Error('süreç başlatılmamalı'); },
    });

    const session = await port.start('127.0.0.1:26624');
    expect(session.sessionId).toBe('127.0.0.1:26624');
    await port.screenshot(session.sessionId);
    expect(calls).toContainEqual(['adb', '-s', '127.0.0.1:26624', 'exec-out', 'screencap', '-p']);
  });

  // Bağlanılan (bizim başlatmadığımız) cihaz DURDURULMAZ. `adb emu kill`
  // kullanıcının kendi çalıştırdığı cihazı kapatırdı.
  it('bagli cihazi durdurmaz, yalniz kendi baslattigini durdurur', async () => {
    const calls: string[][] = [];
    const port = new AdbMobilePreviewPort({
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'devices') return { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\n' };
        return { stdout: '' };
      },
      start: async () => { throw new Error('süreç başlatılmamalı'); },
    });

    const session = await port.start('127.0.0.1:26624');
    await port.stop(session.sessionId);
    expect(calls.some((call) => call.includes('kill'))).toBe(false);
  });

  it('emulator baslatinca YENI seri numarasini cozer, surec kimligini kullanmaz', async () => {
    let listed = 0;
    const calls: string[][] = [];
    const port = new AdbMobilePreviewPort({
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'devices') {
          listed += 1;
          // Başlatmadan önce tek cihaz; sonra yenisi belirir.
          return listed <= 1
            ? { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\n' }
            : { stdout: 'List of devices attached\n127.0.0.1:26624\tdevice\nemulator-5554\tdevice\n' };
        }
        return { stdout: '' };
      },
      start: async () => ({ sessionId: 'surec-42', stop: async () => undefined }),
    });

    const session = await port.start('Pixel_8');
    // Süreç kimliği DEĞİL, gerçek seri numarası.
    expect(session.sessionId).toBe('emulator-5554');
    await port.tap(session.sessionId, 10, 20);
    expect(calls).toContainEqual(['adb', '-s', 'emulator-5554', 'shell', 'input', 'tap', '10', '20']);
  });

  // Panel çalışan cihazı görmeliydi ama servis yalnız `listAvds`'a bakıyordu.
  // `emulator` ikilisi kurulu değilse o çağrı DÜŞER (komut yok) ve panel iki
  // cihaz ÇALIŞIRKEN "uygun AVD bulunamadı" diyordu.
  it('bagli cihaz varken emulator ikilisi olmasa da acilir', async () => {
    const port = {
      listAvds: vi.fn(async () => { throw new Error('spawn emulator ENOENT'); }),
      listDevices: vi.fn(async () => ['127.0.0.1:26624']),
      start: vi.fn(async (target: string) => ({ sessionId: target })),
      screenshot: vi.fn(async () => new Uint8Array([137, 80])),
      tap: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const session = await new MobilePreviewService(port).open();
    expect(session.sessionId).toBe('127.0.0.1:26624');
    expect(port.start).toHaveBeenCalledWith('127.0.0.1:26624');
  });

  // Bağlı cihaz HAZIRDIR; AVD ise açılış beklemesi ister. Cihaz varken
  // emülatör başlatmak boşuna dakikalar harcamak olurdu.
  it('bagli cihazi AVDye TERCIH eder', async () => {
    const port = {
      listAvds: vi.fn(async () => ['Pixel_8']),
      listDevices: vi.fn(async () => ['127.0.0.1:26624']),
      start: vi.fn(async (target: string) => ({ sessionId: target })),
      screenshot: vi.fn(async () => new Uint8Array([1])),
      tap: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    await new MobilePreviewService(port).open();
    expect(port.start).toHaveBeenCalledWith('127.0.0.1:26624');
  });

  it('istenen hedef acikca verilirse ona uyar', async () => {
    const port = {
      listAvds: vi.fn(async () => ['Pixel_8']),
      listDevices: vi.fn(async () => ['127.0.0.1:26624']),
      start: vi.fn(async (target: string) => ({ sessionId: target })),
      screenshot: vi.fn(async () => new Uint8Array([1])),
      tap: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    await new MobilePreviewService(port).open('Pixel_8');
    expect(port.start).toHaveBeenCalledWith('Pixel_8');
  });

  it('ne cihaz ne AVD varsa acik hata verir', async () => {
    const port = {
      listAvds: vi.fn(async () => []),
      listDevices: vi.fn(async () => []),
      start: vi.fn(async () => ({ sessionId: 'x' })),
      screenshot: vi.fn(async () => new Uint8Array([1])),
      tap: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    await expect(new MobilePreviewService(port).open()).rejects.toThrow(/bulunamadi/);
  });
});
