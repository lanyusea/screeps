import {
  refreshTerritoryExecutionTargets,
  type TerritoryExecutionRefreshOptions,
  type TerritoryExecutionRefreshResult
} from './executionTargets';

export function refreshReserveExecutionTargets(
  options: TerritoryExecutionRefreshOptions = {}
): TerritoryExecutionRefreshResult {
  return refreshTerritoryExecutionTargets('reserve', options);
}
