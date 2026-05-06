export const DEFENDER_ROLE = 'defender';

const DEFENDER_BODY_PATTERN: BodyPartConstant[] = ['tough', 'attack', 'move'];
const DEFENDER_BODY_PATTERN_COST = 140;
const MAX_DEFENDER_BODY_PATTERN_COUNT = 5;
const HOSTILES_PER_DEFENDER = 3;
const MAX_CREEP_PARTS = 50;
export const SAFE_MODE_HOSTILE_COUNT_THRESHOLD = 2;
export const CRITICAL_SPAWN_LOSS_HITS_RATIO = 0.25;

export type DefenseTarget = Creep | Structure;

export interface DefensePressureSummary {
  hostileCreepCount: number;
  hostileStructureCount: number;
  damagedCriticalStructureCount: number;
}

export interface DefenderSpawnPlanInput {
  roomName: string;
  hostileCreepCount: number;
  controllerUnderAttack?: boolean;
  activeDefenderCount: number;
  energyAvailable: number;
  gameTime: number;
  nameSuffix?: string;
}

export interface DefenderSpawnPlan {
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

export interface SafeModePlanInput {
  controller?: StructureController;
  hostileCreeps: Creep[];
  ownedSpawns: StructureSpawn[];
}

export function hasDefensePressure(summary: DefensePressureSummary): boolean {
  return (
    normalizeNonNegativeInteger(summary.hostileCreepCount) > 0 ||
    normalizeNonNegativeInteger(summary.hostileStructureCount) > 0 ||
    normalizeNonNegativeInteger(summary.damagedCriticalStructureCount) > 0
  );
}

export function buildDefenderBody(energyAvailable: number, hostileCount: number): BodyPartConstant[] {
  const desiredPatternCount = Math.max(
    1,
    Math.min(normalizeNonNegativeInteger(hostileCount), MAX_DEFENDER_BODY_PATTERN_COUNT)
  );
  const affordablePatternCount = Math.floor(
    normalizeNonNegativeInteger(energyAvailable) / DEFENDER_BODY_PATTERN_COST
  );
  const patternCount = Math.min(
    desiredPatternCount,
    affordablePatternCount,
    Math.floor(MAX_CREEP_PARTS / DEFENDER_BODY_PATTERN.length)
  );

  if (patternCount <= 0) {
    return [];
  }

  return Array.from({ length: patternCount }).flatMap(() => DEFENDER_BODY_PATTERN);
}

export function getDesiredDefenderCount(hostileCount: number): number {
  return Math.max(1, Math.ceil(normalizeNonNegativeInteger(hostileCount) / HOSTILES_PER_DEFENDER));
}

export function planDefenderSpawn(input: DefenderSpawnPlanInput): DefenderSpawnPlan | null {
  const hostileCreepCount = normalizeNonNegativeInteger(input.hostileCreepCount);
  const pressureCount = Math.max(hostileCreepCount, input.controllerUnderAttack === true ? 1 : 0);
  const activeDefenderCount = normalizeNonNegativeInteger(input.activeDefenderCount);

  if (pressureCount <= 0 || activeDefenderCount >= getDesiredDefenderCount(pressureCount)) {
    return null;
  }

  const body = buildDefenderBody(input.energyAvailable, pressureCount);
  if (body.length === 0) {
    return null;
  }

  const roomName = input.roomName;
  return {
    body,
    name: appendNameSuffix(`${DEFENDER_ROLE}-${roomName}-${input.gameTime}`, input.nameSuffix),
    memory: {
      role: DEFENDER_ROLE,
      colony: roomName,
      defense: { homeRoom: roomName }
    }
  };
}

export function selectTowerAttackTarget(
  origin: { pos?: RoomPosition },
  hostileCreeps: Creep[],
  hostileStructures: Structure[]
): DefenseTarget | null {
  return (
    selectClosestTarget(origin, hostileCreeps, { sameRoomOnly: true }) ??
    selectClosestTarget(origin, hostileStructures, { sameRoomOnly: true })
  );
}

export function selectDefenderAttackTarget(
  origin: { pos?: RoomPosition },
  hostileCreeps: Creep[],
  hostileStructures: Structure[]
): DefenseTarget | null {
  return selectClosestTarget(origin, hostileCreeps) ?? selectClosestTarget(origin, hostileStructures);
}

export function shouldActivateSafeMode(input: SafeModePlanInput): boolean {
  const controller = input.controller;
  if (
    input.hostileCreeps.length === 0 ||
    controller?.my !== true ||
    typeof controller.activateSafeMode !== 'function' ||
    !isSafeModeAvailable(controller)
  ) {
    return false;
  }

  if (isCriticalSpawnLossThreat(input.ownedSpawns, input.hostileCreeps)) {
    return true;
  }

  return (
    input.hostileCreeps.length > SAFE_MODE_HOSTILE_COUNT_THRESHOLD &&
    isControllerUnderAttack(controller, input.hostileCreeps)
  );
}

export function hasControllerAttackPressure(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    typeof controller.upgradeBlocked === 'number' &&
    controller.upgradeBlocked > 0
  );
}

function selectClosestTarget<T extends { pos?: RoomPosition }>(
  origin: { pos?: RoomPosition },
  targets: T[],
  options: { sameRoomOnly?: boolean } = {}
): T | null {
  const eligibleTargets = options.sameRoomOnly
    ? targets.filter((target) => isTargetInOriginRoom(origin, target))
    : targets;
  if (eligibleTargets.length === 0) {
    return null;
  }

  return [...eligibleTargets].sort(
    (left, right) => compareRange(origin, left, right) || compareObjectIds(left, right)
  )[0];
}

function isTargetInOriginRoom(origin: { pos?: RoomPosition }, target: { pos?: RoomPosition }): boolean {
  if (!origin.pos || !target.pos) {
    return true;
  }

  return origin.pos.roomName === target.pos.roomName;
}

function compareRange(
  origin: { pos?: RoomPosition },
  left: { pos?: RoomPosition },
  right: { pos?: RoomPosition }
): number {
  const getRangeTo = origin.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  const leftRange = left.pos ? getRangeTo.call(origin.pos, left.pos) : Infinity;
  const rightRange = right.pos ? getRangeTo.call(origin.pos, right.pos) : Infinity;
  return leftRange - rightRange;
}

function compareObjectIds(left: unknown, right: unknown): number {
  return getObjectId(left).localeCompare(getObjectId(right));
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  if (typeof candidate.name === 'string') {
    return candidate.name;
  }

  return '';
}

function appendNameSuffix(baseName: string, suffix: string | undefined): string {
  return suffix ? `${baseName}-${suffix}` : baseName;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isSafeModeAvailable(controller: StructureController): boolean {
  const available = controller.safeModeAvailable;
  const cooldown = controller.safeModeCooldown;
  const active = controller.safeMode;

  return (
    typeof available === 'number' &&
    available > 0 &&
    (typeof cooldown !== 'number' || cooldown <= 0) &&
    (typeof active !== 'number' || active <= 0)
  );
}

function isCriticalSpawnLossThreat(ownedSpawns: StructureSpawn[], hostileCreeps: Creep[]): boolean {
  if (hostileCreeps.length === 0) {
    return false;
  }

  return ownedSpawns.length === 0 || ownedSpawns.some(isCriticallyDamagedSpawn);
}

function isControllerUnderAttack(controller: StructureController, hostileCreeps: Creep[]): boolean {
  if (hasControllerAttackPressure(controller)) {
    return true;
  }

  if (!controller.pos) {
    return false;
  }

  return hostileCreeps.some((hostile) => {
    if (!hostile.pos || hostile.pos.roomName !== controller.pos.roomName) {
      return false;
    }

    const range = controller.pos.getRangeTo?.(hostile.pos);
    return typeof range !== 'number' || range <= 3;
  });
}

function isCriticallyDamagedSpawn(spawn: StructureSpawn): boolean {
  return (
    typeof spawn.hits === 'number' &&
    typeof spawn.hitsMax === 'number' &&
    spawn.hitsMax > 0 &&
    spawn.hits < spawn.hitsMax * CRITICAL_SPAWN_LOSS_HITS_RATIO
  );
}
