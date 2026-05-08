type LabStoreLike = {
  getUsedCapacity?: (resource?: ResourceConstant) => number | null;
  getFreeCapacity?: (resource?: ResourceConstant) => number | null;
  getCapacity?: (resource?: ResourceConstant) => number | null;
  [resource: string]: unknown;
};

type ReactionTable = Record<string, Record<string, string>>;

export type LabInventory = Partial<Record<ResourceConstant, number>>;

export interface LabReactionStep {
  amount: number;
  depth: number;
  product: ResourceConstant;
  ready: boolean;
  reagents: [ResourceConstant, ResourceConstant];
}

export interface LabReactionChainPlan {
  desiredAmount: number;
  missingResources: Array<{ amount: number; resource: ResourceConstant }>;
  steps: LabReactionStep[];
  targetResource: ResourceConstant;
}

export interface LabBoostRequest {
  creep: Creep;
  part: BodyPartConstant;
  priority: EconomyLabBoostPriority;
  requestedParts: number;
  resource: MineralBoostConstant;
}

export interface LabBoostPlan extends LabBoostRequest {
  boostParts: number;
  lab: StructureLab | null;
  reason?: EconomyLabBlockReason;
  requiredEnergy: number;
  requiredMineral: number;
  status: 'ready' | 'blocked';
}

export interface LabBoostResult {
  boostParts: number;
  creepName: string;
  labId?: string;
  part: BodyPartConstant;
  priority: EconomyLabBoostPriority;
  reason?: EconomyLabBlockReason | 'notInRange';
  resource: MineralBoostConstant;
  result?: ScreepsReturnCode;
  status: 'boosted' | 'blocked' | 'moving';
}

export interface LabReactionRunResult {
  product?: ResourceConstant;
  reason?: EconomyLabBlockReason | 'complete' | 'noTarget';
  reagents?: [ResourceConstant, ResourceConstant];
  result?: ScreepsReturnCode;
  sourceLabIds?: [string, string];
  status: 'running' | 'blocked' | 'complete' | 'idle';
  targetResource?: ResourceConstant;
  outputLabId?: string;
}

export interface LabManagementOptions {
  creeps?: Creep[];
  desiredAmount?: number;
  dryRun?: boolean;
  labs?: StructureLab[];
  reactionTarget?: ResourceConstant;
}

export interface LabManagementResult {
  boost?: LabBoostResult;
  boosts?: LabBoostResult[];
  boostRequests: LabBoostPlan[];
  inventory: LabInventory;
  labs: StructureLab[];
  reaction?: LabReactionRunResult;
  roomName: string;
}

export const DEFAULT_LAB_REACTION_DESIRED_AMOUNT = 1_000;
export const CONTROLLER_UPGRADE_BOOSTS: MineralBoostConstant[] = [
  'XGH2O',
  'GH2O',
  'GH'
] as MineralBoostConstant[];

const OK_CODE = 0 as ScreepsReturnCode;
const DEFAULT_LAB_BOOST_ENERGY = 20;
const DEFAULT_LAB_BOOST_MINERAL = 30;
const DEFAULT_LAB_REACTION_AMOUNT = 5;
const DEFAULT_LAB_MINERAL_CAPACITY = 3_000;

const FALLBACK_REACTION_PAIRS: Array<[ResourceConstant, ResourceConstant, ResourceConstant]> = [
  ['H', 'O', 'OH'],
  ['Z', 'K', 'ZK'],
  ['U', 'L', 'UL'],
  ['ZK', 'UL', 'G'],
  ['H', 'U', 'UH'],
  ['O', 'U', 'UO'],
  ['H', 'K', 'KH'],
  ['O', 'K', 'KO'],
  ['H', 'L', 'LH'],
  ['O', 'L', 'LO'],
  ['H', 'Z', 'ZH'],
  ['O', 'Z', 'ZO'],
  ['H', 'G', 'GH'],
  ['O', 'G', 'GO'],
  ['OH', 'UH', 'UH2O'],
  ['OH', 'UO', 'UHO2'],
  ['OH', 'KH', 'KH2O'],
  ['OH', 'KO', 'KHO2'],
  ['OH', 'LH', 'LH2O'],
  ['OH', 'LO', 'LHO2'],
  ['OH', 'ZH', 'ZH2O'],
  ['OH', 'ZO', 'ZHO2'],
  ['OH', 'GH', 'GH2O'],
  ['OH', 'GO', 'GHO2'],
  ['X', 'UH2O', 'XUH2O'],
  ['X', 'UHO2', 'XUHO2'],
  ['X', 'KH2O', 'XKH2O'],
  ['X', 'KHO2', 'XKHO2'],
  ['X', 'LH2O', 'XLH2O'],
  ['X', 'LHO2', 'XLHO2'],
  ['X', 'ZH2O', 'XZH2O'],
  ['X', 'ZHO2', 'XZHO2'],
  ['X', 'GH2O', 'XGH2O'],
  ['X', 'GHO2', 'XGHO2']
] as Array<[ResourceConstant, ResourceConstant, ResourceConstant]>;

export function manageLabs(room: Room, options: LabManagementOptions = {}): LabManagementResult {
  const labs = [...(options.labs ?? detectOwnedLabs(room))].sort(compareObjectsById);
  const inventory = buildLabInventory(room, labs);
  const creeps = options.creeps ?? Object.values((globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps ?? {});
  const boostRequests = selectBoostPlans(room, labs, creeps, inventory);
  const boosts = runBoostManager(boostRequests, options);
  const boost = selectPrimaryBoostResult(boosts);
  const previousRoomMemory = getExistingLabRoomMemory(room.name);
  const reaction =
    shouldRunReactionAfterBoost(boosts)
      ? runSelectedReaction(room, labs, inventory, selectBoostReactionPlan(boostRequests), previousRoomMemory, options)
      : undefined;
  const result: LabManagementResult = {
    roomName: room.name,
    labs,
    inventory,
    boostRequests,
    ...(boost ? { boost } : {}),
    ...(boosts.length > 0 ? { boosts } : {}),
    ...(reaction ? { reaction } : {})
  };

  recordLabManagementState(room, result, previousRoomMemory, options);
  return result;
}

export function shouldManageLabs(room: Room): boolean {
  return (
    room.controller?.my === true &&
    normalizeNonNegativeInteger(room.controller.level) >= 6 &&
    detectOwnedLabs(room).length > 0
  );
}

export function detectOwnedLabs(room: Room): StructureLab[] {
  return findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES')
    .filter(isLabStructure)
    .sort(compareObjectsById);
}

export function buildLabInventory(room: Room, labs: StructureLab[]): LabInventory {
  const inventory: LabInventory = {};
  for (const lab of labs) {
    addResourceAmount(inventory, getEnergyResource(), getLabEnergy(lab));
    const mineralType = getLabMineralType(lab);
    if (mineralType) {
      addResourceAmount(inventory, mineralType, getLabResourceAmount(lab, mineralType));
    }
  }

  addStoreInventory(inventory, room.storage);
  addStoreInventory(inventory, room.terminal);
  return inventory;
}

export function planReactionChain(
  targetResource: ResourceConstant,
  inventory: LabInventory,
  desiredAmount = DEFAULT_LAB_REACTION_DESIRED_AMOUNT
): LabReactionChainPlan {
  const steps: LabReactionStep[] = [];
  const missingResources: Array<{ amount: number; resource: ResourceConstant }> = [];
  const normalizedDesiredAmount = Math.max(0, normalizeNonNegativeInteger(desiredAmount));

  appendReactionSteps(targetResource, normalizedDesiredAmount, inventory, steps, missingResources, new Set(), 0);

  return {
    targetResource,
    desiredAmount: normalizedDesiredAmount,
    steps: dedupeReactionSteps(steps),
    missingResources: dedupeMissingResources(missingResources)
  };
}

export function selectBoostPlans(
  room: Room,
  labs: StructureLab[],
  creeps: Creep[],
  inventory: LabInventory
): LabBoostPlan[] {
  return buildBoostRequests(room, creeps, inventory)
    .map((request) => buildBoostPlan(request, labs))
    .sort(compareBoostPlans);
}

export function shouldYieldCreepToLabManager(creep: Creep, gameTime = getGameTime()): boolean {
  const labMemory = creep.memory.lab;
  return labMemory?.boostState === 'moving' && labMemory.updatedAt === gameTime;
}

function buildBoostRequests(room: Room, creeps: Creep[], inventory: LabInventory): LabBoostRequest[] {
  const roomCreeps = creeps.filter((creep) => creep.room?.name === room.name);
  return [
    ...buildControllerUpgradeBoostRequests(roomCreeps, inventory),
    ...buildExplicitCreepBoostRequests(roomCreeps)
  ].sort(compareBoostRequests);
}

function buildControllerUpgradeBoostRequests(creeps: Creep[], inventory: LabInventory): LabBoostRequest[] {
  const requests: LabBoostRequest[] = [];
  for (const creep of creeps) {
    if (!isControllerUpgradeBoostCandidate(creep)) {
      continue;
    }

    const requestedParts = countUnboostedBodyParts(creep, 'work');
    if (requestedParts <= 0) {
      continue;
    }

    requests.push({
      creep,
      part: 'work',
      priority: 'controllerUpgrade',
      requestedParts,
      resource: selectControllerUpgradeBoostResource(inventory)
    });
  }

  return requests;
}

function buildExplicitCreepBoostRequests(creeps: Creep[]): LabBoostRequest[] {
  const requests: LabBoostRequest[] = [];
  for (const creep of creeps) {
    const boostRequests = normalizeCreepBoostRequests(creep.memory.lab?.boosts);
    for (const request of boostRequests) {
      const requestedParts = countUnboostedBodyParts(creep, request.part);
      if (requestedParts <= 0) {
        continue;
      }

      requests.push({
        creep,
        part: request.part,
        priority: request.priority ?? 'creepBoost',
        requestedParts,
        resource: request.resource
      });
    }
  }

  return requests;
}

function runBoostManager(boostRequests: LabBoostPlan[], options: LabManagementOptions): LabBoostResult[] {
  return boostRequests.map((boostRequest) => executeBoostPlan(boostRequest, options));
}

function selectPrimaryBoostResult(boosts: LabBoostResult[]): LabBoostResult | undefined {
  return boosts.find((boost) => boost.status === 'boosted' || boost.status === 'moving') ?? boosts[0];
}

function buildBoostPlan(request: LabBoostRequest, labs: StructureLab[]): LabBoostPlan {
  const boostMineralCost = getLabBoostMineralCost();
  const boostEnergyCost = getLabBoostEnergyCost();
  const requiredMineral = request.requestedParts * boostMineralCost;
  const requiredEnergy = request.requestedParts * boostEnergyCost;
  const labsWithResource = labs.filter((lab) => getLabResourceAmount(lab, request.resource) >= boostMineralCost);
  if (labsWithResource.length === 0) {
    return {
      ...request,
      boostParts: 0,
      lab: null,
      reason: 'resourceUnavailable',
      requiredEnergy,
      requiredMineral,
      status: 'blocked'
    };
  }

  const readyLabs = labsWithResource
    .map((lab) => ({
      lab,
      boostParts: getBoostablePartCount(lab, request.resource, request.requestedParts)
    }))
    .filter((candidate) => candidate.boostParts > 0 && getLabCooldown(candidate.lab) <= 0)
    .sort((left, right) => right.boostParts - left.boostParts || compareObjectsById(left.lab, right.lab));
  if (readyLabs.length > 0) {
    return {
      ...request,
      boostParts: readyLabs[0].boostParts,
      lab: readyLabs[0].lab,
      requiredEnergy,
      requiredMineral,
      status: 'ready'
    };
  }

  const hasEnoughEnergy = labsWithResource.some((lab) => getLabEnergy(lab) >= boostEnergyCost);
  return {
    ...request,
    boostParts: 0,
    lab: labsWithResource.sort(compareObjectsById)[0] ?? null,
    reason: hasEnoughEnergy ? 'cooldown' : 'insufficientEnergy',
    requiredEnergy,
    requiredMineral,
    status: 'blocked'
  };
}

function executeBoostPlan(plan: LabBoostPlan, options: LabManagementOptions): LabBoostResult {
  if (plan.status === 'blocked' || !plan.lab) {
    markCreepBoostState(plan.creep, 'blocked');
    return {
      boostParts: 0,
      creepName: plan.creep.name,
      part: plan.part,
      priority: plan.priority,
      reason: plan.reason,
      resource: plan.resource,
      status: 'blocked',
      ...(plan.lab ? { labId: getObjectId(plan.lab) } : {})
    };
  }

  const range = getRangeTo(plan.creep, plan.lab);
  if (range !== null && range > 1) {
    markCreepBoostState(plan.creep, 'moving', plan);
    if (!options.dryRun && typeof plan.creep.moveTo === 'function') {
      plan.creep.moveTo(plan.lab);
    }

    return {
      boostParts: 0,
      creepName: plan.creep.name,
      labId: getObjectId(plan.lab),
      part: plan.part,
      priority: plan.priority,
      reason: 'notInRange',
      resource: plan.resource,
      status: 'moving'
    };
  }

  const result = options.dryRun ? OK_CODE : plan.lab.boostCreep(plan.creep, plan.boostParts);
  markCreepBoostState(plan.creep, result === OK_CODE ? 'complete' : 'blocked', plan);
  return {
    boostParts: result === OK_CODE ? plan.boostParts : 0,
    creepName: plan.creep.name,
    labId: getObjectId(plan.lab),
    part: plan.part,
    priority: plan.priority,
    resource: plan.resource,
    result,
    status: result === OK_CODE ? 'boosted' : 'blocked'
  };
}

function runSelectedReaction(
  room: Room,
  labs: StructureLab[],
  inventory: LabInventory,
  boostPlan: LabBoostPlan | undefined,
  previousRoomMemory: EconomyLabRoomMemory | undefined,
  options: LabManagementOptions
): LabReactionRunResult {
  const target = selectReactionTarget(boostPlan, previousRoomMemory, options);
  if (!target) {
    return { status: 'idle', reason: 'noTarget' };
  }

  const desiredAmount = normalizeNonNegativeInteger(
    options.desiredAmount ?? previousRoomMemory?.reactionDesiredAmount ?? DEFAULT_LAB_REACTION_DESIRED_AMOUNT
  );
  if (getInventoryAmount(inventory, target) >= desiredAmount) {
    return { status: 'complete', reason: 'complete', targetResource: target };
  }

  const chain = planReactionChain(target, inventory, desiredAmount);
  const step = selectNextReactionStep(chain, inventory);
  if (!step) {
    return { status: 'blocked', reason: 'resourceUnavailable', targetResource: target };
  }

  const execution = selectReactionExecution(labs, step);
  if (!execution.outputLab || !execution.sourceLabA || !execution.sourceLabB) {
    const reason = execution.reason === 'none' ? 'outputLabUnavailable' : execution.reason;
    return {
      status: 'blocked',
      reason,
      targetResource: target,
      product: step.product,
      reagents: step.reagents
    };
  }

  const result = options.dryRun
    ? OK_CODE
    : execution.outputLab.runReaction(execution.sourceLabA, execution.sourceLabB);
  return {
    status: result === OK_CODE ? 'running' : 'blocked',
    targetResource: target,
    product: step.product,
    reagents: step.reagents,
    outputLabId: getObjectId(execution.outputLab),
    sourceLabIds: [getObjectId(execution.sourceLabA), getObjectId(execution.sourceLabB)],
    result,
    ...(result === OK_CODE ? {} : { reason: 'resourceUnavailable' as EconomyLabBlockReason })
  };
}

function selectReactionTarget(
  boostPlan: LabBoostPlan | undefined,
  previousRoomMemory: EconomyLabRoomMemory | undefined,
  options: LabManagementOptions
): ResourceConstant | null {
  if (boostPlan?.reason === 'resourceUnavailable') {
    return boostPlan.resource;
  }

  return options.reactionTarget ?? previousRoomMemory?.reactionTarget ?? null;
}

function shouldRunReactionAfterBoost(boosts: LabBoostResult[]): boolean {
  return (
    boosts.length === 0 ||
    boosts.every((boost) => boost.status === 'blocked' && boost.reason === 'resourceUnavailable')
  );
}

function selectBoostReactionPlan(boostRequests: LabBoostPlan[]): LabBoostPlan | undefined {
  return boostRequests.find((boostRequest) => boostRequest.reason === 'resourceUnavailable');
}

function selectNextReactionStep(
  chain: LabReactionChainPlan,
  inventory: LabInventory
): LabReactionStep | null {
  const reactionAmount = getLabReactionAmount();
  return chain.steps.find((step) =>
    getInventoryAmount(inventory, step.product) < chain.desiredAmount &&
    getInventoryAmount(inventory, step.reagents[0]) >= reactionAmount &&
    getInventoryAmount(inventory, step.reagents[1]) >= reactionAmount
  ) ?? null;
}

function selectReactionExecution(
  labs: StructureLab[],
  step: LabReactionStep
): {
  outputLab?: StructureLab;
  reason: EconomyLabBlockReason | 'none';
  sourceLabA?: StructureLab;
  sourceLabB?: StructureLab;
} {
  const sourceLabAs = selectInputLabs(labs, step.reagents[0]);
  const fallbackSourceLabA = sourceLabAs[0];
  if (!fallbackSourceLabA) {
    return { reason: 'inputLabsNeedReagents' };
  }

  let fallbackSourceLabB: StructureLab | undefined;
  let hasCompatibleOutputLab = false;
  for (const sourceLabA of sourceLabAs) {
    const sourceLabBs = selectInputLabs(labs, step.reagents[1], new Set([getObjectId(sourceLabA)]));
    if (!fallbackSourceLabB) {
      fallbackSourceLabB = sourceLabBs[0];
    }
    for (const sourceLabB of sourceLabBs) {
      const excludedIds = new Set([getObjectId(sourceLabA), getObjectId(sourceLabB)]);
      const candidateOutputLabs = labs
        .filter((lab) => !excludedIds.has(getObjectId(lab)) && canLabReceiveResource(lab, step.product))
        .sort(compareObjectsById)
        .filter((outputLab) => areReactionLabsCompatible(sourceLabA, sourceLabB, outputLab));
      if (candidateOutputLabs.length > 0) {
        hasCompatibleOutputLab = true;
      }

      const readyOutputLab = candidateOutputLabs.find((lab) => getLabCooldown(lab) <= 0);
      if (readyOutputLab) {
        return {
          outputLab: readyOutputLab,
          reason: 'none',
          sourceLabA,
          sourceLabB
        };
      }
    }
  }

  if (!fallbackSourceLabB) {
    return { reason: 'inputLabsNeedReagents', sourceLabA: fallbackSourceLabA };
  }

  return {
    reason: hasCompatibleOutputLab ? 'cooldown' : 'outputLabUnavailable',
    sourceLabA: fallbackSourceLabA,
    sourceLabB: fallbackSourceLabB
  };
}

function selectInputLabs(
  labs: StructureLab[],
  reagent: ResourceConstant,
  excludedIds: ReadonlySet<string> = new Set()
): StructureLab[] {
  return labs
    .filter((lab) => !excludedIds.has(getObjectId(lab)) && getLabResourceAmount(lab, reagent) >= getLabReactionAmount())
    .sort(compareObjectsById);
}

function areReactionLabsCompatible(
  sourceLabA: StructureLab,
  sourceLabB: StructureLab,
  outputLab: StructureLab
): boolean {
  return (
    areLabsWithinReactionRange(sourceLabA, sourceLabB) &&
    areLabsWithinReactionRange(sourceLabA, outputLab) &&
    areLabsWithinReactionRange(sourceLabB, outputLab)
  );
}

function areLabsWithinReactionRange(left: StructureLab, right: StructureLab): boolean {
  const range = getLabRangeTo(left, right);
  return range === null || range <= 2;
}

function getLabRangeTo(left: StructureLab, right: StructureLab): number | null {
  const leftPos = (left as { pos?: Pick<RoomPosition, 'getRangeTo'> }).pos;
  const rightPos = (right as { pos?: RoomPosition }).pos;
  if (!leftPos || !rightPos || typeof leftPos.getRangeTo !== 'function') {
    return null;
  }

  const range = leftPos.getRangeTo(right);
  return typeof range === 'number' && Number.isFinite(range) ? range : null;
}

function canLabReceiveResource(lab: StructureLab, resource: ResourceConstant): boolean {
  const mineralType = getLabMineralType(lab);
  if (mineralType && mineralType !== resource && getLabResourceAmount(lab, mineralType) > 0) {
    return false;
  }

  return getLabFreeMineralCapacity(lab, resource) >= getLabReactionAmount();
}

function appendReactionSteps(
  resource: ResourceConstant,
  desiredAmount: number,
  inventory: LabInventory,
  steps: LabReactionStep[],
  missingResources: Array<{ amount: number; resource: ResourceConstant }>,
  seen: Set<ResourceConstant>,
  depth: number
): void {
  const neededAmount = Math.max(0, desiredAmount - getInventoryAmount(inventory, resource));
  if (neededAmount <= 0) {
    return;
  }

  const reagents = findReactionReagents(resource);
  if (!reagents || seen.has(resource)) {
    missingResources.push({ resource, amount: neededAmount });
    return;
  }

  seen.add(resource);
  appendReactionSteps(reagents[0], neededAmount, inventory, steps, missingResources, new Set(seen), depth + 1);
  appendReactionSteps(reagents[1], neededAmount, inventory, steps, missingResources, new Set(seen), depth + 1);
  steps.push({
    amount: neededAmount,
    depth,
    product: resource,
    ready: getInventoryAmount(inventory, reagents[0]) > 0 && getInventoryAmount(inventory, reagents[1]) > 0,
    reagents
  });
}

function findReactionReagents(product: ResourceConstant): [ResourceConstant, ResourceConstant] | null {
  const table = getReactionTable();
  const pairs: Array<[ResourceConstant, ResourceConstant]> = [];
  for (const [left, outputs] of Object.entries(table)) {
    for (const [right, output] of Object.entries(outputs)) {
      if (output === product) {
        pairs.push([left as ResourceConstant, right as ResourceConstant]);
      }
    }
  }

  return pairs.sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`))[0] ?? null;
}

function dedupeReactionSteps(steps: LabReactionStep[]): LabReactionStep[] {
  const byProduct = new Map<ResourceConstant, LabReactionStep>();
  for (const step of steps) {
    const existing = byProduct.get(step.product);
    if (!existing || step.depth > existing.depth) {
      byProduct.set(step.product, step);
    }
  }

  return [...byProduct.values()].sort((left, right) => right.depth - left.depth);
}

function dedupeMissingResources(
  resources: Array<{ amount: number; resource: ResourceConstant }>
): Array<{ amount: number; resource: ResourceConstant }> {
  const byResource = new Map<ResourceConstant, number>();
  for (const missing of resources) {
    byResource.set(missing.resource, Math.max(byResource.get(missing.resource) ?? 0, missing.amount));
  }

  return [...byResource.entries()]
    .map(([resource, amount]) => ({ resource, amount }))
    .sort((left, right) => left.resource.localeCompare(right.resource));
}

function recordLabManagementState(
  room: Room,
  result: LabManagementResult,
  previousRoomMemory: EconomyLabRoomMemory | undefined,
  options: LabManagementOptions
): void {
  const memory = getEconomyMemory();
  const gameTime = getGameTime();
  const rooms = memory.labManagement?.rooms ?? {};
  const reactionMemory = buildReactionMemory(result.reaction, previousRoomMemory?.reaction, result.inventory, gameTime);
  const roomMemory: EconomyLabRoomMemory = {
    roomName: room.name,
    rcl: normalizeNonNegativeInteger(room.controller?.level),
    updatedAt: gameTime,
    labs: result.labs.map((lab) => ({
      id: getObjectId(lab),
      cooldown: getLabCooldown(lab),
      energy: getLabEnergy(lab),
      mineralAmount: getLabMineralType(lab) ? getLabResourceAmount(lab, getLabMineralType(lab) as ResourceConstant) : 0,
      mineralType: getLabMineralType(lab) ?? undefined
    })),
    inventory: serializeInventory(result.inventory),
    boostDemand: result.boostRequests.map((request) => ({
      creepName: request.creep.name,
      part: request.part,
      priority: request.priority,
      requestedParts: request.requestedParts,
      resource: request.resource,
      requiredEnergy: request.requiredEnergy,
      requiredMineral: request.requiredMineral,
      status: request.status,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.lab ? { labId: getObjectId(request.lab) } : {})
    })),
    ...(result.boost ? { activeBoost: buildActiveBoostMemory(result.boost, gameTime) } : {}),
    ...(reactionMemory ? { reaction: reactionMemory } : {}),
    ...(options.reactionTarget ?? previousRoomMemory?.reactionTarget
      ? { reactionTarget: options.reactionTarget ?? previousRoomMemory?.reactionTarget }
      : {}),
    reactionDesiredAmount:
      options.desiredAmount ?? previousRoomMemory?.reactionDesiredAmount ?? DEFAULT_LAB_REACTION_DESIRED_AMOUNT
  };

  memory.labManagement = {
    updatedAt: gameTime,
    rooms: {
      ...rooms,
      [room.name]: roomMemory
    }
  };
}

function buildActiveBoostMemory(boost: LabBoostResult, gameTime: number): EconomyLabActiveBoostMemory {
  return {
    boostParts: boost.boostParts,
    creepName: boost.creepName,
    part: boost.part,
    priority: boost.priority,
    resource: boost.resource,
    status: boost.status,
    updatedAt: gameTime,
    ...(boost.labId ? { labId: boost.labId } : {}),
    ...(boost.reason ? { reason: boost.reason } : {}),
    ...(boost.result !== undefined ? { result: boost.result } : {})
  };
}

function buildReactionMemory(
  reaction: LabReactionRunResult | undefined,
  previousReaction: EconomyLabReactionMemory | undefined,
  inventory: LabInventory,
  gameTime: number
): EconomyLabReactionMemory | undefined {
  if (!reaction || reaction.status === 'idle') {
    return previousReaction;
  }

  const activeProduct = reaction.product ?? reaction.targetResource;
  const previousProducedAmount =
    previousReaction && previousReaction.activeProduct === activeProduct ? previousReaction.producedAmount : 0;
  const producedAmount =
    reaction.status === 'running' && reaction.result === OK_CODE
      ? previousProducedAmount + getLabReactionAmount()
      : previousProducedAmount;
  const reason = reaction.reason === 'noTarget' ? undefined : reaction.reason;

  return {
    status: reaction.status,
    targetResource: reaction.targetResource ?? previousReaction?.targetResource ?? activeProduct ?? 'energy',
    updatedAt: gameTime,
    producedAmount,
    availableAmount: activeProduct ? getInventoryAmount(inventory, activeProduct) : 0,
    ...(activeProduct ? { activeProduct } : {}),
    ...(reaction.reagents ? { reagents: reaction.reagents } : {}),
    ...(reaction.outputLabId ? { outputLabId: reaction.outputLabId } : {}),
    ...(reaction.sourceLabIds ? { sourceLabIds: reaction.sourceLabIds } : {}),
    ...(reason ? { reason } : {}),
    ...(reaction.result !== undefined ? { result: reaction.result } : {})
  };
}

function serializeInventory(inventory: LabInventory): Record<string, number> {
  return Object.fromEntries(
    Object.entries(inventory)
      .filter(([, amount]) => typeof amount === 'number' && amount > 0)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function markCreepBoostState(creep: Creep, boostState: CreepLabBoostState, plan?: LabBoostPlan): void {
  creep.memory.lab = {
    ...creep.memory.lab,
    boostState,
    updatedAt: getGameTime(),
    ...(plan
      ? {
          activeBoost: {
            labId: plan.lab ? getObjectId(plan.lab) : undefined,
            part: plan.part,
            resource: plan.resource
          }
        }
      : {})
  };
}

function normalizeCreepBoostRequests(raw: unknown): CreepLabBoostRequestMemory[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((request) => normalizeCreepBoostRequest(request))
    .filter((request): request is CreepLabBoostRequestMemory => request !== null);
}

function normalizeCreepBoostRequest(raw: unknown): CreepLabBoostRequestMemory | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const candidate = raw as Partial<CreepLabBoostRequestMemory>;
  if (typeof candidate.part !== 'string' || typeof candidate.resource !== 'string') {
    return null;
  }

  return {
    part: candidate.part as BodyPartConstant,
    resource: candidate.resource as MineralBoostConstant,
    ...(candidate.priority === 'controllerUpgrade' || candidate.priority === 'creepBoost'
      ? { priority: candidate.priority }
      : {})
  };
}

function isControllerUpgradeBoostCandidate(creep: Creep): boolean {
  return (
    creep.memory.role === 'upgrader' ||
    creep.memory.controllerUpgrade !== undefined ||
    creep.memory.lab?.boosts?.some((request) => request.priority === 'controllerUpgrade') === true
  );
}

function selectControllerUpgradeBoostResource(inventory: LabInventory): MineralBoostConstant {
  return CONTROLLER_UPGRADE_BOOSTS.find((resource) => getInventoryAmount(inventory, resource) >= getLabBoostMineralCost()) ??
    CONTROLLER_UPGRADE_BOOSTS[0];
}

function countUnboostedBodyParts(creep: Creep, part: BodyPartConstant): number {
  return (creep.body ?? []).filter((bodyPart) => bodyPart.type === part && bodyPart.boost === undefined).length;
}

function getBoostablePartCount(lab: StructureLab, resource: ResourceConstant, requestedParts: number): number {
  return Math.min(
    requestedParts,
    Math.floor(getLabResourceAmount(lab, resource) / getLabBoostMineralCost()),
    Math.floor(getLabEnergy(lab) / getLabBoostEnergyCost())
  );
}

function compareBoostPlans(left: LabBoostPlan, right: LabBoostPlan): number {
  return (
    getBoostPriorityRank(left.priority) - getBoostPriorityRank(right.priority) ||
    getBoostPlanStatusRank(left) - getBoostPlanStatusRank(right) ||
    right.boostParts - left.boostParts ||
    left.creep.name.localeCompare(right.creep.name) ||
    left.resource.localeCompare(right.resource)
  );
}

function compareBoostRequests(left: LabBoostRequest, right: LabBoostRequest): number {
  return (
    getBoostPriorityRank(left.priority) - getBoostPriorityRank(right.priority) ||
    left.creep.name.localeCompare(right.creep.name) ||
    left.resource.localeCompare(right.resource)
  );
}

function getBoostPriorityRank(priority: EconomyLabBoostPriority): number {
  return priority === 'controllerUpgrade' ? 0 : 1;
}

function getBoostPlanStatusRank(plan: LabBoostPlan): number {
  if (plan.status === 'ready') {
    return 0;
  }

  return plan.reason === 'resourceUnavailable' ? 1 : 2;
}

function getRangeTo(creep: Creep, target: RoomObject): number | null {
  const getRangeTo = creep.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return null;
  }

  const range = getRangeTo.call(creep.pos, target);
  return typeof range === 'number' && Number.isFinite(range) ? range : null;
}

function findRoomObjects<T>(room: Room | undefined, globalConstantName: string): T[] {
  if (!room || typeof room.find !== 'function') {
    return [];
  }

  const findConstant = (globalThis as Record<string, unknown>)[globalConstantName];
  if (typeof findConstant !== 'number') {
    return [];
  }

  return room.find(findConstant as FindConstant) as T[];
}

function isLabStructure(structure: Structure): structure is StructureLab {
  return matchesStructureType(structure.structureType, 'STRUCTURE_LAB', 'lab');
}

function matchesStructureType(
  structureType: StructureConstant | string | undefined,
  globalConstantName: string,
  fallback: string
): boolean {
  const globalConstant = (globalThis as Record<string, unknown>)[globalConstantName];
  return structureType === globalConstant || structureType === fallback;
}

function getLabResourceAmount(lab: StructureLab, resource: ResourceConstant): number {
  const storeAmount = getStoredResourceAmount(lab, resource);
  if (storeAmount > 0) {
    return storeAmount;
  }

  if (resource === getEnergyResource()) {
    return normalizeNonNegativeInteger((lab as StructureLab & { energy?: unknown }).energy);
  }

  if (getLabMineralType(lab) === resource) {
    return normalizeNonNegativeInteger((lab as StructureLab & { mineralAmount?: unknown }).mineralAmount);
  }

  return 0;
}

function getStoredResourceAmount(target: unknown, resource: ResourceConstant): number {
  const store = getStore(target);
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, Math.floor(usedCapacity));
  }

  const directAmount = store?.[resource];
  return normalizeNonNegativeInteger(directAmount);
}

function getLabFreeMineralCapacity(lab: StructureLab, resource: ResourceConstant): number {
  const store = getStore(lab);
  const freeCapacity = store?.getFreeCapacity?.(resource);
  if (typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)) {
    return Math.max(0, Math.floor(freeCapacity));
  }

  const capacity = store?.getCapacity?.(resource);
  if (typeof capacity === 'number' && Number.isFinite(capacity)) {
    return Math.max(0, Math.floor(capacity) - getLabResourceAmount(lab, resource));
  }

  const mineralCapacity = normalizeNonNegativeInteger((lab as StructureLab & { mineralCapacity?: unknown }).mineralCapacity);
  if (mineralCapacity > 0) {
    return Math.max(0, mineralCapacity - getLabResourceAmount(lab, resource));
  }

  return Math.max(0, DEFAULT_LAB_MINERAL_CAPACITY - getLabResourceAmount(lab, resource));
}

function getLabEnergy(lab: StructureLab): number {
  return getLabResourceAmount(lab, getEnergyResource());
}

function getLabMineralType(lab: StructureLab): ResourceConstant | null {
  const mineralType = (lab as StructureLab & { mineralType?: unknown }).mineralType;
  return typeof mineralType === 'string' && mineralType.length > 0 ? (mineralType as ResourceConstant) : null;
}

function getLabCooldown(lab: StructureLab): number {
  return normalizeNonNegativeInteger((lab as StructureLab & { cooldown?: unknown }).cooldown);
}

function addStoreInventory(inventory: LabInventory, target: unknown): void {
  const store = getStore(target);
  if (!store) {
    return;
  }

  for (const key of Object.keys(store)) {
    if (key === 'getUsedCapacity' || key === 'getFreeCapacity' || key === 'getCapacity') {
      continue;
    }

    addResourceAmount(inventory, key as ResourceConstant, normalizeNonNegativeInteger(store[key]));
  }
}

function addResourceAmount(inventory: LabInventory, resource: ResourceConstant, amount: number): void {
  const normalizedAmount = normalizeNonNegativeInteger(amount);
  if (normalizedAmount <= 0) {
    return;
  }

  inventory[resource] = getInventoryAmount(inventory, resource) + normalizedAmount;
}

function getInventoryAmount(inventory: LabInventory, resource: ResourceConstant): number {
  return normalizeNonNegativeInteger(inventory[resource]);
}

function getStore(target: unknown): LabStoreLike | undefined {
  return (target as { store?: LabStoreLike } | null)?.store;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getLabBoostEnergyCost(): number {
  return getGlobalPositiveInteger('LAB_BOOST_ENERGY', DEFAULT_LAB_BOOST_ENERGY);
}

function getLabBoostMineralCost(): number {
  return getGlobalPositiveInteger('LAB_BOOST_MINERAL', DEFAULT_LAB_BOOST_MINERAL);
}

function getLabReactionAmount(): number {
  return getGlobalPositiveInteger('LAB_REACTION_AMOUNT', DEFAULT_LAB_REACTION_AMOUNT);
}

function getGlobalPositiveInteger(globalName: string, fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[globalName];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getReactionTable(): ReactionTable {
  const globalReactionTable = (globalThis as { REACTIONS?: ReactionTable }).REACTIONS;
  return globalReactionTable ?? buildFallbackReactionTable();
}

function buildFallbackReactionTable(): ReactionTable {
  const table: ReactionTable = {};
  for (const [left, right, product] of FALLBACK_REACTION_PAIRS) {
    if (!table[left]) {
      table[left] = {};
    }
    if (!table[right]) {
      table[right] = {};
    }
    table[left][right] = product;
    table[right][left] = product;
  }

  return table;
}

function getExistingLabRoomMemory(roomName: string): EconomyLabRoomMemory | undefined {
  return getEconomyMemory().labManagement?.rooms?.[roomName];
}

function getEconomyMemory(): EconomyMemory {
  const memory = getMemory();
  if (!memory.economy) {
    memory.economy = {};
  }

  return memory.economy;
}

function getMemory(): Partial<Memory> {
  const global = globalThis as unknown as { Memory?: Partial<Memory> };
  if (!global.Memory) {
    global.Memory = {};
  }

  return global.Memory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return normalizeNonNegativeInteger(gameTime);
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  return typeof candidate.name === 'string' ? candidate.name : '';
}

function compareObjectsById(left: unknown, right: unknown): number {
  return getObjectId(left).localeCompare(getObjectId(right));
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
