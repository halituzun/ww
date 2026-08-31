import { useState, useCallback } from "react";

/** Plan kartındaki sekmeler. View bu birlikten başka değer üretemez. */
export type PlanApprovalTab = "tasks" | "org";

export function usePlanApprovalViewModel({
  onReplan,
}: {
  readonly onReplan?: ((reason: string, summary: string) => Promise<void> | void) | undefined;
}) {
  const [showRevisionInput, setShowRevisionInput] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [revisionSummary, setRevisionSummary] = useState("");
  const [showFullContent, setShowFullContent] = useState(false);
  // docs/09: sekme seçimi de durumdur ve View'da duramaz.
  const [activeTab, setActiveTab] = useState<PlanApprovalTab>("tasks");

  const openRevision = useCallback(() => setShowRevisionInput(true), []);
  const closeRevision = useCallback(() => {
    setShowRevisionInput(false);
    setRevisionReason("");
    setRevisionSummary("");
  }, []);

  const toggleContent = useCallback(() => setShowFullContent((p) => !p), []);

  const submitRevision = useCallback(async () => {
    if (revisionReason.trim() && revisionSummary.trim()) {
      await onReplan?.(revisionReason, revisionSummary);
      closeRevision();
    }
  }, [revisionReason, revisionSummary, onReplan, closeRevision]);

  return {
    showRevisionInput,
    revisionReason,
    setRevisionReason,
    revisionSummary,
    setRevisionSummary,
    showFullContent,
    activeTab,
    setActiveTab,
    openRevision,
    closeRevision,
    toggleContent,
    submitRevision,
  };
}
