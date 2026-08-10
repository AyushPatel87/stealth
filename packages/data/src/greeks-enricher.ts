/**
 * Fills in Greeks that a provider does not supply.
 *
 * This exists because of a verified gap: Yahoo's options response carries
 * `impliedVolatility` but no delta, gamma, theta or vega. Since a CSP scanner
 * filters primarily on delta, without this the entire Yahoo path would be
 * unusable.
 *
 * Two rules govern the result:
 *
 *  1. Vendor Greeks are never overwritten. They are computed under the
 *     vendor's own model and assumptions; silently replacing them with ours
 *     would make two providers' output incomparable in a way nothing
 *     downstream could detect.
 *
 *  2. The origin is always stamped on the contract (`greeksSource`), so the UI
 *     can distinguish a vendor delta from one we derived, and so a scan can
 *     report how much of its output rests on local modelling.
 */

import {
  blackScholes,
  impliedVolatility as solveImpliedVolatility,
  yearsToExpiry,
  premiumEstimate,
  type Greeks,
} from '@stealth/core';
import type { OptionContract } from './models.js';

export interface EnrichmentContext {
  /** Current underlying price. */
  readonly spot: number;
  /** Valuation time; drives time to expiry. */
  readonly now: Date;
  /** Annualised continuously-compounded risk-free rate as a decimal. */
  readonly riskFreeRate: number;
  /** Annualised continuous dividend yield as a decimal. */
  readonly dividendYield?: number;
  /**
   * When true, an implied volatility absent from the provider is solved from
   * the contract's mid price before Greeks are computed.
   */
  readonly deriveMissingIv?: boolean;
}

export interface EnrichmentStats {
  readonly total: number;
  readonly fromProvider: number;
  readonly computed: number;
  readonly unavailable: number;
  /** Contracts whose IV was solved from price rather than supplied. */
  readonly ivDerived: number;
}

/**
 * Returns the contract with Greeks populated where possible.
 *
 * Never throws: a scan iterating hundreds of thousands of contracts must
 * degrade one bad row to `greeksSource: 'unavailable'` rather than abort.
 */
export function enrichContract(
  contract: OptionContract,
  context: EnrichmentContext,
): OptionContract {
  // Rule 1: never overwrite vendor Greeks.
  if (contract.greeks !== null && contract.greeksSource === 'provider') {
    return contract;
  }

  const timeToExpiry = yearsToExpiry(context.now, contract.expiration);
  if (timeToExpiry <= 0 || !(context.spot > 0) || !(contract.strike > 0)) {
    return { ...contract, greeks: null, greeksSource: 'unavailable' };
  }

  let volatility = contract.impliedVolatility;
  let derivedIv = false;

  // Providers report 0 or omit IV entirely for untraded strikes.
  if ((volatility === null || volatility <= 0) && context.deriveMissingIv) {
    const estimate = premiumEstimate({
      bid: contract.bid ?? undefined,
      ask: contract.ask ?? undefined,
      last: contract.last ?? undefined,
    });

    if (estimate.mid !== null && estimate.mid > 0) {
      const solved = solveImpliedVolatility({
        price: estimate.mid,
        spot: context.spot,
        strike: contract.strike,
        timeToExpiry,
        riskFreeRate: context.riskFreeRate,
        dividendYield: context.dividendYield ?? 0,
        right: contract.right,
      });
      if (solved.ok) {
        volatility = solved.result.volatility;
        derivedIv = true;
      }
    }
  }

  if (volatility === null || volatility <= 0) {
    return { ...contract, greeks: null, greeksSource: 'unavailable' };
  }

  let greeks: Greeks;
  try {
    greeks = blackScholes({
      spot: context.spot,
      strike: contract.strike,
      timeToExpiry,
      volatility,
      riskFreeRate: context.riskFreeRate,
      dividendYield: context.dividendYield ?? 0,
      right: contract.right,
    });
  } catch {
    // Non-finite or non-positive inputs that slipped through normalisation.
    return { ...contract, greeks: null, greeksSource: 'unavailable' };
  }

  return {
    ...contract,
    impliedVolatility: derivedIv ? volatility : contract.impliedVolatility,
    greeks: {
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      rho: greeks.rho,
    },
    greeksSource: 'computed',
  };
}

/** Enriches a batch of contracts and reports how much rests on local modelling. */
export function enrichContracts(
  contracts: readonly OptionContract[],
  context: EnrichmentContext,
): { readonly contracts: readonly OptionContract[]; readonly stats: EnrichmentStats } {
  let fromProvider = 0;
  let computed = 0;
  let unavailable = 0;
  let ivDerived = 0;

  const enriched = contracts.map((contract) => {
    const hadIv = contract.impliedVolatility !== null && contract.impliedVolatility > 0;
    const result = enrichContract(contract, context);

    if (result.greeksSource === 'provider') fromProvider += 1;
    else if (result.greeksSource === 'computed') computed += 1;
    else unavailable += 1;

    if (
      !hadIv &&
      result.impliedVolatility !== null &&
      result.impliedVolatility > 0
    ) {
      ivDerived += 1;
    }

    return result;
  });

  return {
    contracts: enriched,
    stats: {
      total: contracts.length,
      fromProvider,
      computed,
      unavailable,
      ivDerived,
    },
  };
}
