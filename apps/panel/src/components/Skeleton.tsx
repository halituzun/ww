export function Skeleton({
  height = "20px",
  width = "100%",
  borderRadius = "6px",
  className = "",
}: {
  readonly height?: string;
  readonly width?: string;
  readonly borderRadius?: string;
  readonly className?: string;
}) {
  return (
    <div
      className={`skeleton-loader ${className}`}
      style={{ height, width, borderRadius }}
      aria-hidden="true"
    />
  );
}
