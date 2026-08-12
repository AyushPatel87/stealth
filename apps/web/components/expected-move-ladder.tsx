'use client';

import type { LadderLevel } from '@/lib/scan-service';

/**
 * Strike positioning against the expected move.
 *
 * Hand-drawn SVG rather than a charting library, because the point is not a
 * generic chart: it is a single vertical price axis with four or five annotated
 * levels, and the reader must grasp "where does this trade sit relative to how
 * far the stock is likely to move" without reading any numbers. A library chart
 * would add axes, gridlines and tooltips that all work against that.
 *
 * The expected-move band is drawn as a filled region so the eye registers the
 * strike as inside or outside it immediately.
 */
export function ExpectedMoveLadder({
  levels,
}: {
  levels: readonly LadderLevel[];
}) {
  if (levels.length === 0) return null;

  const prices = levels.map((l) => l.price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const span = max - min || 1;
  // Pad so the outermost labels are not flush against the edge.
  const padding = span * 0.12;
  const top = max + padding;
  const bottom = min - padding;

  const height = 168;
  const width = 380;
  const axisX = 96;

  const y = (price: number) =>
    ((top - price) / (top - bottom)) * (height - 16) + 8;

  const band = levels.filter((l) => l.kind === 'band');
  const bandTop = band.length === 2 ? y(Math.max(band[0]!.price, band[1]!.price)) : null;
  const bandBottom =
    band.length === 2 ? y(Math.min(band[0]!.price, band[1]!.price)) : null;

  const colorFor = (kind: LadderLevel['kind']): string => {
    switch (kind) {
      case 'spot':
        return 'var(--text-0)';
      case 'strike':
        return 'var(--accent)';
      case 'breakeven':
        return 'var(--good)';
      default:
        return 'var(--text-3)';
    }
  };

  /*
   * Label de-collision.
   *
   * Break-even sits within a few cents of the short strike on most credit
   * trades, so at this scale their labels land on the same pixel row and
   * overprint each other. The RULES stay at their true price - moving those
   * would misrepresent the data - and only the text is nudged apart.
   */
  const MIN_LABEL_GAP = 12;
  const ordered = levels
    .map((level, index) => ({ level, index, lineY: y(level.price) }))
    .sort((a, b) => a.lineY - b.lineY);

  const labelY = new Map<number, number>();
  let lastY = Number.NEGATIVE_INFINITY;
  for (const entry of ordered) {
    const nudged = Math.max(entry.lineY, lastY + MIN_LABEL_GAP);
    labelY.set(entry.index, nudged);
    lastY = nudged;
  }

  // If nudging pushed labels past the bottom, shift the whole stack up.
  const overflow = lastY - (height - 6);
  if (overflow > 0) {
    for (const [key, value] of labelY) labelY.set(key, value - overflow);
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="Strike position relative to the expected move"
    >
      {bandTop !== null && bandBottom !== null ? (
        <rect
          x={axisX - 30}
          y={bandTop}
          width={width - axisX - 6}
          height={Math.max(1, bandBottom - bandTop)}
          fill="var(--bg-3)"
        />
      ) : null}

      <line
        x1={axisX}
        y1={8}
        x2={axisX}
        y2={height - 8}
        stroke="var(--line-strong)"
        strokeWidth={1}
      />

      {levels.map((level, index) => {
        const ly = y(level.price);
        const ty = labelY.get(index) ?? ly;
        const color = colorFor(level.kind);
        const emphasised = level.kind === 'spot' || level.kind === 'strike';

        return (
          <g key={`${level.kind}-${level.label}`}>
            <line
              x1={axisX - 30}
              y1={ly}
              x2={width - 6}
              y2={ly}
              stroke={color}
              strokeWidth={emphasised ? 1 : 0.5}
              strokeDasharray={emphasised ? undefined : '2 3'}
              opacity={emphasised ? 0.9 : 0.5}
            />
            {/* Leader from the true rule to a nudged label, so a displaced
                label still reads as belonging to its own price. */}
            {Math.abs(ty - ly) > 1.5 ? (
              <line
                x1={axisX - 30}
                y1={ly}
                x2={axisX - 33}
                y2={ty}
                stroke={color}
                strokeWidth={0.5}
                opacity={0.45}
              />
            ) : null}
            <text
              x={axisX - 36}
              y={ty + 3.5}
              textAnchor="end"
              fill={color}
              fontFamily="var(--mono)"
              fontSize={11}
              fontWeight={emphasised ? 700 : 400}
            >
              {level.price.toFixed(2)}
            </text>
            {level.kind === 'spot' ? (
              <circle cx={axisX} cy={ly} r={3.5} fill={color} />
            ) : level.kind === 'strike' ? (
              <rect
                x={axisX - 3.5}
                y={ly - 3.5}
                width={7}
                height={7}
                fill={color}
                transform={`rotate(45 ${axisX} ${ly})`}
              />
            ) : null}
            <text
              x={axisX + 12}
              y={ty + 3.5}
              fill={color}
              fontFamily="var(--sans)"
              fontSize={10}
              opacity={emphasised ? 1 : 0.75}
            >
              {level.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
