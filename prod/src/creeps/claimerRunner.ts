import { runTerritoryControllerCreep } from '../territory/territoryRunner';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export function runClaimer(creep: Creep, telemetryEvents: RuntimeTelemetryEvent[] = []): void {
  runTerritoryControllerCreep(creep, telemetryEvents);
}

