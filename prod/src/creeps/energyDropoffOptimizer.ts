type EnergyDropoffRefillStructure = StructureExtension | StructureSpawn | StructureTower;
type EnergyDropoffStructureGlobal =
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL'
  | 'STRUCTURE_TOWER';

export interface EnergyDropoffOptimizerConfig {
  maxControllerLevel: number;
  maxReturnPathDetour: number;
  maxUnknownPathDirectRange: number;
  maxUnknownPathExtraRangeBeyondDropoff: number;
  minConstructionRemainingProgress: number;
  minRefillFreeCapacity: number;
}

export interface EnergyDropoffOptimizationContext {
  constructionSites: ConstructionSite[];
  controller?: StructureController;
  dropoff: RoomObject;
  origin: RoomObject;
  refillStructures: AnyOwnedStructure[];
}

interface EnergyDropoffCandidate {
  directRange: number;
  id: string;
  priority: number;
  returnPathDetour: number | null;
  target: RoomObject;
  task: CreepTaskMemory;
}

export const DEFAULT_ENERGY_DROPOFF_OPTIMIZER_CONFIG: EnergyDropoffOptimizerConfig = {
  maxControllerLevel: 8,
  maxReturnPathDetour: 2,
  maxUnknownPathDirectRange: 4,
  maxUnknownPathExtraRangeBeyondDropoff: 1,
  minConstructionRemainingProgress: 1,
  minRefillFreeCapacity: 1
};

export function selectEnergyDropoffOptimizationTask(
  creep: Creep,
  dropoff: unknown,
  config: Partial<EnergyDropoffOptimizerConfig> = {}
): CreepTaskMemory | null {
  if (!isDurableEnergyDropoff(dropoff) || typeof creep.room?.find !== 'function') {
    return null;
  }

  const constructionSites = findRoomConstructionSites(creep.room);
  const refillStructures = findRoomOwnedStructures(creep.room);
  return selectEnergyDropoffOptimization({
    constructionSites,
    controller: creep.room.controller,
    dropoff,
    origin: creep,
    refillStructures
  }, config);
}

export function selectEnergyDropoffOptimization(
  context: EnergyDropoffOptimizationContext,
  config: Partial<EnergyDropoffOptimizerConfig> = {}
): CreepTaskMemory | null {
  const effectiveConfig = { ...DEFAULT_ENERGY_DROPOFF_OPTIMIZER_CONFIG, ...config };
  const candidates = [
    ...createRefillCandidates(context, effectiveConfig),
    ...createConstructionCandidates(context, effectiveConfig),
    createControllerCandidate(context, effectiveConfig)
  ].filter((candidate): candidate is EnergyDropoffCandidate => candidate !== null);

  return candidates.sort(compareEnergyDropoffCandidates)[0]?.task ?? null;
}

export function isDurableEnergyDropoff(target: unknown): target is StructureStorage | StructureTerminal {
  const structureType = (target as Partial<Structure> | null)?.structureType;
  return (
    matchesStructureType(structureType, 'STRUCTURE_STORAGE', 'storage') ||
    matchesStructureType(structureType, 'STRUCTURE_TERMINAL', 'terminal')
  );
}

function findRoomConstructionSites(room: Room): ConstructionSite[] {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number') {
    return [];
  }

  const sites = room.find(FIND_CONSTRUCTION_SITES);
  return Array.isArray(sites) ? (sites as ConstructionSite[]) : [];
}

function findRoomOwnedStructures(room: Room): AnyOwnedStructure[] {
  if (typeof FIND_MY_STRUCTURES !== 'number') {
    return [];
  }

  const structures = room.find(FIND_MY_STRUCTURES);
  return Array.isArray(structures) ? (structures as AnyOwnedStructure[]) : [];
}

function createRefillCandidates(
  context: EnergyDropoffOptimizationContext,
  config: EnergyDropoffOptimizerConfig
): Array<EnergyDropoffCandidate | null> {
  return context.refillStructures
    .filter((structure): structure is EnergyDropoffRefillStructure => isRefillStructure(structure, config))
    .map((structure) =>
      createCandidate(
        context,
        structure,
        {
          type: 'transfer',
          targetId: structure.id as Id<AnyStoreStructure>
        },
        isPrimaryRefillStructure(structure) ? 0 : 1,
        config
      )
    );
}

function createConstructionCandidates(
  context: EnergyDropoffOptimizationContext,
  config: EnergyDropoffOptimizerConfig
): Array<EnergyDropoffCandidate | null> {
  return context.constructionSites
    .filter((site) => canReceiveConstructionEnergy(site, config))
    .map((site) =>
      createCandidate(
        context,
        site,
        {
          type: 'build',
          targetId: site.id
        },
        2,
        config
      )
    );
}

function createControllerCandidate(
  context: EnergyDropoffOptimizationContext,
  config: EnergyDropoffOptimizerConfig
): EnergyDropoffCandidate | null {
  const controller = context.controller;
  if (!canReceiveControllerUpgradeEnergy(controller, config)) {
    return null;
  }

  return createCandidate(
    context,
    controller,
    {
      type: 'upgrade',
      targetId: controller.id
    },
    3,
    config
  );
}

function createCandidate(
  context: EnergyDropoffOptimizationContext,
  target: RoomObject,
  task: CreepTaskMemory,
  priority: number,
  config: EnergyDropoffOptimizerConfig
): EnergyDropoffCandidate | null {
  const directRange = getRangeBetweenRoomObjects(context.origin, target);
  if (directRange === null) {
    return null;
  }

  const returnPathDetour = getReturnPathDetour(context.origin, target, context.dropoff);
  if (!isEfficientReturnPathTarget(directRange, returnPathDetour, context, config)) {
    return null;
  }

  return {
    directRange,
    id: getStableId(target),
    priority,
    returnPathDetour,
    target,
    task
  };
}

function isEfficientReturnPathTarget(
  directRange: number,
  returnPathDetour: number | null,
  context: EnergyDropoffOptimizationContext,
  config: EnergyDropoffOptimizerConfig
): boolean {
  if (returnPathDetour !== null) {
    return returnPathDetour <= config.maxReturnPathDetour;
  }

  const dropoffRange = getRangeBetweenRoomObjects(context.origin, context.dropoff);
  if (dropoffRange !== null && directRange > dropoffRange + config.maxUnknownPathExtraRangeBeyondDropoff) {
    return false;
  }

  return directRange <= config.maxUnknownPathDirectRange;
}

function getReturnPathDetour(origin: RoomObject, target: RoomObject, dropoff: RoomObject): number | null {
  const originToTarget = getRangeBetweenRoomObjects(origin, target);
  const targetToDropoff = getRangeBetweenRoomObjects(target, dropoff);
  const originToDropoff = getRangeBetweenRoomObjects(origin, dropoff);
  if (originToTarget === null || targetToDropoff === null || originToDropoff === null) {
    return null;
  }

  return Math.max(0, originToTarget + targetToDropoff - originToDropoff);
}

function compareEnergyDropoffCandidates(left: EnergyDropoffCandidate, right: EnergyDropoffCandidate): number {
  return (
    left.priority - right.priority ||
    compareNullableRange(left.returnPathDetour, right.returnPathDetour) ||
    left.directRange - right.directRange ||
    left.id.localeCompare(right.id)
  );
}

function compareNullableRange(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function canReceiveConstructionEnergy(
  site: ConstructionSite,
  config: EnergyDropoffOptimizerConfig
): boolean {
  if ((site as ConstructionSite & { my?: boolean }).my === false) {
    return false;
  }

  const remainingProgress = getConstructionRemainingProgress(site);
  return remainingProgress === null || remainingProgress >= config.minConstructionRemainingProgress;
}

function canReceiveControllerUpgradeEnergy(
  controller: StructureController | undefined,
  config: EnergyDropoffOptimizerConfig
): controller is StructureController {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level < config.maxControllerLevel
  );
}

function isRefillStructure(
  structure: AnyOwnedStructure,
  config: EnergyDropoffOptimizerConfig
): structure is EnergyDropoffRefillStructure {
  return (
    (isPrimaryRefillStructure(structure) || isTowerRefillStructure(structure)) &&
    getFreeEnergyCapacity(structure) >= config.minRefillFreeCapacity
  );
}

function isPrimaryRefillStructure(structure: AnyOwnedStructure): structure is StructureExtension | StructureSpawn {
  return isExtensionRefillStructure(structure) || isSpawnRefillStructure(structure);
}

function isExtensionRefillStructure(structure: AnyOwnedStructure): structure is StructureExtension {
  return matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension') && 'store' in structure;
}

function isSpawnRefillStructure(structure: AnyOwnedStructure): structure is StructureSpawn {
  return matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') && 'store' in structure;
}

function isTowerRefillStructure(structure: AnyOwnedStructure): structure is StructureTower {
  return matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower') && 'store' in structure;
}

function getConstructionRemainingProgress(site: ConstructionSite): number | null {
  const progress = site.progress;
  const progressTotal = site.progressTotal;
  if (
    typeof progress !== 'number' ||
    !Number.isFinite(progress) ||
    typeof progressTotal !== 'number' ||
    !Number.isFinite(progressTotal)
  ) {
    return null;
  }

  return Math.max(0, progressTotal - progress);
}

function getFreeEnergyCapacity(target: unknown): number {
  const freeCapacity = (target as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store?.getFreeCapacity?.(RESOURCE_ENERGY);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getRangeBetweenRoomObjects(left: RoomObject, right: RoomObject): number | null {
  const directRange = left.pos?.getRangeTo?.(right);
  if (typeof directRange === 'number' && Number.isFinite(directRange)) {
    return Math.max(0, directRange);
  }

  const reverseRange = right.pos?.getRangeTo?.(left);
  if (typeof reverseRange === 'number' && Number.isFinite(reverseRange)) {
    return Math.max(0, reverseRange);
  }

  return getChebyshevRoomRange(left.pos, right.pos);
}

function getChebyshevRoomRange(left: RoomPosition | undefined, right: RoomPosition | undefined): number | null {
  if (
    !left ||
    !right ||
    typeof left.x !== 'number' ||
    typeof left.y !== 'number' ||
    typeof right.x !== 'number' ||
    typeof right.y !== 'number' ||
    (typeof left.roomName === 'string' && typeof right.roomName === 'string' && left.roomName !== right.roomName)
  ) {
    return null;
  }

  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function getStableId(object: RoomObject): string {
  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function matchesStructureType(
  actual: unknown,
  globalName: EnergyDropoffStructureGlobal,
  fallback: string
): boolean {
  if (typeof actual !== 'string') {
    return false;
  }

  const constants = globalThis as unknown as Partial<Record<EnergyDropoffStructureGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}
