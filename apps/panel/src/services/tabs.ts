// Panel sekme kimlikleri (docs/08 → genel yerleşim).
//
// NEDEN SERVİSTE: hem ViewModel (durum) hem View (çizim) aynı birliği
// kullanır. Tipi bileşende bırakıp ViewModel'e import ettirmek docs/09'un
// katman YÖNÜNÜ tersine çevirirdi (ViewModel UI'ı import etmez). İki ayrı
// yerde elle tanımlamak ise zamanla ayrışır: biri yeni sekmeyi öğrenir,
// diğeri öğrenmez.
export type PanelTab = 'tasks' | 'canvas' | 'files' | 'timeline' | 'api' | 'preview';
