import { runTerritoryControllerCreep } from '../territory/territoryRunner';
import { runRecommendedExpansionClaimExecutor } from '../territory/claimExecutor';
import { runReservationExecutor } from '../territory/reservationExecutor';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export function runClaimer(creep: Creep, telemetryEvents: RuntimeTelemetryEvent[] = []): void {
  if (runRecommendedExpansionClaimExecutor(creep, telemetryEvents)) {
    return;
  }

  if (runReservationExecutor(creep)) {
    return;
  }

  runTerritoryControllerCreep(creep, telemetryEvents);
}
