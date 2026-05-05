import { runTerritoryControllerCreep } from '../territory/territoryRunner';
import { runRecommendedExpansionClaimExecutor } from '../territory/claimExecutor';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export function runClaimer(creep: Creep, telemetryEvents: RuntimeTelemetryEvent[] = []): void {
  if (runRecommendedExpansionClaimExecutor(creep, telemetryEvents)) {
    return;
  }

  runTerritoryControllerCreep(creep, telemetryEvents);
}
