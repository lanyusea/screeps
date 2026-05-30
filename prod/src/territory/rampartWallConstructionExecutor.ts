import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  planExpansionDefenseBarrierPlacements,
  type ExpansionDefenseBarrierPlacementStage
} from './expansionPlanner';

export const EXPANSION_DEFENSE_BARRIER_CONSTRUCTION_MIN_RCL = 3;
export const EXPANSION_DEFENSE_BARRIER_CONSTRUCTION_MIN_ENERGY = 1;

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_OWNER_CODE = -1 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_INVALID_ARGS_CODE = -10 as ScreepsReturnCode;
const ERR_RCL_NOT_ENOUGH_CODE = -14 as ScreepsReturnCode;
const FALLBACK_EXTENSION_LIMITS_BY_RCL = [0, 0, 5, 10, 20, 30, 40, 50, 60];
const FALLBACK_TOWER_LIMITS_BY_RCL = [0, 0, 0, 1, 1, 2, 2, 3, 6];

type FindConstantGlobal =
  | 'FIND_SOURCES'
  | 'FIND_STRUCTURES'
  | 'FIND_CONSTRUCTION_SITES'
  | 'FIND_MY_STRUCTURES'
  | 'FIND_MY_CONSTRUCTION_SITES';
type StructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_TOWER';
type ReturnCodeGlobal =
  | 'ERR_NOT_OWNER'
  | 'ERR_FULL'
  | 'ERR_INVALID_TARGET'
  | 'ERR_INVALID_ARGS'
  | 'ERR_RCL_NOT_ENOUGH';
const DEFAULT_BARRIER_STAGE_ORDER: readonly ExpansionDefenseBarrierPlacementStage[] = [
  'towerRampart',
  'coreRampart',
  'entranceRampart',
  'entranceWall'
];

interface PositionedRoomObject {
  pos?: {
    x?: unknown;
    y?: unknown;
    roomName?: unknown;
  };
}

interface RoomPositionLike {
  x: number;
  y: number;
  roomName?: string;
}

export type RampartWallConstructionExecutorStatus = 'created' | 'skipped';
export type RampartWallConstructionExecutorSkipReason =
  | 'apiUnavailable'
  | 'controllerLevelLow'
  | 'energyUnavailable'
  | 'essentialStructuresPending'
  | 'notExpansionRoom'
  | 'roomNotClaimed'
  | 'noPlacement';

export interface RampartWallConstructionExecutorOptions {
  requireExpansionMemory?: boolean;
  minEnergyAvailable?: number;
  maxPlacementCandidates?: number;
  stageOrder?: readonly ExpansionDefenseBarrierPlacementStage[];
}

export interface RampartWallConstructionExecutorResult {
  roomName: string;
  status: RampartWallConstructionExecutorStatus;
  reason?: RampartWallConstructionExecutorSkipReason;
  result?: ScreepsReturnCode;
  stage?: ExpansionDefenseBarrierPlacementStage;
  structureType?: BuildableStructureConstant;
  x?: number;
  y?: number;
}

export function runRampartWallConstructionExecutorForColony(
  colony: ColonySnapshot,
  options: RampartWallConstructionExecutorOptions = {}
): RampartWallConstructionExecutorResult {
  const room = colony.room;
  if (options.requireExpansionMemory === true && !isExpansionControlledRoom(room.name)) {
    return { roomName: room.name, status: 'skipped', reason: 'notExpansionRoom' };
  }

  if (room.controller?.my !== true) {
    return { roomName: room.name, status: 'skipped', reason: 'roomNotClaimed' };
  }

  if (!hasRampartWallConstructionExecutorApis(room)) {
    return { roomName: room.name, status: 'skipped', reason: 'apiUnavailable' };
  }

  const rcl = getOwnedRoomRcl(room);
  if (rcl < EXPANSION_DEFENSE_BARRIER_CONSTRUCTION_MIN_RCL) {
    return { roomName: room.name, status: 'skipped', reason: 'controllerLevelLow' };
  }

  const minEnergyAvailable = resolveNonNegativeInteger(
    options.minEnergyAvailable,
    EXPANSION_DEFENSE_BARRIER_CONSTRUCTION_MIN_ENERGY
  );
  if (getColonyEnergyAvailable(colony) < minEnergyAvailable) {
    return { roomName: room.name, status: 'skipped', reason: 'energyUnavailable' };
  }

  if (!isDefenseBarrierStageReady(colony, rcl)) {
    return { roomName: room.name, status: 'skipped', reason: 'essentialStructuresPending' };
  }

  let firstAttemptedPlacement: ReturnType<typeof planExpansionDefenseBarrierPlacements>[number] | null = null;
  let firstAttemptResult: ScreepsReturnCode | undefined;
  for (const stage of getBarrierStageOrder(options.stageOrder)) {
    const placements = planExpansionDefenseBarrierPlacements(room, {
      maxPlacements: options.maxPlacementCandidates,
      stageOrder: [stage]
    });
    if (placements.length === 0) {
      continue;
    }

    for (const placement of placements) {
      const result = room.createConstructionSite(placement.x, placement.y, placement.structureType);
      firstAttemptedPlacement ??= placement;
      firstAttemptResult ??= result;

      if (result === OK_CODE) {
        return {
          roomName: room.name,
          status: 'created',
          result,
          stage: placement.stage,
          structureType: placement.structureType,
          x: placement.x,
          y: placement.y
        };
      }

      if (isFatalConstructionSiteResult(result)) {
        return {
          roomName: room.name,
          status: 'skipped',
          reason: 'noPlacement',
          result,
          stage: placement.stage,
          structureType: placement.structureType,
          x: placement.x,
          y: placement.y
        };
      }
    }
  }

  return {
    roomName: room.name,
    status: 'skipped',
    reason: 'noPlacement',
    ...(firstAttemptResult !== undefined ? { result: firstAttemptResult } : {}),
    ...(firstAttemptedPlacement
      ? {
          stage: firstAttemptedPlacement.stage,
          structureType: firstAttemptedPlacement.structureType,
          x: firstAttemptedPlacement.x,
          y: firstAttemptedPlacement.y
        }
      : {})
  };
}

function getBarrierStageOrder(
  stageOrder: readonly ExpansionDefenseBarrierPlacementStage[] | undefined
): readonly ExpansionDefenseBarrierPlacementStage[] {
  return stageOrder && stageOrder.length > 0 ? [...new Set(stageOrder)] : DEFAULT_BARRIER_STAGE_ORDER;
}

function isDefenseBarrierStageReady(colony: ColonySnapshot, rcl: number): boolean {
  const room = colony.room;
  return (
    hasSpawnCoverage(colony) &&
    hasExtensionCapacityPlaced(room, rcl) &&
    hasSourceContainerCoverage(room) &&
    hasTowerCoverage(room, rcl)
  );
}

function hasSpawnCoverage(colony: ColonySnapshot): boolean {
  return (
    colony.spawns.some((spawn) => spawn.room?.name === colony.room.name) ||
    countExistingAndPendingStructures(colony.room, 'STRUCTURE_SPAWN', 'spawn') > 0
  );
}

function hasExtensionCapacityPlaced(room: Room, rcl: number): boolean {
  const extensionLimit = getStructureLimitForRcl('STRUCTURE_EXTENSION', 'extension', rcl, FALLBACK_EXTENSION_LIMITS_BY_RCL);
  return countExistingAndPendingStructures(room, 'STRUCTURE_EXTENSION', 'extension') >= extensionLimit;
}

function hasTowerCoverage(room: Room, rcl: number): boolean {
  const towerLimit = getStructureLimitForRcl('STRUCTURE_TOWER', 'tower', rcl, FALLBACK_TOWER_LIMITS_BY_RCL);
  return towerLimit <= 0 || countExistingAndPendingStructures(room, 'STRUCTURE_TOWER', 'tower') >= Math.min(1, towerLimit);
}

function hasSourceContainerCoverage(room: Room): boolean {
  const sources = findRoomObjects<Source>(room, 'FIND_SOURCES').filter((source) =>
    isSameRoomPosition(getRoomObjectPosition(source), room.name)
  );
  if (sources.length === 0) {
    return true;
  }

  const containers = [
    ...findRoomObjects<Structure>(room, 'FIND_STRUCTURES'),
    ...findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES')
  ].filter((object) =>
    matchesStructureType((object as { structureType?: string }).structureType, 'STRUCTURE_CONTAINER', 'container')
  );

  return sources.every((source) =>
    containers.some((container) => isNearRoomObject(source, container))
  );
}

function countExistingAndPendingStructures(
  room: Room,
  globalName: StructureConstantGlobal,
  fallback: string
): number {
  return (
    findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES').filter((structure) =>
      matchesStructureType(structure.structureType, globalName, fallback)
    ).length +
    findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES').filter((site) =>
      matchesStructureType(String(site.structureType), globalName, fallback)
    ).length
  );
}

function isExpansionControlledRoom(roomName: string): boolean {
  const territoryMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
  if (!territoryMemory) {
    return false;
  }

  if (isRecord(territoryMemory.postClaimBootstraps?.[roomName])) {
    return true;
  }

  const claimedRoomRecord = territoryMemory.claimedRoomBootstrapper?.rooms?.[roomName];
  if (claimedRoomRecord?.claimedAt !== undefined) {
    return true;
  }

  return (
    hasExpansionControlReference(territoryMemory.targets, roomName, 'roomName') ||
    hasExpansionControlReference(territoryMemory.intents, roomName, 'targetRoom')
  );
}

function hasExpansionControlReference(
  records: unknown,
  roomName: string,
  roomKey: 'roomName' | 'targetRoom'
): boolean {
  return Array.isArray(records)
    ? records.some(
        (record) =>
          isRecord(record) &&
          record[roomKey] === roomName &&
          (record.action === 'claim' || record.action === 'reserve')
      )
    : false;
}

function hasRampartWallConstructionExecutorApis(room: Room): boolean {
  return typeof room.find === 'function' && typeof room.createConstructionSite === 'function';
}

function getOwnedRoomRcl(room: Room): number {
  const level = room.controller?.level;
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

function getColonyEnergyAvailable(colony: ColonySnapshot): number {
  return Math.max(
    0,
    Math.floor(
      Number.isFinite(colony.energyAvailable)
        ? colony.energyAvailable
        : typeof colony.room.energyAvailable === 'number'
          ? colony.room.energyAvailable
          : 0
    )
  );
}

function getStructureLimitForRcl(
  globalName: StructureConstantGlobal,
  fallback: string,
  rcl: number,
  fallbackLimits: number[]
): number {
  const normalizedRcl = Math.max(0, Math.floor(rcl));
  const structureType = getStructureConstant(globalName, fallback);
  const controllerStructures = (globalThis as { CONTROLLER_STRUCTURES?: Partial<Record<string, number[]>> })
    .CONTROLLER_STRUCTURES;
  const configuredLimit = controllerStructures?.[structureType]?.[normalizedRcl];
  if (typeof configuredLimit === 'number' && Number.isFinite(configuredLimit)) {
    return Math.max(0, Math.floor(configuredLimit));
  }

  return fallbackLimits[normalizedRcl] ?? 0;
}

function findRoomObjects<T>(room: Room, globalName: FindConstantGlobal): T[] {
  const findConstant = getGlobalNumber(globalName);
  if (findConstant === null || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getRoomObjectPosition(object: PositionedRoomObject | undefined): RoomPositionLike | null {
  const position = object?.pos;
  if (
    typeof position?.x !== 'number' ||
    typeof position.y !== 'number' ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return null;
  }

  return {
    x: position.x,
    y: position.y,
    ...(typeof position.roomName === 'string' ? { roomName: position.roomName } : {})
  };
}

function isNearRoomObject(left: PositionedRoomObject, right: PositionedRoomObject): boolean {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  if (!leftPosition || !rightPosition || !isSameRoomPosition(leftPosition, rightPosition.roomName)) {
    return false;
  }

  return Math.max(Math.abs(leftPosition.x - rightPosition.x), Math.abs(leftPosition.y - rightPosition.y)) <= 1;
}

function isSameRoomPosition(position: RoomPositionLike | null, roomName: string | undefined): boolean {
  return position !== null && (position.roomName === undefined || roomName === undefined || position.roomName === roomName);
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  return actual === getStructureConstant(globalName, fallback);
}

function getStructureConstant(
  globalName: StructureConstantGlobal,
  fallback: string
): StructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, StructureConstant>>;
  return constants[globalName] ?? (fallback as StructureConstant);
}

function getGlobalNumber(name: FindConstantGlobal): number | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : null;
}

function getGlobalReturnCode(name: ReturnCodeGlobal, fallback: ScreepsReturnCode): ScreepsReturnCode {
  const value = (globalThis as Partial<Record<ReturnCodeGlobal, ScreepsReturnCode>>)[name];
  return typeof value === 'number' ? value : fallback;
}

function isFatalConstructionSiteResult(result: ScreepsReturnCode): boolean {
  return (
    result === getGlobalReturnCode('ERR_NOT_OWNER', ERR_NOT_OWNER_CODE) ||
    result === getGlobalReturnCode('ERR_FULL', ERR_FULL_CODE) ||
    result === getGlobalReturnCode('ERR_INVALID_TARGET', ERR_INVALID_TARGET_CODE) ||
    result === getGlobalReturnCode('ERR_INVALID_ARGS', ERR_INVALID_ARGS_CODE) ||
    result === getGlobalReturnCode('ERR_RCL_NOT_ENOUGH', ERR_RCL_NOT_ENOUGH_CODE)
  );
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
