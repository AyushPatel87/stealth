'use client';

import type { OpportunityRow } from '@/lib/scan-service';
import { scoreTone } from './terminal';
import { ExpectedMoveLadder } from './expected-move-ladder';

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

export function DetailRail({ row }: { row: OpportunityRow | null }) {
  if (row === null) {
    return (
      <div className="empty">
        Select an opportunity
        <br />
        <span className="dim">Its full score breakdown appears here.</span>
      </div>
    );
  }

  const tone = scoreTone(row.score);

  return (
    <div>
      <div className="detail-head">
        <div className="detail-title">
          <span className="ticker">{row.symbol}</span>{' '}
          <span className="muted">{row.label}</span>
        </div>
        <div className="detail-sub">
          {row.expiration} · {row.dte} DTE · {row.strategy} · $
          {row.collateral.toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
          at risk
        </div>
      </div>

      <div className="section">
        <div className="section-label">Score</div>
        <div className="bigscore">
          <b className={tone}>{row.score.toFixed(0)}</b>
          <span className="dim">/ 100</span>
        </div>

        <div style={{ marginTop: 14 }}>
          {row.breakdown.components.map((component) => (
            <div className="component" key={component.key}>
              <div>
                <div className="component-name">{component.label}</div>
                <div className="meter">
                  <i
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(100, (component.earned / component.weight) * 100),
                      )}%`,
                    }}
                  />
                </div>
                <div className="component-detail">{component.detail}</div>
              </div>
              <div className="component-value">
                {component.earned.toFixed(1)}
                <span className="dim"> / {component.weight.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>

        {row.breakdown.unavailable.length > 0 ? (
          <p className="dim" style={{ fontSize: 10, marginTop: 8 }}>
            Weight redistributed from unavailable components:{' '}
            {row.breakdown.unavailable.join(', ')}
          </p>
        ) : null}
      </div>

      {(row.breakdown.positiveFactors.length > 0 ||
        row.breakdown.negativeFactors.length > 0) && (
        <div className="section">
          <div className="section-label">Factors</div>
          {row.breakdown.positiveFactors.map((factor) => (
            <div className="factor" key={factor}>
              <span className="factor-mark good">✓</span>
              <span>{factor}</span>
            </div>
          ))}
          {row.breakdown.negativeFactors.map((factor) => (
            <div className="factor" key={factor}>
              <span className="factor-mark warn">⚠</span>
              <span className="muted">{factor}</span>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <div className="section-label">Position vs expected move</div>
        <ExpectedMoveLadder levels={row.ladder} />
      </div>

      <div className="section">
        <div className="section-label">Metrics</div>
        <MetricRow label="Delta" value={row.delta.toFixed(3)} />
        <MetricRow label="Credit" value={`$${row.premium.toFixed(2)}`} />
        <MetricRow label="Distance OTM" value={pct(row.distanceOtmPct)} />
        <MetricRow
          label="Annualised yield"
          value={pct(row.annualizedYield, 1)}
          tone={row.annualizedYield === null ? undefined : 'good'}
        />
        <MetricRow label="Probability" value={pct(row.probability, 0)} />
        <MetricRow
          label="Bid/ask spread"
          value={pct(row.spreadPct, 1)}
          tone={
            row.spreadPct !== null && row.spreadPct > 0.08 ? 'warn' : undefined
          }
        />
        <MetricRow
          label="Open interest"
          value={row.openInterest === null ? '—' : row.openInterest.toLocaleString()}
        />
      </div>

      {row.notes.length > 0 ? (
        <div className="section">
          <div className="section-label">Notes</div>
          {row.notes.map((note) => (
            <div className="component-detail" key={note} style={{ marginBottom: 4 }}>
              {note}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MetricRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | undefined;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '3px 0',
        borderBottom: '1px solid var(--bg-2)',
      }}
    >
      <span className="muted" style={{ fontSize: 11 }}>
        {label}
      </span>
      <span className={`num ${tone ?? ''}`} style={{ fontSize: 12 }}>
        {value}
      </span>
    </div>
  );
}
