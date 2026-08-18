import { describe, expect, it } from 'vitest';
import { WORKSPACE_RESET_COMMANDS } from './workspace-reset.js';

describe('WORKSPACE_RESET_COMMANDS (docs/01 çökme kurtarma: "git checkout . ile temizler")', () => {
  it('izlenen dosyalari geri alir ve izlenmeyenleri siler', () => {
    const flat = WORKSPACE_RESET_COMMANDS.map((command) => command.join(' '));
    expect(flat).toContain('checkout -- .');
    expect(flat.some((command) => command.startsWith('clean -fd'))).toBe(true);
  });

  // ÇÖP KUTUSU KORUNUR. `delete_file` silinen dosyayı `.ww-trash/` altına
  // TAŞIR (geri alınabilsin diye); temizlik onu da silerse, kurtarma
  // kullanıcının geri alabileceği tek kopyayı yok eder.
  it('cop kutusunu haric tutar', () => {
    const clean = WORKSPACE_RESET_COMMANDS.find((command) => command[0] === 'clean');
    expect(clean?.join(' ')).toContain('.ww-trash');
    expect(clean?.join(' ')).toContain('-e');
  });

  // `.git` dizinine dokunulmaz: `clean -fdx` olsaydı yapılandırma ve
  // geçmiş de silinirdi. `-x` YOK.
  it('yok sayilan dosyalari silmez (-x kullanmaz)', () => {
    const clean = WORKSPACE_RESET_COMMANDS.find((command) => command[0] === 'clean');
    expect(clean?.join(' ')).not.toContain('-fdx');
  });

  it('sira onemli: once geri al, sonra temizle', () => {
    expect(WORKSPACE_RESET_COMMANDS[0]?.[0]).toBe('checkout');
    expect(WORKSPACE_RESET_COMMANDS[1]?.[0]).toBe('clean');
  });
});
