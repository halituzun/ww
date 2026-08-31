// Verifier'ın araç çağrılarından TEK verdiktin seçilmesi.
//
// NEDEN VAR: model pratikte submit_verdict'i birden çok kez çağırabiliyor.
// "tam olarak bir çağrı" kuralı bunu doğrudan hata sayıyordu ve doğrulama
// adımı yaygın bir model alışkanlığı yüzünden hiç tamamlanamıyordu.
//
// Ama BELİRSİZLİK sessizce çözülmez: farklı içerikli iki verdikt hangisinin
// geçerli olduğunu söylemez ve birini seçmek uydurma olur. Kural şudur:
// aynı içerikli tekrarlar hoş görülür, farklı içerikler reddedilir.
export interface VerdictToolCallLike {
  readonly name: string;
  readonly args: unknown;
}

export function selectVerdictCall(
  calls: readonly VerdictToolCallLike[],
): VerdictToolCallLike {
  const verdicts = calls.filter((call) => call.name === 'submit_verdict');
  if (verdicts.length === 0) {
    throw new Error('verifier submit_verdict çağırmadı');
  }
  if (calls.length !== verdicts.length) {
    // Verifier salt-okumadır; başka araç çağırması sözleşme ihlalidir.
    throw new Error('verifier yalnız submit_verdict çağırabilir');
  }

  const first = verdicts[0]!;
  const canonical = JSON.stringify(first.args);
  for (const call of verdicts.slice(1)) {
    if (JSON.stringify(call.args) !== canonical) {
      throw new Error('verifier çelişkili birden çok verdikt gönderdi');
    }
  }
  return first;
}
