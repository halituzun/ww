import { useState, useCallback } from "react";

export function usePlanApprovalViewModel({
  onReplan,
}: {
  readonly onReplan?: ((reason: string, summary: string) => Promise<void> | void) | undefined;
}) {
  const [showRevisionInput, setShowRevisionInput] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [revisionSummary, setRevisionSummary] = useState("");
  const [showFullContent, setShowFullContent] = useState(false);

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
    openRevision,
    closeRevision,
    toggleContent,
    submitRevision,
  };
}
