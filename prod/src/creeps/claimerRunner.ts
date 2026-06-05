import { runTerritoryControllerCreep } from '../territory/territoryRunner';
import { runExpansionExecutorClaimer } from '../territory/expansionExecutor';
import { runReservationExecutor } from '../territory/reservationExecutor';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

export function runClaimer(creep: Creep, telemetryEvents: RuntimeTelemetryEvent[] = []): void {
  if (runExpansionExecutorClaimer(creep, telemetryEvents)) {
    recoverIdleNoTerritoryClaimer(creep);
    return;
  }

  if (runReservationExecutor(creep)) {
    recoverIdleNoTerritoryClaimer(creep);
    return;
  }

  runTerritoryControllerCreep(creep, telemetryEvents);
  recoverIdleNoTerritoryClaimer(creep);
}

function recoverIdleNoTerritoryClaimer(creep: Creep): void {
  if (creep.memory.role !== 'claimer' || hasValidTerritoryAssignment(creep.memory.territory)) {
    return;
  }

  if (creep.memory.territory !== undefined) {
    delete creep.memory.territory;
  }

  if (runReservationExecutor(creep) && hasValidTerritoryAssignment(creep.memory.territory)) {
    return;
  }

  recycleIdleClaimer(creep);
}

function recycleIdleClaimer(creep: Creep): void {
  const spawn = selectRecycleSpawn(creep.memory.colony);
  clearMoveMemory(creep);
  if (spawn) {
    if (typeof spawn.recycleCreep === 'function') {
      const result = spawn.recycleCreep(creep);
      if (result === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
        creep.moveTo(spawn);
      }
      return;
    }

    if (typeof creep.moveTo === 'function') {
      creep.moveTo(spawn);
    }
    return;
  }

  moveTowardHomeRoom(creep);
}

function selectRecycleSpawn(colony: string | undefined): StructureSpawn | null {
  if (!isNonEmptyString(colony)) {
    return null;
  }

  const spawns = (globalThis as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns;
  if (!spawns) {
    return null;
  }

  return Object.values(spawns).find((spawn) => spawn.my !== false && spawn.room?.name === colony) ?? null;
}

function moveTowardHomeRoom(creep: Creep): void {
  const homeRoom = creep.memory.colony;
  if (!isNonEmptyString(homeRoom) || creep.room?.name === homeRoom || typeof creep.moveTo !== 'function') {
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor !== 'function') {
    return;
  }

  creep.moveTo(new RoomPositionCtor(25, 25, homeRoom));
}

function clearMoveMemory(creep: Creep): void {
  delete (creep.memory as CreepMemory & { _move?: unknown })._move;
}

function hasValidTerritoryAssignment(assignment: CreepTerritoryMemory | undefined): assignment is CreepTerritoryMemory {
  return (
    isNonEmptyString(assignment?.targetRoom) &&
    (assignment.action === 'claim' || assignment.action === 'reserve' || assignment.action === 'scout')
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
