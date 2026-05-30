import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import {
  planCapacityBootstrapExtensionForColony,
  planConstructionForColony,
  type ConstructionPlannerOptions,
  type ConstructionPlannerResult,
  type RoomConstructionPlannerResult
} from './planner';
import { isPostClaimConstructionRoom } from './constructionPriority';

type ClaimedRoomPlannerYieldReason = 'inactive' | 'noEnergyOrCreeps';

type FindConstantGlobal = 'FIND_SOURCES';

export interface ClaimedRoomConstructionPlannerOptions extends ConstructionPlannerOptions {
  requireEnergyOrCreeps?: boolean;
}

export interface ClaimedRoomConstructionResult extends RoomConstructionPlannerResult {
  active: boolean;
  yielded: boolean;
  yieldReason?: ClaimedRoomPlannerYieldReason;
}

export interface ClaimedRoomConstructionPlannerResult extends ConstructionPlannerResult {
  activeRoomNames: string[];
  yieldedRoomNames: string[];
  rooms: ClaimedRoomConstructionResult[];
}

const DEFAULT_REQUIRE_ENERGY_OR_CREEPS = true;
const DEFAULT_CLAIMED_ROOM_ROAD_SITES_PER_TICK = 1;

export function runClaimedRoomConstructionPlanner(
  options: ClaimedRoomConstructionPlannerOptions = {}
): ClaimedRoomConstructionPlannerResult {
  const colonies = options.colonies ?? getOwnedColonies();
  const rooms = colonies.map((colony) => planClaimedRoomConstruction(colony, options));

  return {
    rooms,
    activeRoomNames: rooms.filter((room) => room.active).map((room) => room.roomName),
    yieldedRoomNames: rooms.filter((room) => room.yielded).map((room) => room.roomName),
    placements: rooms.flatMap((room) => room.placements),
    energyBudget: rooms.reduce((total, room) => total + room.energyBudget, 0),
    energyReserved: rooms.reduce((total, room) => total + room.energyReserved, 0)
  };
}

export function planClaimedRoomConstruction(
  colony: ColonySnapshot,
  options: ClaimedRoomConstructionPlannerOptions = {}
): ClaimedRoomConstructionResult {
  if (!isClaimedRoomConstructionActive(colony.room)) {
    return createEmptyClaimedRoomConstructionResult(colony, 'inactive');
  }

  if (shouldYieldForUnavailableBuildResources(colony, options)) {
    return createEmptyClaimedRoomConstructionResult(colony, 'noEnergyOrCreeps');
  }

  const result = planConstructionForColony(colony, buildClaimedRoomConstructionOptions(colony, options));
  return {
    ...result,
    active: true,
    yielded: false
  };
}

export function planDeferredClaimedRoomCapacityConstruction(
  colony: ColonySnapshot,
  options: ClaimedRoomConstructionPlannerOptions = {}
): ClaimedRoomConstructionResult {
  if (!isClaimedRoomConstructionActive(colony.room)) {
    return createEmptyClaimedRoomConstructionResult(colony, 'inactive');
  }

  if (shouldYieldForUnavailableBuildResources(colony, options)) {
    return createEmptyClaimedRoomConstructionResult(colony, 'noEnergyOrCreeps');
  }

  const result = planCapacityBootstrapExtensionForColony(
    colony,
    buildClaimedRoomConstructionOptions(colony, options)
  );
  return {
    ...result,
    active: true,
    yielded: false
  };
}

export const planClaimedRoomConstructionForColony = planClaimedRoomConstruction;

export function isClaimedRoomConstructionActive(room: Room): boolean {
  return room.controller?.my === true && typeof room.createConstructionSite === 'function';
}

function shouldYieldForUnavailableBuildResources(
  colony: ColonySnapshot,
  options: ClaimedRoomConstructionPlannerOptions
): boolean {
  if ((options.requireEnergyOrCreeps ?? DEFAULT_REQUIRE_ENERGY_OR_CREEPS) !== true) {
    return false;
  }

  return getRoomEnergyAvailable(colony) <= 0 && countAssignedBuilderCreeps(colony.room.name) <= 0;
}

function createEmptyClaimedRoomConstructionResult(
  colony: ColonySnapshot,
  reason: ClaimedRoomPlannerYieldReason
): ClaimedRoomConstructionResult {
  return {
    roomName: colony.room.name,
    rcl: getOwnedRoomRcl(colony.room),
    energyAvailable: getRoomEnergyAvailable(colony),
    energyBudget: 0,
    energyReserved: 0,
    placements: [],
    active: reason !== 'inactive',
    yielded: true,
    yieldReason: reason
  };
}

function buildClaimedRoomConstructionOptions(
  colony: ColonySnapshot,
  options: ClaimedRoomConstructionPlannerOptions
): ConstructionPlannerOptions {
  const sourceCount = getSourceCount(colony.room);
  const postClaimRoom = isPostClaimConstructionRoom(colony.room.name);

  return {
    ...options,
    includePostClaimRamparts: options.includePostClaimRamparts ?? postClaimRoom,
    includeStorage: options.includeStorage ?? postClaimRoom,
    postClaimPriorityOrder: options.postClaimPriorityOrder ?? postClaimRoom,
    respectRoomEnergyBuffer: options.respectRoomEnergyBuffer ?? true,
    maxContainerSitesPerTick: options.maxContainerSitesPerTick ?? Math.max(1, sourceCount),
    roadOptions: {
      maxSitesPerTick: DEFAULT_CLAIMED_ROOM_ROAD_SITES_PER_TICK,
      maxTargetsPerTick: Math.max(1, sourceCount + 1),
      ...options.roadOptions
    }
  };
}

function countAssignedBuilderCreeps(roomName: string): number {
  const creeps = (globalThis as { Game?: Partial<Game> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).filter((creep) => isAssignedBuilderCreep(creep, roomName)).length;
}

function isAssignedBuilderCreep(creep: Creep, roomName: string): boolean {
  if (creep.memory?.role !== 'worker') {
    return false;
  }

  if (typeof creep.ticksToLive === 'number' && creep.ticksToLive <= 0) {
    return false;
  }

  return (
    creep.memory.colony === roomName ||
    creep.memory.spawnSupport?.targetRoom === roomName ||
    creep.memory.controllerSustain?.targetRoom === roomName
  );
}

function getRoomEnergyAvailable(colony: ColonySnapshot): number {
  const roomEnergy = colony.room.energyAvailable;
  if (typeof roomEnergy === 'number' && Number.isFinite(roomEnergy)) {
    return Math.max(0, Math.floor(roomEnergy));
  }

  return typeof colony.energyAvailable === 'number' && Number.isFinite(colony.energyAvailable)
    ? Math.max(0, Math.floor(colony.energyAvailable))
    : 0;
}

function getOwnedRoomRcl(room: Room): number {
  const level = room.controller?.my === true ? room.controller.level : 0;
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(8, Math.floor(level))) : 0;
}

function getSourceCount(room: Room): number {
  const findConstant = getGlobalNumber('FIND_SOURCES');
  if (findConstant === null || typeof room.find !== 'function') {
    return 0;
  }

  try {
    const sources = room.find(findConstant as FindConstant);
    return Array.isArray(sources) ? sources.length : 0;
  } catch {
    return 0;
  }
}

function getGlobalNumber(name: FindConstantGlobal): number | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : null;
}
