// Mobil önizlemenin çalıştırabileceği komutlar (docs/10 → emülatör).
//
// NEDEN VAR: mobil önizleme HOST komutu çalıştırır. Beyaz liste olmadan bu
// yüzey, panelden gelen bir dizeyle sunucuda rastgele komut çalıştırmaya
// dönüşür. İzin verilen tek şey emülatör ve adb'dir.
export const MOBILE_COMMANDS = ['emulator', 'adb'] as const;

export type MobileCommand = (typeof MOBILE_COMMANDS)[number];

export function assertMobileCommand(command: string): MobileCommand {
  const match = MOBILE_COMMANDS.find((allowed) => allowed === command);
  if (match === undefined) {
    throw new Error(`mobil önizleme bu komutu çalıştıramaz: ${command}`);
  }
  return match;
}

/** Argümanlar kabuk yorumundan geçmez ama yine de NUL ve kabuk metakarakteri barındıramaz. */
export function assertMobileArgs(args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (arg.includes('\0')) throw new Error('argüman NUL karakteri içeremez');
    if (/[;&|`$<>\n]/.test(arg)) throw new Error(`argüman kabuk metakarakteri içeremez: ${arg}`);
  }
  return args;
}
