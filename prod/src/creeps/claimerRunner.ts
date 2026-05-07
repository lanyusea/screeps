import { runTerritoryControllerCreep } from '../territory/territoryRunner';
import { runExpansionExecutorClaimer } from '../territory/expansionExecutor';
import { runReservationExecutor } from '../territory/reservationExecutor';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export function runClaimer(creep: Creep, telemetryEvents: RuntimeTelemetryEvent[] = []): void {
  if (runExpansionExecutorClaimer(creep, telemetryEvents)) {
    return;
  }

  if (runReservationExecutor(creep)) {
    return;
  }

  runTerritoryControllerCreep(creep, telemetryEvents);
}
