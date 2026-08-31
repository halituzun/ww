// Bekleyen agent soruları — SALT GÖRÜNÜM (docs/08 → "bekleyen kullanıcı-onayı
// soruları kutusu"; kullanıcı PM'i beklemeden soruyu görüp cevaplayabilir).
import { messageKindLabel } from '../services/labels.js';
import { usePendingQuestionsViewModel } from '../viewmodels/usePendingQuestionsViewModel.js';

export function PendingQuestions({ projectId }: { readonly projectId: string }) {
  const { questions, error, busy, draftFor, setDraft, answer, confirmedFor } =
    usePendingQuestionsViewModel(projectId);

  return (
    <section className="questions" aria-label="Bekleyen sorular">
      <div className="section-heading">
        <h3>Bekleyen sorular</h3>
        <small>Agent’lar bir şey sorduğunda burada görünür ve buradan cevaplanır</small>
      </div>

      {error !== '' ? <p className="questions__error">{error}</p> : null}

      {questions.length === 0 ? (
        <p className="hint">Bekleyen soru yok.</p>
      ) : (
        <ul className="questions__list">
          {questions.map((question) => (
            <li key={question.messageId}>
              <div className="questions__head">
                <span className="pill">{messageKindLabel(question.kind)}</span>
                {question.taskId === undefined
                  ? null
                  : <code>{question.taskId.slice(0, 8)}</code>}
                <time>{new Date(question.createdAt).toLocaleString()}</time>
              </div>
              <p className="questions__text">{question.payload?.text ?? '(metin yok)'}</p>
              {/* Kaydedilmiş cevap OKUNARAK gösterilir: "gönderdim" demek
                  yetmez, bu oturumda cevapların hiçbir yere ulaşmadığı bir
                  kusur vardı. */}
              {confirmedFor(question.messageId) === undefined ? null : (
                <p className="questions__confirmed">
                  Kaydedilen cevap: {confirmedFor(question.messageId)}
                </p>
              )}
              <div className="questions__answer">
                <input
                  aria-label={`Cevap ${question.messageId}`}
                  placeholder="Cevabınız"
                  value={draftFor(question.messageId)}
                  onChange={(event) => setDraft(question.messageId, event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void answer(question.messageId)}
                >
                  Cevapla
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
