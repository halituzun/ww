// Plan onayı girdisi (docs/03 konsey akışı, docs/08 "plana müdahale").
//
// NEDEN VAR: `PlanApprovalService` yazılmıştı ama hiçbir üretim yolu onu
// çağırmıyordu: kullanıcı planı ne onaylayabiliyor ne reddedebiliyordu.
import { z } from 'zod';

const ApprovalInput = z.strictObject({
  approved: z.boolean(),
  note: z.string().trim().max(4_000).optional(),
});

export type ApprovalInputValue = z.infer<typeof ApprovalInput>;

export const parseApprovalInput = (value: unknown): ApprovalInputValue => ApprovalInput.parse(value);
