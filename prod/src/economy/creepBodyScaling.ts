import {
  getBufferedSpawnEnergyBudget,
  getSpawnEnergyBufferRequirement,
  isSpawnEnergyBufferViolated
} from './spawnEnergyBuffer';

export type DynamicCreepBodyDemand = 'critical' | 'recovery' | 'standard' | 'surplus';

export type SpawnBufferBudgetPolicy = 'respect' | 'alreadyReserved' | 'ignore';

export interface DynamicCreepBodyCandidate {
  role: string;
  demand: DynamicCreepBodyDemand;
  needed: boolean;
  buildBody: (energyBudget: number) => BodyPartConstant[];
  allowSpawnBufferBypass?: boolean;
  maxEnergyBudget?: number;
}

export interface DynamicCreepBodySelectionInput {
  room: Room;
  spawns: StructureSpawn[];
  candidates: DynamicCreepBodyCandidate[];
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  spawnEnergyBudget?: number;
  spawnBufferPolicy?: SpawnBufferBudgetPolicy;
}

export interface DynamicCreepBodySelection {
  role: string;
  demand: DynamicCreepBodyDemand;
  body: BodyPartConstant[];
  bodyCost: number;
  energyBudget: number;
  reserveEnergy: number;
  roomEnergyCapacity: number;
  spawnBufferPolicy: SpawnBufferBudgetPolicy;
  reserveViolated: boolean;
}

const MAX_CREEP_PARTS = 50;

const BODY_PART_COSTS: Record<BodyPartConstant, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10
};

export function selectDynamicCreepBody(
  input: DynamicCreepBodySelectionInput
): DynamicCreepBodySelection | null {
  const candidates = input.candidates
    .filter((candidate) => candidate.needed)
    .sort(compareDynamicCreepBodyCandidates);

  for (const candidate of candidates) {
    const energyBudget = getDynamicCreepBodyEnergyBudget(input, candidate);
    if (energyBudget <= 0) {
      continue;
    }

    const body = candidate.buildBody(getCandidateBuildEnergyBudget(candidate, energyBudget));
    const bodyCost = getDynamicBodyCost(body);
    if (!isValidDynamicBody(body, bodyCost, energyBudget)) {
      continue;
    }

    const policy = getSpawnBufferPolicy(input);
    const availableEnergy = getEnergyAvailable(input);
    const reserveEnergy = getReserveEnergy(input, candidate, policy);

    return {
      role: candidate.role,
      demand: candidate.demand,
      body,
      bodyCost,
      energyBudget,
      reserveEnergy,
      roomEnergyCapacity: getRoomEnergyCapacity(input),
      spawnBufferPolicy: policy,
      reserveViolated:
        policy === 'respect' &&
        !candidate.allowSpawnBufferBypass &&
        isSpawnEnergyBufferViolated(input.room, input.spawns, availableEnergy, bodyCost)
    };
  }

  return null;
}

export function getDynamicCreepBodyEnergyBudget(
  input: DynamicCreepBodySelectionInput,
  candidate: DynamicCreepBodyCandidate
): number {
  const policy = getSpawnBufferPolicy(input);
  const availableEnergy = getEnergyAvailable(input);
  const providedBudget = normalizeEnergyAmount(input.spawnEnergyBudget ?? availableEnergy);
  const roomEnergyCapacity = getRoomEnergyCapacity(input);
  const capacityLimitedBudget =
    roomEnergyCapacity > 0 ? Math.min(providedBudget, roomEnergyCapacity) : providedBudget;

  if (candidate.allowSpawnBufferBypass || policy === 'ignore') {
    return capacityLimitedBudget;
  }

  if (policy === 'alreadyReserved') {
    return capacityLimitedBudget;
  }

  return Math.min(
    capacityLimitedBudget,
    getBufferedSpawnEnergyBudget(input.room, input.spawns, availableEnergy)
  );
}

export function getDynamicBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}

function compareDynamicCreepBodyCandidates(
  left: DynamicCreepBodyCandidate,
  right: DynamicCreepBodyCandidate
): number {
  return getDemandRank(left.demand) - getDemandRank(right.demand);
}

function getDemandRank(demand: DynamicCreepBodyDemand): number {
  switch (demand) {
    case 'critical':
      return 0;
    case 'recovery':
      return 1;
    case 'standard':
      return 2;
    case 'surplus':
      return 3;
  }
}

function getCandidateBuildEnergyBudget(
  candidate: DynamicCreepBodyCandidate,
  energyBudget: number
): number {
  const maxEnergyBudget = normalizeOptionalEnergyAmount(candidate.maxEnergyBudget);
  return maxEnergyBudget === undefined ? energyBudget : Math.min(energyBudget, maxEnergyBudget);
}

function isValidDynamicBody(
  body: BodyPartConstant[],
  bodyCost: number,
  energyBudget: number
): boolean {
  return (
    body.length > 0 &&
    body.length <= MAX_CREEP_PARTS &&
    bodyCost <= energyBudget &&
    body.every((part) => BODY_PART_COSTS[part] !== undefined)
  );
}

function getReserveEnergy(
  input: DynamicCreepBodySelectionInput,
  candidate: DynamicCreepBodyCandidate,
  policy: SpawnBufferBudgetPolicy
): number {
  if (policy !== 'respect' || candidate.allowSpawnBufferBypass) {
    return 0;
  }

  return getSpawnEnergyBufferRequirement(input.room, input.spawns);
}

function getSpawnBufferPolicy(input: DynamicCreepBodySelectionInput): SpawnBufferBudgetPolicy {
  return input.spawnBufferPolicy ?? 'respect';
}

function getEnergyAvailable(input: DynamicCreepBodySelectionInput): number {
  return normalizeEnergyAmount(input.energyAvailable ?? input.room.energyAvailable);
}

function getRoomEnergyCapacity(input: DynamicCreepBodySelectionInput): number {
  return normalizeEnergyAmount(input.energyCapacityAvailable ?? input.room.energyCapacityAvailable);
}

function normalizeOptionalEnergyAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeEnergyAmount(value: unknown): number {
  return normalizeOptionalEnergyAmount(value) ?? 0;
}
