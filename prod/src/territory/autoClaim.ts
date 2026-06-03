import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import {
  AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL,
  getAutonomousTerritoryControlMinRcl
} from './controlGate';

const GLOBAL_AUTO_CLAIM_RESERVATION_MIN_TICKS = (globalThis as {
  TERRITORY_AUTO_CLAIM_RESERVATION_MIN_TICKS?: number;
}).TERRITORY_AUTO_CLAIM_RESERVATION_MIN_TICKS;
const GLOBAL_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY = (globalThis as {
  TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY?: number;
}).TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY;

const DEFAULT_AUTO_CLAIM_MIN_RCL = AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL;
const DEFAULT_AUTO_CLAIM_RESERVATION_MIN_TICKS = 4_000;
const DEFAULT_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY = 400;
const MAX_ROOM_ENERGY_CAPACITY_BY_RCL = [0, 300, 550, 800, 1_300, 1_800, 2_300, 5_600, 12_900];

interface TerritoryAutoClaimControllerLike {
  my?: boolean;
  level?: number;
}

export const TERRITORY_AUTO_CLAIM_MIN_RCL =
  getConfiguredTerritoryAutoClaimMinRcl() ?? DEFAULT_AUTO_CLAIM_MIN_RCL;

export const TERRITORY_AUTO_CLAIM_RESERVATION_MIN_TICKS =
  typeof GLOBAL_AUTO_CLAIM_RESERVATION_MIN_TICKS === 'number' &&
  Number.isFinite(GLOBAL_AUTO_CLAIM_RESERVATION_MIN_TICKS) &&
  GLOBAL_AUTO_CLAIM_RESERVATION_MIN_TICKS > 0
    ? Math.floor(GLOBAL_AUTO_CLAIM_RESERVATION_MIN_TICKS)
    : DEFAULT_AUTO_CLAIM_RESERVATION_MIN_TICKS;

export const TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY =
  typeof GLOBAL_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY === 'number' &&
  Number.isFinite(GLOBAL_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY) &&
  GLOBAL_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY >= 0
    ? Math.floor(GLOBAL_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY)
    : DEFAULT_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY;

export const TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY =
  TERRITORY_CONTROLLER_BODY_COST + TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY;

export function getTerritoryAutoClaimMinRcl(): number {
  const autonomousMinRcl = getAutonomousTerritoryControlMinRcl();
  return Math.max(getConfiguredTerritoryAutoClaimMinRcl() ?? autonomousMinRcl, autonomousMinRcl);
}

export function isTerritoryAutoClaimAllowedForController(
  controller: TerritoryAutoClaimControllerLike | undefined
): boolean {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level >= getTerritoryAutoClaimMinRcl()
  );
}

export function getTerritoryAutoClaimRequiredEnergy(controllerLevel: number | undefined): number {
  const rclCapacity = getMaxRoomEnergyCapacityForRcl(controllerLevel);
  if (rclCapacity === null) {
    return TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY;
  }

  return Math.max(
    TERRITORY_CONTROLLER_BODY_COST,
    Math.min(TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY, rclCapacity)
  );
}

export function getTerritoryAutoClaimPostClaimBootstrapReserveEnergy(
  controllerLevel: number | undefined
): number {
  return Math.max(
    0,
    getTerritoryAutoClaimRequiredEnergy(controllerLevel) - TERRITORY_CONTROLLER_BODY_COST
  );
}

export function isTerritoryAutoClaimReservationMature(ticksToEnd: number | undefined): boolean {
  return (
    typeof ticksToEnd === 'number' &&
    Number.isFinite(ticksToEnd) &&
    ticksToEnd >= TERRITORY_AUTO_CLAIM_RESERVATION_MIN_TICKS
  );
}

export function getTerritoryAutoClaimBodyEnergyBudget(energyAvailable: number): number {
  return Math.max(0, Math.floor(energyAvailable) - TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY);
}

function getConfiguredTerritoryAutoClaimMinRcl(): number | null {
  const value = (globalThis as { TERRITORY_AUTO_CLAIM_MIN_RCL?: number }).TERRITORY_AUTO_CLAIM_MIN_RCL;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function getMaxRoomEnergyCapacityForRcl(controllerLevel: number | undefined): number | null {
  if (typeof controllerLevel !== 'number' || !Number.isFinite(controllerLevel)) {
    return null;
  }

  const rcl = Math.max(0, Math.min(8, Math.floor(controllerLevel)));
  return MAX_ROOM_ENERGY_CAPACITY_BY_RCL[rcl] ?? null;
}
