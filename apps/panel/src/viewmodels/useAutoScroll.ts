import { useEffect, useRef, type RefObject } from "react";

/**
 * Bağımlılık değiştikçe verilen çapayı görünüme kaydırır.
 *
 * NEDEN ViewModel katmanında: yan etki (useEffect) View'da duramaz — docs/09
 * STD-001. Çapa ref'i View'a döndürülür, kaydırma kararı burada verilir.
 *
 * `scrollIntoView` jsdom'da tanımsızdır; bu yüzden çağrı korumalıdır ve
 * testler yalnız ref'in bağlanmasına bakabilir.
 */
export function useAutoScroll<T extends Element>(dependency: unknown): RefObject<T> {
  const anchorRef = useRef<T>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor !== null && typeof anchor.scrollIntoView === "function") {
      anchor.scrollIntoView({ behavior: "smooth" });
    }
  }, [dependency]);

  return anchorRef;
}
