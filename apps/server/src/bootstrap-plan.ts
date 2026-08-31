// Yeni projenin temel planı.
//
// NEDEN VAR: proje oluşturma prompt ve agent tohumluyor ama PLAN tohumlamıyordu.
// Atama görevin plan kimliğini ister; plansız proje açıldığında panelden açılan
// her görev "task plan kimligi tasimiyor" ile reddediliyor ve kullanıcıya
// "queued" görünürken hiç çalışmıyordu.
//
// Bu plan bir konsey çıktısı DEĞİLDİR ve öyleymiş gibi de sunulmaz: başlığı ve
// içeriği, gerçek planlama yapılana kadar geçerli olan temel plan olduğunu
// açıkça söyler. Konsey planı geldiğinde onu `supersedes_plan_id` ile devralır.
import { NIL_UUID, type EntityId } from '@ww/shared';

export interface BootstrapPlanInput {
  readonly projectId: EntityId;
  readonly projectName: string;
  readonly planId: EntityId;
  readonly createdByAgentId: EntityId;
  readonly createdAt: string;
}

export function buildBootstrapPlan(input: BootstrapPlanInput) {
  return {
    plan_id: input.planId,
    project_id: input.projectId,
    plan_version: 1,
    // Görevler ancak onaylı/önerilmiş plana bağlanabilir; 'proposed' bırakmak
    // projeyi yine çalışmaz hale getirirdi.
    status: 'approved' as const,
    title: `${input.projectName} — temel plan`,
    content_md: [
      `# ${input.projectName} — temel plan`,
      '',
      'Bu, proje açılışında oluşturulan temel plandır; konsey planlaması',
      'yapılana kadar görevlerin bağlanacağı plan kaydıdır.',
      '',
      'Kapsam: kullanıcının açtığı görevler bu plan altında yürür.',
    ].join('\n'),
    council_session_id: NIL_UUID,
    team_json: { roles: ['pm', 'worker', 'verifier'] },
    scenarios_json: { scenarios: [] },
    // Bootstrap planı konsey ürünü değildir: çapraz kontrol ÖLÇÜLMEDİ.
    provider_diversity: 0,
    replan_reason: '',
    supersedes_plan_id: NIL_UUID,
    created_by_agent_id: input.createdByAgentId,
    approved_by: 'bootstrap',
    created_at: input.createdAt,
  };
}
