// Düşmüş bir komut etkisi yeniden denenebilir mi?
//
// NEDEN VAR: kurtarma, süreç ölürken yarıda kalan atama komutlarını 'failed'
// yazarak uzlaştırıyor (yoksa görev "uzlastirilmamis" ile kalıcı olarak
// atanamaz kalıyordu). Ama atama komutunun kimliği göreve/denemeye göre
// DETERMİNİSTİKTİR: yeni deneme aynı kimlikle gelir, terminal 'failed' satırı
// bulur ve "assignment command terminal: failed" ile yine kalıcı olarak
// reddedilir. Yani uzlaştırma, blokajı bir adım öteye taşımaktan ibaret kalır.
//
// Doğru anlambilim replay-safety'de yazılı: `replay_safe` bir komut yeniden
// çalıştırılabilir, dolayısıyla DÜŞMÜŞ bir denemesi yeni denemeyi engellememeli.
// `non_replay_safe` olan ise engellemelidir — onu sessizce tekrar çalıştırmak
// yan etkiyi iki kez uygulama riskidir ve bu sınıf her zaman tırmandırılır.

export interface CommandEffectState {
  readonly state: string;
  readonly replay_safety: string;
}

export function isRetryableFailedCommand(row: CommandEffectState): boolean {
  return row.state === 'failed' && row.replay_safety === 'replay_safe';
}
