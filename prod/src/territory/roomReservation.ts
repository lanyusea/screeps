import { recordTerritoryReserveFallbackIntent } from './territoryPlanner';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

export type PlannedClaimReservationStatus = 'reserved' | 'moving' | 'skipped' | 'blocked';
export type PlannedClaimReservationReason =
  | 'notClaimAssignment'
  | 'gclAvailable'
  | 'targetRoomNotVisible'
  | 'controllerMissing'
  | 'controllerOwned'
  | 'foreignReservation'
  | 'missingClaimPart'
  | 'reserveUnsupported'
  | 'reserveFailed';

export interface PlannedClaimReservationResult {
  status: PlannedClaimReservationStatus;
  reason?: PlannedClaimReservationReason;
  result?: ScreepsReturnCode;
  targetRoom?: string;
  controllerId?: Id<StructureController>;
}

export function runPlannedClaimReservation(creep: Creep): boolean {
  const result = reserveRoomForPlannedClaim(creep);
  return result.status === 'reserved' || result.status === 'moving' || result.status === 'blocked';
}

export function reserveRoomForPlannedClaim(creep: Creep): PlannedClaimReservationResult {
  const assignment = creep.memory.territory;
  if (!isPlannedClaimAssignment(assignment)) {
    return { status: 'skipped', reason: 'notClaimAssignment' };
  }

  if (!isGclRoomCapacityFull(creep.memory.colony)) {
    return {
      status: 'skipped',
      reason: 'gclAvailable',
      targetRoom: assignment.targetRoom,
      ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {})
    };
  }

  if (creep.room?.name !== assignment.targetRoom) {
    return {
      status: 'skipped',
      reason: 'targetRoomNotVisible',
      targetRoom: assignment.targetRoom,
      ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {})
    };
  }

  const controller = selectClaimReservationController(creep, assignment);
  if (!controller) {
    return {
      status: 'skipped',
      reason: 'controllerMissing',
      targetRoom: assignment.targetRoom
    };
  }

  if (isControllerOwned(controller)) {
    return {
      status: 'skipped',
      reason: 'controllerOwned',
      targetRoom: assignment.targetRoom,
      controllerId: controller.id
    };
  }

  if (!canReserveControllerForColony(controller, creep)) {
    return {
      status: 'skipped',
      reason: 'foreignReservation',
      targetRoom: assignment.targetRoom,
      controllerId: controller.id
    };
  }

  if (getActiveClaimPartCount(creep) <= 0) {
    return {
      status: 'skipped',
      reason: 'missingClaimPart',
      targetRoom: assignment.targetRoom,
      controllerId: controller.id
    };
  }

  if (typeof creep.reserveController !== 'function') {
    return {
      status: 'skipped',
      reason: 'reserveUnsupported',
      targetRoom: assignment.targetRoom,
      controllerId: controller.id
    };
  }

  const reserveAssignment: CreepTerritoryMemory = {
    targetRoom: assignment.targetRoom,
    action: 'reserve',
    controllerId: controller.id,
    ...(assignment.followUp ? { followUp: assignment.followUp } : {})
  };
  creep.memory.territory =
    recordTerritoryReserveFallbackIntent(creep.memory.colony, reserveAssignment, getGameTime()) ??
    reserveAssignment;

  const result = creep.reserveController(controller);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    if (typeof creep.moveTo === 'function') {
      creep.moveTo(controller);
    }

    return {
      status: 'moving',
      result,
      targetRoom: assignment.targetRoom,
      controllerId: controller.id
    };
  }

  if (result === OK_CODE) {
    return {
      status: 'reserved',
      result,
      targetRoom: assignment.targetRoom,
      controllerId: controller.id
    };
  }

  return {
    status: 'blocked',
    reason: 'reserveFailed',
    result,
    targetRoom: assignment.targetRoom,
    controllerId: controller.id
  };
}

function isPlannedClaimAssignment(
  assignment: CreepTerritoryMemory | undefined
): assignment is CreepTerritoryMemory & { action: 'claim' } {
  return isNonEmptyString(assignment?.targetRoom) && assignment.action === 'claim';
}

function selectClaimReservationController(
  creep: Creep,
  assignment: CreepTerritoryMemory
): StructureController | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  if (assignment.controllerId && typeof game?.getObjectById === 'function') {
    const controller = game.getObjectById.call(game, assignment.controllerId) as StructureController | null;
    if (controller) {
      return controller;
    }
  }

  return creep.room?.controller ?? game?.rooms?.[assignment.targetRoom]?.controller ?? null;
}

function isGclRoomCapacityFull(colony: string | undefined): boolean {
  const game = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game;
  const gclLevel = game?.gcl?.level;
  if (typeof gclLevel !== 'number' || !Number.isFinite(gclLevel) || gclLevel <= 0) {
    return false;
  }

  return countVisibleOwnedRooms(colony) >= Math.floor(gclLevel);
}

function countVisibleOwnedRooms(colony: string | undefined): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 0;
  }

  const colonyOwnerUsername = getControllerOwnerUsername(
    isNonEmptyString(colony) ? rooms[colony]?.controller : undefined
  );
  let ownedRoomCount = 0;
  for (const room of Object.values(rooms)) {
    if (
      room?.controller?.my === true &&
      (!colonyOwnerUsername || getControllerOwnerUsername(room.controller) === colonyOwnerUsername)
    ) {
      ownedRoomCount += 1;
    }
  }

  return ownedRoomCount;
}

function canReserveControllerForColony(controller: StructureController, creep: Creep): boolean {
  const reservationUsername = getControllerReservationUsername(controller);
  if (!reservationUsername) {
    return true;
  }

  const actorUsername = getActorUsername(creep);
  return isNonEmptyString(actorUsername) && reservationUsername === actorUsername;
}

function isControllerOwned(controller: StructureController): boolean {
  return controller.my === true || isNonEmptyString(getControllerOwnerUsername(controller));
}

function getActiveClaimPartCount(creep: Creep): number {
  const claimPart = getClaimBodyPartConstant();
  const activeParts = creep.getActiveBodyparts?.(claimPart);
  if (typeof activeParts === 'number') {
    return Math.max(0, Math.floor(activeParts));
  }

  if (!Array.isArray(creep.body)) {
    return 1;
  }

  return creep.body.filter((part) => part.type === claimPart && part.hits > 0).length;
}

function getActorUsername(creep: Creep): string | undefined {
  const creepOwner = (creep as Creep & { owner?: { username?: string } }).owner?.username;
  if (isNonEmptyString(creepOwner)) {
    return creepOwner;
  }

  const colony = creep.memory.colony;
  const room = isNonEmptyString(colony)
    ? (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[colony]
    : undefined;
  return getControllerOwnerUsername(room?.controller);
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { reservation?: { username?: string } }).reservation
    ?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getClaimBodyPartConstant(): BodyPartConstant {
  return (globalThis as { CLAIM?: BodyPartConstant }).CLAIM ?? ('claim' as BodyPartConstant);
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
