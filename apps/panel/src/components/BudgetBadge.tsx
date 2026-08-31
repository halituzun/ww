import type { BudgetState } from "../services/budget.js";
import { formatUsd } from "../services/budget.js";

export function BudgetBadge({
  budget,
  onClick,
}: {
  readonly budget: { readonly state: BudgetState; readonly ratio: number; readonly spentUsd: number; readonly limitUsd: number };
  readonly onClick?: (() => void) | undefined;
}) {
  const isUnlimited = budget.limitUsd <= 0;
  const ratioPct = Math.min(100, Math.max(0, Math.round(budget.ratio * 100)));

  return (
    <button
      type="button"
      className="budget-badge-btn"
      onClick={onClick}
      aria-label={`Bütçe durumu: ${formatUsd(budget.spentUsd)} harcandı`}
    >
      <span className="budget-badge-text">
        {formatUsd(budget.spentUsd)}
        {isUnlimited ? (
          <span className="budget-limit-sub"> / ∞</span>
        ) : (
          <span className="budget-limit-sub"> / {formatUsd(budget.limitUsd)}</span>
        )}
      </span>

      {!isUnlimited ? (
        <span
          className="budget-badge-meter"
          role="meter"
          aria-valuenow={ratioPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="budget-badge-fill" style={{ width: `${ratioPct}%` }} />
        </span>
      ) : null}
    </button>
  );
}
