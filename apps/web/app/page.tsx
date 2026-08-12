import { runScan, type StrategyTab } from '@/lib/scan-service';
import { Terminal } from '@/components/terminal';

const TABS: readonly StrategyTab[] = ['CSP', 'CC', 'PCS', 'CCS'];

function isTab(value: string | undefined): value is StrategyTab {
  return value !== undefined && (TABS as readonly string[]).includes(value);
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string }>;
}) {
  const params = await searchParams;
  const strategy: StrategyTab = isTab(params.strategy) ? params.strategy : 'CSP';

  // The scan runs on the SERVER. The browser receives finished, ranked
  // opportunities and never calls a provider or computes a financial metric.
  const result = await runScan(strategy);

  return <Terminal result={result} strategy={strategy} />;
}
