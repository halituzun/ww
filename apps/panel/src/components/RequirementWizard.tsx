// Gereksinim sihirbazı — SALT GÖRÜNÜM (docs/09 MVVM; docs/08 yeni proje
// sihirbazı).
//
// NEDEN VAR: panel projeyi doğrudan oluşturuyor, gereksinimleri hiç
// sormuyordu. Gereksinimsiz proje, konseyin ve worker'ların tahmin üzerine
// çalışması demektir.
import { useInterviewViewModel } from '../viewmodels/useInterviewViewModel.js';

export function RequirementWizard({ projectId }: { readonly projectId: string }) {
  const { questions, saved, error, busy, answerFor, setAnswer, submit } =
    useInterviewViewModel(projectId);

  if (projectId === '') {
    return <p className="hint">Gereksinim toplamak için önce bir proje seçin.</p>;
  }

  return (
    <section className="wizard" aria-label="Gereksinim sihirbazı">
      <div className="section-heading">
        <h3>Gereksinimler</h3>
        <small>Cevaplar projenin kalıcı belleğine yazılır</small>
      </div>

      {error !== '' ? <p className="wizard__error">{error}</p> : null}
      {/* Kaydedildiği söylenmezse kullanıcı aynı cevapları tekrar yazar. */}
      {saved ? <p className="hint">Gereksinimler kaydedildi.</p> : null}

      {questions.length === 0 ? <p className="hint">Soru yok.</p> : (
        <ul className="wizard__list">
          {questions.map((question) => (
            <li key={question.id}>
              <label>
                {question.prompt}{question.required ? ' *' : ''}
                <input
                  aria-label={question.prompt}
                  value={answerFor(question.id)}
                  onChange={(event) => setAnswer(question.id, event.target.value)}
                />
              </label>
            </li>
          ))}
        </ul>
      )}

      <button type="button" disabled={busy || questions.length === 0} onClick={() => void submit()}>
        Gereksinimleri kaydet
      </button>
    </section>
  );
}
