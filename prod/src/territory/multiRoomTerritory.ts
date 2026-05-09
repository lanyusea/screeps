import type { ColonySnapshot } from '../colony/colonyRegistry';
import { TERRITORY_AUTO_CLAIM_MIN_RCL, TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY } from './autoClaim';
import type { ExpansionCandidateReport } from './expansionScoring';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

interface ClaimCoordinationInput {
  colony: ColonySnapshot;
  targetRoom: string;
  routeDistance?: number;
  nearestOwnedRoom?: string;
  nearestOwnedRoomDistance?: number;
  territoryMemory?: TerritoryMemory | Record<string, unknown> | null;
}

interface ClaimOwnerCandidate {
  colony: string;
  activePlan: boolean;
  claimCapable: boolean;
  canClaimNow: boolean;
  routeDistance?: number;
  controllerLevel: number;
  energyCapacityAvailable: number;
  energyAvailable: number;
  storageEnergy: number;
  spawnCount: number;
}

const DEFAULT_NO_PATH_CODE = -2 as ScreepsReturnCode;

interface VisibleRoomsCache {
  time: number;
  rooms: Game['rooms'];
  visibleRooms: Room[];
}

interface RouteDistanceCache {
  time: number;
  map: Partial<GameMap> & { findRoute?: (fromRoom: string, toRoom: string) => unknown };
  distances: Map<string, number | undefined>;
}

let visibleRoomsCache: VisibleRoomsCache | null = null;
let routeDistanceCache: RouteDistanceCache | null = null;

export function filterExpansionCandidateReportForColonyNetwork(
  colony: ColonySnapshot,
  report: ExpansionCandidateReport,
  territoryMemory = getTerritoryMemoryRecord()
): ExpansionCandidateReport {
  const candidates = report.candidates.filter(
    (candidate) =>
      !isClaimPlanBlockedByHigherPriorityColony({
        colony,
        targetRoom: candidate.roomName,
        ...(candidate.routeDistance !== undefined ? { routeDistance: candidate.routeDistance } : {}),
        ...(candidate.nearestOwnedRoom ? { nearestOwnedRoom: candidate.nearestOwnedRoom } : {}),
        ...(candidate.nearestOwnedRoomDistance !== undefined
          ? { nearestOwnedRoomDistance: candidate.nearestOwnedRoomDistance }
          : {}),
        territoryMemory
      })
  );

  return attachExpansionCandidateReportColony(
    {
      candidates,
      next: candidates.find((candidate) => candidate.evidenceStatus !== 'unavailable') ?? null
    },
    report.colonyName ?? colony.room.name
  );
}

export function isClaimPlanBlockedByHigherPriorityColony(input: ClaimCoordinationInput): boolean {
  const preferredColony = selectTerritoryClaimOwner(input);
  return preferredColony !== null && preferredColony !== input.colony.room.name;
}

export function selectTerritoryClaimOwner(input: ClaimCoordinationInput): string | null {
  const territoryMemory = input.territoryMemory ?? getTerritoryMemoryRecord();
  const activeOwner = selectActiveClaimPlanOwner(input, territoryMemory);
  if (activeOwner) {
    return activeOwner.colony;
  }

  const candidates = buildOwnedClaimOwnerCandidates(input);
  const bestCandidate = selectBestClaimOwnerCandidate(candidates);
  return bestCandidate?.colony ?? input.colony.room.name;
}

export function pruneLowerPriorityDuplicateClaimPlans(
  territoryMemory: TerritoryMemory,
  winningColony: string,
  targetRoom: string
): void {
  const activeOwners = getActiveClaimPlanOwnerNames(territoryMemory, targetRoom);
  if (activeOwners.some((owner) => owner !== winningColony)) {
    return;
  }

  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((target) => {
      if (!isClaimTargetForDifferentColony(target, winningColony, targetRoom)) {
        return true;
      }

      const targetColony = isRecord(target) && isNonEmptyString(target.colony) ? target.colony : null;
      return targetColony !== null && activeOwners.includes(targetColony);
    });
  }

  if (Array.isArray(territoryMemory.intents)) {
    territoryMemory.intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
      (intent) =>
        !(
          intent.colony !== winningColony &&
          intent.targetRoom === targetRoom &&
          intent.action === 'claim' &&
          intent.status === 'planned'
        )
    );
  }
}

function attachExpansionCandidateReportColony(
  report: ExpansionCandidateReport,
  colonyName: string
): ExpansionCandidateReport {
  Object.defineProperty(report, 'colonyName', {
    value: colonyName,
    enumerable: false
  });
  return report;
}

function selectActiveClaimPlanOwner(
  input: ClaimCoordinationInput,
  territoryMemory: TerritoryMemory | Record<string, unknown> | null | undefined
): ClaimOwnerCandidate | null {
  const activeOwners = getActiveClaimPlanOwnerNames(territoryMemory, input.targetRoom);
  const candidates = activeOwners.flatMap((colonyName) => {
    const candidate = buildClaimOwnerCandidate(colonyName, input, true);
    return candidate ? [candidate] : [];
  });

  return selectBestClaimOwnerCandidate(candidates);
}

function getActiveClaimPlanOwnerNames(
  territoryMemory: TerritoryMemory | Record<string, unknown> | null | undefined,
  targetRoom: string
): string[] {
  if (!territoryMemory) {
    return [];
  }

  const owners = new Set<string>();
  const pipelines = isRecord(territoryMemory.expansionPipelines) ? territoryMemory.expansionPipelines : {};
  for (const pipeline of Object.values(pipelines)) {
    if (
      isRecord(pipeline) &&
      pipeline.status === 'active' &&
      pipeline.targetRoom === targetRoom &&
      isNonEmptyString(pipeline.colony)
    ) {
      owners.add(pipeline.colony);
    }
  }

  for (const intent of normalizeTerritoryIntents(territoryMemory.intents)) {
    if (intent.targetRoom === targetRoom && intent.action === 'claim' && intent.status === 'active') {
      owners.add(intent.colony);
    }
  }

  return Array.from(owners);
}

function buildOwnedClaimOwnerCandidates(input: ClaimCoordinationInput): ClaimOwnerCandidate[] {
  const ownedRooms = getVisibleOwnedRooms(input.colony);
  const candidates: ClaimOwnerCandidate[] = [];
  for (const room of ownedRooms) {
    const candidate = buildClaimOwnerCandidate(room.name, input, false);
    if (candidate && candidate.spawnCount > 0) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function buildClaimOwnerCandidate(
  colonyName: string,
  input: ClaimCoordinationInput,
  activePlan: boolean
): ClaimOwnerCandidate | null {
  const room = getOwnedRoomForCandidate(colonyName, input.colony);
  if (!room?.controller?.my) {
    const routeDistance = getClaimRouteDistance(colonyName, input);
    return activePlan
      ? {
          colony: colonyName,
          activePlan,
          claimCapable: false,
          canClaimNow: false,
          controllerLevel: 0,
          energyCapacityAvailable: 0,
          energyAvailable: 0,
          storageEnergy: 0,
          spawnCount: 0,
          ...(routeDistance !== undefined ? { routeDistance } : {})
        }
      : null;
  }

  const spawnCount = getActiveSpawnCount(colonyName, input.colony);
  const controllerLevel = normalizeNonNegativeInteger(room.controller.level);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(colonyName, room, input.colony);
  const energyAvailable = getRoomEnergyAvailable(colonyName, room, input.colony);
  const routeDistance = getClaimRouteDistance(colonyName, input);
  const claimCapable =
    spawnCount > 0 &&
    controllerLevel >= TERRITORY_AUTO_CLAIM_MIN_RCL &&
    energyCapacityAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY;
  return {
    colony: colonyName,
    activePlan,
    claimCapable,
    canClaimNow: claimCapable && energyAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY,
    controllerLevel,
    energyCapacityAvailable,
    energyAvailable,
    storageEnergy: getRoomStorageEnergy(room),
    spawnCount,
    ...(routeDistance !== undefined ? { routeDistance } : {})
  };
}

function selectBestClaimOwnerCandidate(candidates: ClaimOwnerCandidate[]): ClaimOwnerCandidate | null {
  let bestCandidate: ClaimOwnerCandidate | null = null;
  for (const candidate of candidates) {
    if (!bestCandidate || compareClaimOwnerCandidates(candidate, bestCandidate) < 0) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function compareClaimOwnerCandidates(left: ClaimOwnerCandidate, right: ClaimOwnerCandidate): number {
  return (
    compareBooleansDesc(left.activePlan, right.activePlan) ||
    compareBooleansDesc(left.canClaimNow, right.canClaimNow) ||
    compareBooleansDesc(left.claimCapable, right.claimCapable) ||
    compareOptionalNumbers(left.routeDistance, right.routeDistance) ||
    right.controllerLevel - left.controllerLevel ||
    right.energyCapacityAvailable - left.energyCapacityAvailable ||
    right.energyAvailable - left.energyAvailable ||
    right.storageEnergy - left.storageEnergy ||
    right.spawnCount - left.spawnCount ||
    left.colony.localeCompare(right.colony)
  );
}

function compareBooleansDesc(left: boolean, right: boolean): number {
  return Number(right) - Number(left);
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function getVisibleOwnedRooms(colony: ColonySnapshot): Room[] {
  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const rooms = getVisibleRoomsForTick();
  const ownedRooms = new Map<string, Room>();
  ownedRooms.set(colony.room.name, colony.room);

  for (const room of rooms) {
    if (
      room?.controller?.my === true &&
      isNonEmptyString(room.name) &&
      (!ownerUsername || getControllerOwnerUsername(room.controller) === ownerUsername)
    ) {
      ownedRooms.set(room.name, room);
    }
  }

  return Array.from(ownedRooms.values());
}

function getOwnedRoomForCandidate(colonyName: string, currentColony: ColonySnapshot): Room | undefined {
  return colonyName === currentColony.room.name ? currentColony.room : getGameRooms()?.[colonyName];
}

function getActiveSpawnCount(roomName: string, currentColony: ColonySnapshot): number {
  const currentColonySpawns = roomName === currentColony.room.name ? currentColony.spawns : [];
  const gameSpawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  const spawns = [
    ...currentColonySpawns,
    ...(gameSpawns
      ? Object.values(gameSpawns).filter((spawn) => spawn?.room?.name === roomName)
      : [])
  ];
  const seenSpawns = new Set<string>();
  let activeCount = 0;
  for (const spawn of spawns) {
    if (!spawn) {
      continue;
    }

    const spawnKey = isNonEmptyString(spawn.name) ? spawn.name : String(spawn.id ?? activeCount);
    if (seenSpawns.has(spawnKey)) {
      continue;
    }
    seenSpawns.add(spawnKey);
    if (isSpawnActive(spawn)) {
      activeCount += 1;
    }
  }

  return activeCount;
}

function isSpawnActive(spawn: StructureSpawn): boolean {
  if (typeof spawn.isActive !== 'function') {
    return true;
  }

  try {
    return spawn.isActive() !== false;
  } catch {
    return false;
  }
}

function getClaimRouteDistance(colonyName: string, input: ClaimCoordinationInput): number | undefined {
  if (colonyName === input.targetRoom) {
    return 0;
  }

  if (colonyName === input.colony.room.name && input.routeDistance !== undefined) {
    return normalizeFiniteDistance(input.routeDistance);
  }

  if (colonyName === input.nearestOwnedRoom && input.nearestOwnedRoomDistance !== undefined) {
    return normalizeFiniteDistance(input.nearestOwnedRoomDistance);
  }

  const routeDistance = findRouteDistance(colonyName, input.targetRoom);
  if (routeDistance !== undefined) {
    return routeDistance;
  }

  return getLinearRoomDistance(colonyName, input.targetRoom);
}

function findRouteDistance(fromRoom: string, targetRoom: string): number | undefined {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & { findRoute?: (fromRoom: string, toRoom: string) => unknown })
    | undefined;
  if (typeof gameMap?.findRoute !== 'function') {
    return undefined;
  }

  const cache = getRouteDistanceCache(gameMap);
  const routeKey = getRouteDistanceCacheKey(fromRoom, targetRoom);
  if (cache?.has(routeKey)) {
    return cache.get(routeKey);
  }

  const route = gameMap.findRoute(fromRoom, targetRoom);
  const distance =
    route === getNoPathResultCode() ? Number.POSITIVE_INFINITY : Array.isArray(route) ? route.length : undefined;
  cache?.set(routeKey, distance);
  return distance;
}

function getVisibleRoomsForTick(): Room[] {
  const rooms = getGameRooms();
  if (!rooms) {
    return [];
  }

  const time = getGameTime();
  if (time !== undefined && visibleRoomsCache?.time === time && visibleRoomsCache.rooms === rooms) {
    return visibleRoomsCache.visibleRooms;
  }

  const visibleRooms = Object.values(rooms);
  if (time !== undefined) {
    visibleRoomsCache = { time, rooms, visibleRooms };
  }

  return visibleRooms;
}

function getRouteDistanceCache(
  gameMap: Partial<GameMap> & { findRoute?: (fromRoom: string, toRoom: string) => unknown }
): Map<string, number | undefined> | undefined {
  const time = getGameTime();
  if (time === undefined) {
    return undefined;
  }

  if (routeDistanceCache?.time !== time || routeDistanceCache.map !== gameMap) {
    routeDistanceCache = {
      time,
      map: gameMap,
      distances: new Map<string, number | undefined>()
    };
  }

  return routeDistanceCache.distances;
}

function getRouteDistanceCacheKey(fromRoom: string, targetRoom: string): string {
  return `${fromRoom}>${targetRoom}`;
}

function getLinearRoomDistance(fromRoom: string, targetRoom: string): number | undefined {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & { getRoomLinearDistance?: (roomName1: string, roomName2: string) => number })
    | undefined;
  if (typeof gameMap?.getRoomLinearDistance !== 'function') {
    return undefined;
  }

  const distance = gameMap.getRoomLinearDistance(fromRoom, targetRoom);
  return normalizeFiniteDistance(distance);
}

function getNoPathResultCode(): ScreepsReturnCode {
  const noPathCode = (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  return typeof noPathCode === 'number' ? noPathCode : DEFAULT_NO_PATH_CODE;
}

function normalizeFiniteDistance(distance: number): number | undefined {
  return Number.isFinite(distance) && distance >= 0 ? Math.floor(distance) : undefined;
}

function getRoomEnergyAvailable(roomName: string, room: Room, currentColony: ColonySnapshot): number {
  return roomName === currentColony.room.name
    ? normalizeNonNegativeInteger(currentColony.energyAvailable)
    : normalizeNonNegativeInteger(room.energyAvailable);
}

function getRoomEnergyCapacityAvailable(roomName: string, room: Room, currentColony: ColonySnapshot): number {
  return roomName === currentColony.room.name
    ? normalizeNonNegativeInteger(currentColony.energyCapacityAvailable)
    : normalizeNonNegativeInteger(room.energyCapacityAvailable);
}

function getRoomStorageEnergy(room: Room): number {
  const storedEnergy = room.storage?.store?.getUsedCapacity?.(getEnergyResource());
  return normalizeNonNegativeInteger(storedEnergy);
}

function getEnergyResource(): ResourceConstant {
  return (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? ('energy' as ResourceConstant);
}

function isClaimTargetForDifferentColony(
  target: unknown,
  winningColony: string,
  targetRoom: string
): boolean {
  return (
    isRecord(target) &&
    target.colony !== winningColony &&
    target.roomName === targetRoom &&
    target.enabled !== false &&
    target.action === 'claim'
  );
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getGameRooms(): Game['rooms'] | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms;
}

function getGameTime(): number | undefined {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? Math.floor(time) : undefined;
}

function getTerritoryMemoryRecord(): TerritoryMemory | null {
  const territory = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
  return isRecord(territory) ? (territory as TerritoryMemory) : null;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
