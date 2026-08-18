// Ekran görüntüsü üzerindeki tıklamayı CİHAZ pikseline çevirir
// (docs/11 Faz 6 → "temel etkileşim").
//
// NEDEN AYRI VE TESTLİ: görüntü panelde ölçeklenerek gösterilir. Dönüşüm
// yanlışsa dokunuş YANLIŞ YERE gider — bir şey olur, ama beklenen şey olmaz.
// Bu, sessizce yanlış çalışan ve gözle fark edilmesi zor bir hatadır.

export interface ViewRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface NaturalSize {
  readonly width: number;
  readonly height: number;
}

export interface ClickPoint {
  readonly clientX: number;
  readonly clientY: number;
}

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(Math.round(value), 0), max);

export function deviceTapPoint(
  click: ClickPoint,
  rect: ViewRect,
  natural: NaturalSize,
): { readonly x: number; readonly y: number } | undefined {
  // Görüntü henüz yüklenmediyse doğal boyut 0'dır; 0'a bölmek NaN üretir ve
  // NaN koordinat adb'de komutu sessizce düşürür.
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  if (natural.width <= 0 || natural.height <= 0) return undefined;

  const scaleX = natural.width / rect.width;
  const scaleY = natural.height / rect.height;
  return {
    // Sınır dışı KIRPILIR: ekran dışı koordinat adb'de göz ardı edilir ve
    // kullanıcı "dokunmadı" sanır.
    x: clamp((click.clientX - rect.left) * scaleX, natural.width - 1),
    y: clamp((click.clientY - rect.top) * scaleY, natural.height - 1),
  };
}
