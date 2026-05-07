import type { ColonySnapshot } from '../colony/colonyRegistry';
import { planExpansionTowerPlacements } from './expansionPlanner';

export const EXPANSION_TOWER_CONSTRUCTION_MIN_RCL = 3;
export const EXPANSION_TOWER_CONSTRUCTION_MIN_ENERGY = 1;

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_RCL_NOT_ENOUGH_CODE = -14 as ScreepsReturnCode;
const FALLBACK_TOWER_LIMITS_BY_RCL = [0, 0, 0, 1, 1, 2, 2, 3, 6];

type FindConstantGlobal = 'FIND_MY_STRUCTURES' | 'FIND_MY_CONSTRUCTION_SITES';
type StructureConstantGlobal = 'STRUCTURE_TOWER';
type ReturnCodeGlobal = 'ERR_FULL' | 'ERR_RCL_NOT_ENOUGH';

export type TowerConstructionExecutorStatus = 'created' | 'skipped';
export type TowerConstructionExecutorSkipReason =
  | 'apiUnavailable'
  | 'controllerLevelLow'
  | 'energyUnavailable'
  | 'notExpansionRoom'
  | 'roomNotClaimed'
  | 'towerCapacityCovered'
  | 'noPlacement';

export interface TowerConstructionExecutorOptions {
  requireExpansionMemory?: boolean;
  minEnergyAvailable?: number;
  maxPlacementCandidates?: number;
}

export interface TowerConstructionExecutorResult {
  roomName: string;
  status: TowerConstructionExecutorStatus;
  reason?: TowerConstructionExecutorSkipReason;
  result?: ScreepsReturnCode;
  x?: number;
  y?: number;
}

export function runTowerConstructionExecutorForColony(
  colony: ColonySnapshot,
  options: TowerConstructionExecutorOptions = {}
): TowerConstructionExecutorResult {
  const room = colony.room;
  if (options.requireExpansionMemory === true && !isExpansionControlledRoom(room.name)) {
    return { roomName: room.name, status: 'skipped', reason: 'notExpansionRoom' };
  }

  if (room.controller?.my !== true) {
    return { roomName: room.name, status: 'skipped', reason: 'roomNotClaimed' };
  }

  if (!hasTowerConstructionExecutorApis(room)) {
    return { roomName: room.name, status: 'skipped', reason: 'apiUnavailable' };
  }

  const rcl = getOwnedRoomRcl(room);
  if (rcl < EXPANSION_TOWER_CONSTRUCTION_MIN_RCL) {
    return { roomName: room.name, status: 'skipped', reason: 'controllerLevelLow' };
  }

  const minEnergyAvailable = resolveNonNegativeInteger(
    options.minEnergyAvailable,
    EXPANSION_TOWER_CONSTRUCTION_MIN_ENERGY
  );
  if (getColonyEnergyAvailable(colony) < minEnergyAvailable) {
    return { roomName: room.name, status: 'skipped', reason: 'energyUnavailable' };
  }

  const towerLimit = getTowerLimitForRcl(rcl);
  const plannedTowerCount = countExistingAndPendingTowers(room);
  if (towerLimit <= 0 || plannedTowerCount >= towerLimit) {
    return { roomName: room.name, status: 'skipped', reason: 'towerCapacityCovered' };
  }

  const structureType = getStructureConstant('STRUCTURE_TOWER', 'tower');
  const placements = planExpansionTowerPlacements(room, {
    maxPlacements: options.maxPlacementCandidates
  });
  for (const placement of placements) {
    const result = room.createConstructionSite(placement.x, placement.y, structureType);
    if (result === OK_CODE) {
      return {
        roomName: room.name,
        status: 'created',
        result,
        x: placement.x,
        y: placement.y
      };
    }

    if (isFatalConstructionSiteResult(result)) {
      return { roomName: room.name, status: 'skipped', reason: 'noPlacement', result };
    }
  }

  return { roomName: room.name, status: 'skipped', reason: 'noPlacement' };
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

function hasTowerConstructionExecutorApis(room: Room): boolean {
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

function getTowerLimitForRcl(rcl: number): number {
  const normalizedRcl = Math.max(0, Math.floor(rcl));
  const structureType = getStructureConstant('STRUCTURE_TOWER', 'tower');
  const controllerStructures = (globalThis as { CONTROLLER_STRUCTURES?: Partial<Record<string, number[]>> })
    .CONTROLLER_STRUCTURES;
  const configuredLimit = controllerStructures?.[structureType]?.[normalizedRcl];
  if (typeof configuredLimit === 'number' && Number.isFinite(configuredLimit)) {
    return Math.max(0, Math.floor(configuredLimit));
  }

  return FALLBACK_TOWER_LIMITS_BY_RCL[normalizedRcl] ?? 0;
}

function countExistingAndPendingTowers(room: Room): number {
  return (
    findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES').filter(isTowerLike).length +
    findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES').filter(isTowerLike).length
  );
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

function isTowerLike(object: { structureType?: unknown }): boolean {
  return object.structureType === getStructureConstant('STRUCTURE_TOWER', 'tower');
}

function getStructureConstant(
  globalName: StructureConstantGlobal,
  fallback: string
): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, BuildableStructureConstant>>;
  return constants[globalName] ?? (fallback as BuildableStructureConstant);
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
    result === getGlobalReturnCode('ERR_FULL', ERR_FULL_CODE) ||
    result === getGlobalReturnCode('ERR_RCL_NOT_ENOUGH', ERR_RCL_NOT_ENOUGH_CODE)
  );
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
