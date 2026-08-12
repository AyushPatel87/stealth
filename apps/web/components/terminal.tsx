'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { OpportunityRow, ScanResult, StrategyTab } from '@/lib/scan-service';
import { DetailRail } from './detail-rail';

const TABS: ReadonlyArray<{ key: StrategyTab; label: string }> = [
  { key: 'CSP', label: 'CSP' },
  { key: 'CC', label: 'CC' },
  { key: 'PCS', label: 'PCS' },
  { key: 'CCS', label: 'CCS' },
];

type SortKey =
  | 'score'
  | 'dte'
  | 'delta'
  | 'premium'
  | 'distanceOtmPct'
  | 'annualizedYield'
  | 'probability'
  | 'openInterest';

const COLUMNS: ReadonlyArray<{
  key: SortKey | 'symbol' | 'label' | 'expiration';
  label: string;
  sortable: boolean;
}> = [
  { key: 'symbol', label: 'Ticker', sortable: false },
  { key: 'label', label: 'Contract', sortable: false },
  { key: 'expiration', label: 'Expiry', sortable: false },
  { key: 'dte', label: 'DTE', sortable: true },
  { key: 'score', label: 'Score', sortable: true },
  { key: 'delta', label: 'Delta', sortable: true },
  { key: 'premium', label: 'Credit', sortable: true },
  { key: 'distanceOtmPct', label: 'OTM %', sortable: true },
  { key: 'annualizedYield', label: 'Ann. Yld', sortable: true },
  { key: 'probability', label: 'Prob', sortable: true },
  { key: 'openInterest', label: 'OI', sortable: true },
];

export function scoreTone(score: number): string {
  if (score >= 75) return 'good';
  if (score >= 55) return 'warn';
  return 'bad';
}

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

export function Terminal({
  result,
  strategy,
}: {
  result: ScanResult;
  strategy: StrategyTab;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    result.rows[0]?.id ?? null,
  );
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [descending, setDescending] = useState(true);
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const filtered =
      query.trim() === ''
        ? result.rows
        : result.rows.filter((r) =>
            r.symbol.toLowerCase().includes(query.trim().toLowerCase()),
          );

    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = av === null ? Number.NEGATIVE_INFINITY : av;
      const bn = bv === null ? Number.NEGATIVE_INFINITY : bv;
      return descending ? bn - an : an - bn;
    });
  }, [result.rows, sortKey, descending, query]);

  const selected =
    rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const regimeTone =
    result.regime.label === 'bullish'
      ? 'good'
      : result.regime.label === 'bearish'
        ? 'bad'
        : 'warn';

  return (
    <div className="shell">
      <header className="brandbar">
        <span className="wordmark">
          Stealth <span>/ options intelligence</span>
        </span>
        <span className="muted num" style={{ fontSize: 11 }}>
          {new Date(result.generatedAt).toISOString().replace('T', ' ').slice(0, 19)}Z
        </span>
      </header>

      <div className="tape">
        <div className="tape-cell tape-regime">
          <span className="tape-label">Market regime</span>
          <span className={`regime-chip ${regimeTone}`}>
            {result.regime.label.toUpperCase().replace('-', ' ')}
            <span className="dim" style={{ marginLeft: 10, fontWeight: 400 }}>
              {result.regime.score.toFixed(0)}
            </span>
          </span>
        </div>
        {result.marketTape.map((entry) => (
          <div className="tape-cell" key={entry.label}>
            <span className="tape-label">{entry.label}</span>
            <span className={`tape-value ${entry.tone === 'neutral' ? '' : entry.tone}`}>
              {entry.value}
            </span>
          </div>
        ))}
        <div className="tape-cell" style={{ flex: 1, minWidth: 220 }}>
          <span className="tape-label">Regime conditions</span>
          <span className="muted" style={{ fontSize: 11 }}>
            {result.regime.components.filter((c) => c.passed).length}/
            {result.regime.components.length} passed
            {result.regime.volatilityOverride ? ' · volatility override' : ''}
          </span>
        </div>
      </div>

      <div className="workspace">
        <div className="main">
          <nav className="tabs">
            {TABS.map((tab) => (
              <Link
                key={tab.key}
                href={`/?strategy=${tab.key}`}
                className="tab"
                data-active={tab.key === strategy}
                style={{ textDecoration: 'none' }}
              >
                {tab.label}
                {tab.key === strategy ? (
                  <span className="tab-count">{result.rows.length}</span>
                ) : null}
              </Link>
            ))}
          </nav>

          {result.mode === 'sample' ? (
            <p className="notice notice-warn">
              SAMPLE DATA — contracts are priced by this application&rsquo;s own model,
              not observed in a market. The live provider path is not reachable from
              this environment.
            </p>
          ) : null}

          {result.error !== null ? (
            <p className="notice notice-bad">{result.error}</p>
          ) : null}

          <div className="scanbar">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter ticker…"
              aria-label="Filter by ticker"
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                color: 'var(--text-0)',
                font: 'inherit',
                padding: '3px 8px',
                width: 150,
              }}
            />
            <span>
              {result.examined.toLocaleString()} evaluated · {rows.length} shown
            </span>
            <span className="dim">
              {Object.entries(result.rejections)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([reason, count]) => `${count} ${reason}`)
                .join('  ·  ')}
            </span>
          </div>

          <div className="tablewrap">
            {rows.length === 0 ? (
              <div className="empty">
                No opportunities passed the current filters.
                <br />
                <span className="dim">
                  Every candidate was rejected — see the counts above for why.
                </span>
              </div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    {COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        data-sorted={col.sortable && col.key === sortKey}
                        onClick={() => {
                          if (!col.sortable) return;
                          const key = col.key as SortKey;
                          if (key === sortKey) setDescending((d) => !d);
                          else {
                            setSortKey(key);
                            setDescending(true);
                          }
                        }}
                      >
                        {col.label}
                        {col.sortable && col.key === sortKey
                          ? descending
                            ? ' ▼'
                            : ' ▲'
                          : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      data-selected={selected?.id === row.id}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <td className="ticker">{row.symbol}</td>
                      <td className="muted">{row.label}</td>
                      <td className="muted">{row.expiration.slice(5)}</td>
                      <td>{row.dte}</td>
                      <td className={`score ${scoreTone(row.score)}`}>
                        {row.score.toFixed(0)}
                      </td>
                      <td>{row.delta.toFixed(3)}</td>
                      <td>{row.premium.toFixed(2)}</td>
                      <td>{pct(row.distanceOtmPct)}</td>
                      <td className={row.annualizedYield === null ? 'dim' : 'good'}>
                        {pct(row.annualizedYield, 0)}
                      </td>
                      <td>{pct(row.probability, 0)}</td>
                      <td className="muted">
                        {row.openInterest === null
                          ? '—'
                          : row.openInterest.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="detail">
          <DetailRail row={selected} />
        </aside>
      </div>
    </div>
  );
}

export type { OpportunityRow };
