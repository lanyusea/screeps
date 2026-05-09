export {};

declare global {
  interface Memory {
    meta: {
      version: number;
    };
    defense?: DefenseMemory;
    scout?: Record<string, unknown>;
    enableMarketTrading?: boolean;
    economy?: EconomyMemory;
    territory?: TerritoryMemory;
    strategyRollback?: Record<
      string,
      {
        disabledId: string;
        rollbackToId: string;
        timestamp: number;
        reason: string;
      }
    >;
    strategyRollbackHistory?: Array<{
      family: string;
      disabledId: string;
      rollbackToId: string;
      timestamp: number;
      reason: string;
    }>;
    kpiBaseline?: Record<
      string,
      {
        timestamp: number;
        metrics: Record<string, number>;
      }
    >;
  }

  interface CreepMemory {
    role?: string;
    colony?: string;
    task?: CreepTaskMemory;
    workerTaskSelectionNullLoop?: WorkerTaskSelectionNullLoopMemory;
    defense?: CreepDefenseMemory;
    territory?: CreepTerritoryMemory;
    controllerSustain?: CreepControllerSustainMemory;
    controllerUpgrade?: CreepControllerUpgradeMemory;
    sourceHarvester?: CreepSourceHarvesterMemory;
    remoteHarvester?: CreepRemoteHarvesterMemory;
    remoteHauler?: CreepRemoteHaulerMemory;
    energyHauler?: CreepEnergyHaulerMemory;
    workerEfficiency?: WorkerEfficiencySampleMemory;
    refillTelemetry?: WorkerRefillTelemetryMemory;
    constructionPreBuffer?: WorkerConstructionPreBufferMemory;
    interRoomEnergyHaul?: CreepInterRoomEnergyHaulMemory;
    spawnCriticalRefill?: WorkerSpawnCriticalRefillMemory;
    workerBehavior?: WorkerTaskBehaviorSampleMemory;
    workerTaskPolicyShadow?: WorkerTaskPolicyShadowMemory;
    workerEnergyCriticalPolicy?: WorkerEnergyCriticalPolicyMemory;
    energyDropoffOptimization?: WorkerEnergyDropoffOptimizationMemory;
    behaviorTelemetry?: CreepBehaviorTelemetryMemory;
    crossRoomHauler?: CreepCrossRoomHaulerMemory;
    spawnSupport?: CreepSpawnSupportMemory;
    mineralHarvester?: CreepMineralHarvesterMemory;
    lab?: CreepLabMemory;
  }

  type DefenseActionType =
    | 'towerAttack'
    | 'towerHeal'
    | 'towerRepair'
    | 'safeMode'
    | 'defenderAttack'
    | 'defenderMove'
    | 'workerFallback';
  type DefenseUnsafeRoomReason = 'enemyTower' | 'hostilePresence';
  type DefenseThreatLevel = 'none' | 'hostile_present' | 'under_attack';
  type TerritoryIntentSuppressionReason = 'deadZoneTarget' | 'deadZoneRoute';

  interface DefenseMemory {
    actions?: DefenseActionMemory[];
    rooms?: Record<string, DefenseActionMemory>;
    unsafeRooms?: Record<string, DefenseUnsafeRoomMemory>;
    colonyThreats?: DefenseColonyThreatMemory;
  }

  interface DefenseActionMemory {
    type: DefenseActionType;
    roomName: string;
    tick: number;
    reason: string;
    hostileCreepCount: number;
    hostileStructureCount: number;
    damagedCriticalStructureCount: number;
    structureId?: string;
    targetId?: string;
    result?: ScreepsReturnCode;
  }

  interface DefenseUnsafeRoomMemory {
    roomName: string;
    unsafe: true;
    reason: DefenseUnsafeRoomReason;
    updatedAt: number;
    hostileCreepCount: number;
    hostileStructureCount: number;
    hostileTowerCount: number;
  }

  interface DefenseColonyThreatMemory {
    updatedAt: number;
    rooms: Record<string, DefenseColonyThreatRoomMemory>;
  }

  interface DefenseColonyThreatRoomMemory {
    roomName: string;
    level: DefenseThreatLevel;
    updatedAt: number;
    hostileCreepCount: number;
    hostileStructureCount: number;
    damagedCriticalStructureCount: number;
  }

  interface CreepDefenseMemory {
    homeRoom: string;
  }

  interface WorkerEnergyDropoffOptimizationMemory {
    sourceTask: WorkerEnergyDropoffOptimizationTaskRef;
    optimizedTask: WorkerEnergyDropoffOptimizationTaskRef;
  }

  interface WorkerEnergyDropoffOptimizationTaskRef {
    type: CreepTaskMemory['type'];
    targetId: string;
  }

  type CreepControllerSustainRole = 'upgrader' | 'hauler';
  type ControllerUpgradePriority =
    | 'none'
    | 'downgradeGuard'
    | 'rcl1Rush'
    | 'rclProgress'
    | 'energySurplus'
    | 'steady'
    | 'fallback';

  interface CreepControllerSustainMemory {
    homeRoom: string;
    targetRoom: string;
    role: CreepControllerSustainRole;
  }

  interface CreepControllerUpgradeMemory {
    roomName: string;
    controllerId: Id<StructureController>;
    priority: ControllerUpgradePriority;
    assignedAt?: number;
  }

  interface CreepSourceHarvesterMemory {
    roomName: string;
    sourceId: Id<Source>;
    containerId: Id<StructureContainer>;
  }

  interface CreepRemoteHarvesterMemory {
    homeRoom: string;
    targetRoom: string;
    sourceId: Id<Source>;
    containerId?: Id<StructureContainer>;
  }

  interface CreepRemoteHaulerMemory {
    homeRoom: string;
    targetRoom: string;
    sourceId: Id<Source>;
    containerId: Id<StructureContainer>;
  }

  interface CreepEnergyHaulerMemory {
    roomName: string;
  }

  interface CreepInterRoomEnergyHaulMemory {
    sourceRoom: string;
    targetRoom: string;
    sourceId?: Id<AnyStoreStructure>;
    targetId?: Id<AnyStoreStructure>;
    updatedAt?: number;
  }

  interface EconomyMemory {
    sourceWorkloads?: Record<string, EconomyRoomSourceWorkloadMemory>;
    storageBalance?: EconomyStorageBalanceMemory;
    energyIndependence?: EconomyEnergyIndependenceMemory;
    terminalLogistics?: EconomyTerminalLogisticsMemory;
    marketTrading?: EconomyMarketTradingMemory;
    energySurplus?: EconomyEnergySurplusMemory;
    multiRoomEnergy?: EconomyMultiRoomEnergyMemory;
    spawnEnergyBuffer?: EconomySpawnEnergyBufferMemory;
    spawnEnergyReservation?: EconomySpawnEnergyReservationMemory;
    labManagement?: EconomyLabManagementMemory;
  }

  type CreepLabBoostState = 'moving' | 'complete' | 'blocked';
  type EconomyLabBoostPriority = 'controllerUpgrade' | 'creepBoost';
  type EconomyLabBlockReason =
    | 'resourceUnavailable'
    | 'insufficientEnergy'
    | 'cooldown'
    | 'inputLabsNeedReagents'
    | 'outputLabUnavailable';

  interface CreepLabMemory {
    boosts?: CreepLabBoostRequestMemory[];
    boostState?: CreepLabBoostState;
    updatedAt?: number;
    activeBoost?: CreepLabActiveBoostMemory;
  }

  interface CreepLabBoostRequestMemory {
    part: BodyPartConstant;
    resource: MineralBoostConstant;
    priority?: EconomyLabBoostPriority;
  }

  interface CreepLabActiveBoostMemory {
    labId?: string;
    part: BodyPartConstant;
    resource: MineralBoostConstant;
  }

  interface EconomyLabManagementMemory {
    updatedAt: number;
    rooms: Record<string, EconomyLabRoomMemory>;
  }

  interface EconomyLabRoomMemory {
    roomName: string;
    rcl: number;
    updatedAt: number;
    labs: EconomyLabStructureMemory[];
    inventory: Record<string, number>;
    boostDemand: EconomyLabBoostDemandMemory[];
    activeBoost?: EconomyLabActiveBoostMemory;
    reaction?: EconomyLabReactionMemory;
    reactionTarget?: ResourceConstant;
    reactionDesiredAmount?: number;
  }

  interface EconomyLabStructureMemory {
    id: string;
    cooldown: number;
    energy: number;
    mineralAmount: number;
    mineralType?: ResourceConstant;
  }

  interface EconomyLabBoostDemandMemory {
    creepName: string;
    labId?: string;
    part: BodyPartConstant;
    priority: EconomyLabBoostPriority;
    requestedParts: number;
    requiredEnergy: number;
    requiredMineral: number;
    resource: MineralBoostConstant;
    reason?: EconomyLabBlockReason;
    status: 'ready' | 'blocked';
  }

  interface EconomyLabActiveBoostMemory {
    boostParts: number;
    creepName: string;
    labId?: string;
    part: BodyPartConstant;
    priority: EconomyLabBoostPriority;
    reason?: EconomyLabBlockReason | 'notInRange';
    resource: MineralBoostConstant;
    result?: ScreepsReturnCode;
    status: 'boosted' | 'blocked' | 'moving';
    updatedAt: number;
  }

  interface EconomyLabReactionMemory {
    activeProduct?: ResourceConstant;
    availableAmount: number;
    outputLabId?: string;
    producedAmount: number;
    reagents?: [ResourceConstant, ResourceConstant];
    reason?: EconomyLabBlockReason | 'complete';
    result?: ScreepsReturnCode;
    sourceLabIds?: [string, string];
    status: 'running' | 'blocked' | 'complete';
    targetResource: ResourceConstant;
    updatedAt: number;
  }

  interface EconomySpawnEnergyReservationMemory {
    updatedAt: number;
    rooms: Record<string, EconomySpawnEnergyReservationRoomMemory>;
  }

  interface EconomySpawnEnergyReservationRoomMemory {
    bodyCost: number;
    creepName: string;
    idleSince?: number;
    idleTicks?: number;
    reservedAt: number;
    reservedEnergy: number;
    role: string;
    roomName: string;
    sourceCreepName?: string;
    sourceRole?: string;
    updatedAt: number;
  }

  interface EconomySpawnEnergyBufferMemory {
    updatedAt: number;
    rooms: Record<string, EconomySpawnEnergyBufferRoomMemory>;
  }

  interface EconomySpawnEnergyBufferRoomMemory {
    baseThresholdPerSpawn?: number;
    currentEnergy: number;
    healthy: boolean;
    minimumEnergyPerSpawn?: number;
    minerOutputBufferCredit?: number;
    minerOutputEnergyPerTick?: number;
    rcl: number;
    reservedEnergy?: number;
    roomName: string;
    spawnCount: number;
    spawns: Record<string, EconomySpawnEnergyBufferSpawnMemory>;
    threshold: number;
    thresholdPerSpawn: number;
    unmetReservedEnergy?: number;
    updatedAt: number;
  }

  interface EconomySpawnEnergyBufferSpawnMemory {
    energy: number;
    id: string;
    name: string;
    threshold: number;
    withdrawableEnergy: number;
  }

  type EconomyStorageBalanceMode = 'export' | 'import' | 'balanced';

  interface EconomyStorageBalanceMemory {
    updatedAt: number;
    rooms: Record<string, EconomyStorageBalanceRoomMemory>;
    transfers: EconomyStorageTransferMemory[];
  }

  interface EconomyStorageBalanceRoomMemory {
    roomName: string;
    mode: EconomyStorageBalanceMode;
    energy: number;
    capacity: number;
    ratio: number;
    exportableEnergy: number;
    importDemand: number;
    reservedSpawnEnergy?: number;
    unmetSpawnEnergyReservation?: number;
    storageEnergy?: number;
    storageCapacity?: number;
    storageFreeCapacity?: number;
    terminalEnergy?: number;
    terminalCapacity?: number;
    terminalFreeCapacity?: number;
    terminalTargetEnergy?: number;
    terminalEnergyDeficit?: number;
    terminalEnergySurplus?: number;
    updatedAt: number;
  }

  interface EconomyStorageTransferMemory {
    sourceRoom: string;
    targetRoom: string;
    amount: number;
    updatedAt: number;
  }

  type EconomyMultiRoomEnergyBottleneck =
    | 'local-first-sufficient'
    | 'insufficient-exportable-energy'
    | 'no-exporter';

  type EconomyMultiRoomEnergyTransferStatus = 'planned' | 'suppressed' | 'blocked';

  type EconomyMultiRoomEnergyTransferReason =
    | 'storage-balance'
    | 'local-first-sufficient'
    | 'local-first-policy'
    | 'insufficient-exportable-energy'
    | 'no-exporter';

  interface EconomyMultiRoomEnergyMemory {
    updatedAt: number;
    corridor: string[];
    rooms: Record<string, EconomyMultiRoomEnergyRoomMemory>;
    transfers: EconomyMultiRoomEnergyTransferMemory[];
  }

  interface EconomyMultiRoomEnergyRoomMemory {
    roomName: string;
    mode: EconomyStorageBalanceMode;
    storedEnergy: number;
    storageCapacity: number;
    storageRatio: number;
    importDemand: number;
    exportableEnergy: number;
    plannedImportEnergy: number;
    plannedExportEnergy: number;
    localProductionEnergyPerTick: number;
    localHarvestCapacityEnergyPerTick: number;
    localHarvestCoverageRatio: number;
    localConsumptionEnergyPerTick: number;
    netLocalEnergyPerTick: number;
    spawnEnergyAvailable: number;
    spawnEnergyCapacity: number;
    spawnEnergyDeficit: number;
    storageDeficit: number;
    deficitEnergy: number;
    surplusEnergy: number;
    suppressedImportEnergy: number;
    blockedImportEnergy: number;
    bottleneck?: EconomyMultiRoomEnergyBottleneck;
    updatedAt: number;
  }

  interface EconomyMultiRoomEnergyTransferMemory {
    sourceRoom?: string;
    targetRoom: string;
    amount: number;
    status: EconomyMultiRoomEnergyTransferStatus;
    reason: EconomyMultiRoomEnergyTransferReason;
    updatedAt: number;
  }

  interface EconomyEnergyIndependenceMemory {
    rooms?: Record<string, EconomyEnergyIndependenceRoomMemory>;
  }

  interface EconomyEnergyIndependenceRoomMemory {
    enabled?: boolean;
    importThreshold?: number;
    sourceRooms?: string[];
    harvestCoverageRatio?: number;
    sourceWorkloadFreshTicks?: number;
    spawnCollapseEnergyThreshold?: number;
  }

  interface EconomyTerminalLogisticsMemory {
    updatedAt: number;
    rooms: Record<string, EconomyTerminalLogisticsRoomMemory>;
    transfers: EconomyTerminalTransferMemory[];
  }

  interface EconomyTerminalLogisticsRoomMemory {
    roomName: string;
    terminalId?: string;
    energy: number;
    freeCapacity: number;
    cooldown: number;
    projectedCooldown?: number;
    availableAt?: number;
    updatedAt: number;
  }

  interface EconomyTerminalTransferMemory {
    sourceRoom: string;
    targetRoom: string;
    amount: number;
    energyCost: number;
    distance: number;
    cooldown: number;
    availableAt: number;
    result: ScreepsReturnCode;
    description: string;
    updatedAt: number;
  }

  type EconomyMarketTradeAction = 'buy' | 'sell';
  type EconomyMarketTradeReason = 'buyNeeded' | 'sellExcess';

  interface EconomyMarketTradingMemory {
    updatedAt: number;
    nextRunAt: number;
    rooms: Record<string, EconomyMarketTradingRoomMemory>;
    lastDeal?: EconomyMarketDealMemory;
    skippedReason?: string;
  }

  interface EconomyMarketTradingRoomMemory {
    roomName: string;
    terminalId?: string;
    credits: number;
    cooldown: number;
    energyBudget: number;
    terminalEnergy: number;
    terminalFreeCapacity: number;
    neededResources: Record<string, number>;
    excessResources: Record<string, number>;
    availableAt?: number;
    updatedAt: number;
  }

  interface EconomyMarketDealMemory {
    action: EconomyMarketTradeAction;
    amount: number;
    availableAt: number;
    cooldown: number;
    creditsDelta: number;
    energyCost: number;
    expectedProfit: number;
    orderId: string;
    price: number;
    reason: EconomyMarketTradeReason;
    referenceOrderId?: string;
    referencePrice: number;
    resourceType: MarketResourceConstant;
    result: ScreepsReturnCode;
    roomName: string;
    spread: number;
    updatedAt: number;
  }

  interface EconomyEnergySurplusMemory {
    updatedAt: number;
    rooms: Record<string, EconomyEnergySurplusRoomMemory>;
  }

  interface EconomyEnergySurplusRoomMemory {
    roomName: string;
    surplus: boolean;
    spawnExtensionsFull: boolean;
    containersFull: boolean;
    reservedSpawnEnergy?: number;
    unmetSpawnEnergyReservation?: number;
    spawnExtensionFreeCapacity: number;
    containerFreeCapacity: number;
    durableFreeCapacity: number;
    storageEnergy: number;
    storageFreeCapacity: number;
    terminalEnergy: number;
    terminalFreeCapacity: number;
    terminalTargetEnergy: number;
    terminalEnergyDeficit: number;
    terminalEnergySurplus: number;
    selectedSinkId?: string;
    selectedSinkType?: 'storage' | 'terminal';
    updatedAt: number;
  }

  interface CreepCrossRoomHaulerMemory {
    homeRoom: string;
    targetRoom: string;
    sourceId?: Id<AnyStoreStructure> | null;
    state?: 'collecting' | 'delivering' | 'returning' | 'unassigned';
    route?: string[];
  }

  interface CreepSpawnSupportMemory {
    originRoom: string;
    targetRoom: string;
  }

  interface CreepMineralHarvesterMemory {
    homeRoom: string;
    mineralId: Id<Mineral>;
    mineralAmount?: number;
    mineralType?: ResourceConstant;
    targetId: Id<AnyStoreStructure>;
  }

  interface EconomyRoomSourceWorkloadMemory {
    updatedAt: number;
    sources: Record<string, EconomySourceWorkloadMemory>;
  }

  interface EconomySourceWorkloadMemory {
    sourceId: string;
    assignedHarvesters: number;
    assignedWorkParts: number;
    openPositions: number;
    harvestWorkCapacity: number;
    harvestEnergyPerTick: number;
    regenEnergyPerTick: number;
    sourceEnergyCapacity: number;
    sourceEnergyRegenTicks: number;
    hasContainer: boolean;
    containerId?: string;
  }

  type TerritoryControlAction = 'claim' | 'reserve';
  type TerritoryIntentAction = TerritoryControlAction | 'scout';
  type TerritoryDemandType = 'followUpPreparation';
  type TerritoryFollowUpSource = 'satisfiedClaimAdjacent' | 'satisfiedReserveAdjacent' | 'activeReserveAdjacent';
  type TerritoryAutomationSource =
    | 'occupationRecommendation'
    | 'autonomousExpansionClaim'
    | 'colonyExpansion'
    | 'expansionPlanner'
    | 'nextExpansionScoring'
    | 'adjacentRoomReservation';
  type TerritoryIntentSuspensionReason = 'hostile_presence';
  type TerritoryScoutAttemptStatus = 'requested' | 'observed' | 'timedOut';
  type TerritoryScoutValidationStatus = 'pending' | 'passed' | 'blocked' | 'fallback';
  type TerritoryScoutValidationReason =
    | 'intelMissing'
    | 'scoutPending'
    | 'scoutTimeout'
    | 'controllerMissing'
    | 'controllerOwned'
    | 'controllerReserved'
    | 'hostilePresence'
    | 'hostileSpawn'
    | 'sourcesMissing';
  type TerritoryExpansionCandidateEvidenceStatus = 'sufficient' | 'insufficient-evidence' | 'unavailable';
  type TerritoryExpansionCandidateRecommendedAction = 'claim' | 'reserve' | 'scout';
  type TerritoryExpansionPipelineStage = 'scouting' | 'reserving' | 'claiming' | 'bootstrapping';
  type TerritoryExpansionPipelineStatus = 'active' | 'aborted' | 'completed';
  type TerritoryExpansionClaimState = 'scouted' | 'claiming' | 'claimed';
  type TerritoryExpansionAbortReason =
    | 'homeUnstable'
    | 'existingExpansion'
    | 'scoreBelowThreshold'
    | 'scoutTimedOut'
    | 'controllerMissing'
    | 'controllerOwned'
    | 'controllerReserved'
    | 'reservationLost'
    | 'targetHostile'
    | 'sourcesMissing';
  type TerritoryPostClaimBootstrapStatus =
    | 'detected'
    | 'spawnSitePending'
    | 'spawnSiteBlocked'
    | 'spawningWorkers'
    | 'ready';
  type TerritoryExecutionHintReason =
    | 'controlEvidenceStillMissing'
    | 'followUpTargetStillUnseen'
    | 'visibleControlEvidenceStillActionable';
  type RoomExpansionSelectionStatus = 'planned' | 'skipped';
  type RoomExpansionSelectionReason =
    | 'noCandidate'
    | 'gclInsufficient'
    | 'roomLimitReached'
    | 'unmetPreconditions'
    | 'insufficientEvidence'
    | 'unavailable';

  interface RoomMemory {
    lastExpansionScoreTime?: number;
    cachedExpansionSelection?: RoomExpansionSelectionMemory;
    colonyStage?: RoomColonyStageMemory;
    spawnEnergyBuffer?: RoomSpawnEnergyBufferConfigMemory;
  }

  interface RoomSpawnEnergyBufferConfigMemory {
    minimumEnergyPerSpawn?: number;
  }

  interface RoomColonyStageMemory {
    mode: 'BOOTSTRAP' | 'LOCAL_STABLE' | 'TERRITORY_READY' | 'DEFENSE';
    updatedAt: number;
    suppressionReasons?: Array<
      | 'bootstrapWorkerFloor'
      | 'spawnEnergyCritical'
      | 'bootstrapRecovery'
      | 'localWorkerRecovery'
      | 'controllerDowngradeGuard'
      | 'territoryEnergyCapacity'
      | 'controllerLevel'
      | 'defense'
    >;
  }

  interface RoomExpansionSelectionMemory {
    status: RoomExpansionSelectionStatus;
    colony: string;
    reason?: RoomExpansionSelectionReason;
    targetRoom?: string;
    controllerId?: Id<StructureController>;
    score?: number;
    stateKey?: string;
  }

  interface TerritoryMemory {
    targets?: TerritoryTargetMemory[];
    intents?: TerritoryIntentMemory[];
    demands?: TerritoryFollowUpDemandMemory[];
    executionHints?: TerritoryExecutionHintMemory[];
    claimedRoomBootstrapper?: TerritoryClaimedRoomBootstrapperMemory;
    postClaimBootstraps?: Record<string, TerritoryPostClaimBootstrapMemory>;
    remoteMining?: Record<string, TerritoryRemoteMiningRoomMemory>;
    reservations?: Record<string, TerritoryReservationMemory>;
    controllers?: Record<string, TerritoryControllerManagementMemory>;
    scoutAttempts?: Record<string, TerritoryScoutAttemptMemory>;
    scoutIntel?: Record<string, TerritoryScoutIntelMemory>;
    expansionCandidates?: TerritoryExpansionCandidateMemory[];
    expansionPipelines?: Record<string, TerritoryExpansionPipelineMemory>;
    expansionReevaluations?: Record<string, TerritoryExpansionReevaluationMemory>;
    routeDistancesUpdatedAt?: Record<string, number>;
    routeDistances?: Record<string, number | null>;
  }

  interface TerritoryTargetMemory {
    colony: string;
    roomName: string;
    action: TerritoryControlAction;
    controllerId?: Id<StructureController>;
    enabled?: boolean;
    createdBy?: TerritoryAutomationSource;
    postClaimBootstrapReserveEnergy?: number;
  }

  interface TerritoryIntentMemory {
    colony: string;
    targetRoom: string;
    action: TerritoryIntentAction;
    status: 'planned' | 'active' | 'suppressed' | 'inactive' | 'completed';
    updatedAt: number;
    createdBy?: TerritoryAutomationSource;
    reason?: TerritoryIntentSuppressionReason;
    lastAttemptAt?: number;
    controllerId?: Id<StructureController>;
    requiresControllerPressure?: boolean;
    followUp?: TerritoryFollowUpMemory;
    postClaimBootstrapReserveEnergy?: number;
    suspended?: TerritoryIntentSuspensionMemory;
  }

  interface TerritoryIntentSuspensionMemory {
    reason: TerritoryIntentSuspensionReason;
    hostileCount: number;
    updatedAt: number;
  }

  interface TerritoryReservationMemory {
    colony: string;
    roomName: string;
    ticksToEnd: number;
    updatedAt: number;
    controllerId?: Id<StructureController>;
  }

  interface TerritoryControllerManagementMemory {
    roomName: string;
    controllerId: Id<StructureController>;
    signNeeded: boolean;
    upgradePriority: ControllerUpgradePriority;
    desiredUpgraderCount: number;
    activeUpgraderCount: number;
    updatedAt: number;
    progressRatio?: number;
    ticksToDowngrade?: number;
    spawnDemand?: TerritoryControllerUpgradeDemandMemory;
  }

  interface TerritoryControllerUpgradeDemandMemory {
    controllerId: Id<StructureController>;
    priority: ControllerUpgradePriority;
    desiredUpgraderCount: number;
    activeUpgraderCount: number;
  }

  interface TerritoryScoutControllerIntelMemory {
    id?: Id<StructureController>;
    my?: boolean;
    ownerUsername?: string;
    reservationUsername?: string;
    reservationTicksToEnd?: number;
  }

  interface TerritoryScoutMineralIntelMemory {
    id: string;
    mineralType?: string;
    density?: number;
  }

  interface TerritoryExpansionMineralEvidenceMemory {
    mineralType?: string;
    density?: number;
  }

  interface TerritoryTerrainQualityMemory {
    walkableRatio: number;
    swampRatio: number;
    wallRatio: number;
  }

  interface TerritoryScoutSourceIntelMemory {
    id: string;
    x: number;
    y: number;
    accessPoints?: number;
  }

  interface TerritoryScoutValidationMemory {
    status: TerritoryScoutValidationStatus;
    updatedAt: number;
    reason?: TerritoryScoutValidationReason;
  }

  interface TerritoryScoutAttemptMemory {
    colony: string;
    roomName: string;
    status: TerritoryScoutAttemptStatus;
    requestedAt: number;
    updatedAt: number;
    attemptCount: number;
    controllerId?: Id<StructureController>;
    scoutName?: string;
    lastValidation?: TerritoryScoutValidationMemory;
  }

  interface TerritoryScoutIntelMemory {
    colony: string;
    roomName: string;
    updatedAt: number;
    controller?: TerritoryScoutControllerIntelMemory;
    sourceIds: string[];
    sourceCount: number;
    sourcePositions?: TerritoryScoutSourceIntelMemory[];
    sourceAccessPoints?: number;
    controllerSourceRange?: number;
    terrain?: TerritoryTerrainQualityMemory;
    mineral?: TerritoryScoutMineralIntelMemory;
    hostileCreepCount: number;
    hostileStructureCount: number;
    hostileSpawnCount: number;
    scoutName?: string;
  }

  interface TerritoryExpansionCandidateMemory {
    colony: string;
    roomName: string;
    rank: number;
    score: number;
    evidenceStatus: TerritoryExpansionCandidateEvidenceStatus;
    visible: boolean;
    updatedAt: number;
    adjacentToOwnedRoom: boolean;
    recommendedAction?: TerritoryExpansionCandidateRecommendedAction;
    routeDistance?: number;
    nearestOwnedRoom?: string;
    nearestOwnedRoomDistance?: number;
    controllerId?: Id<StructureController>;
    sourceCount?: number;
    sourceAccessPoints?: number;
    controllerSourceRange?: number;
    terrain?: TerritoryTerrainQualityMemory;
    mineral?: TerritoryExpansionMineralEvidenceMemory;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    requiresControllerPressure?: boolean;
    risks?: string[];
    preconditions?: string[];
    rationale?: string[];
  }

  interface TerritoryExpansionPipelineMemory {
    colony: string;
    targetRoom: string;
    status: TerritoryExpansionPipelineStatus;
    stage: TerritoryExpansionPipelineStage;
    claimState?: TerritoryExpansionClaimState;
    score: number;
    threshold: number;
    startedAt: number;
    updatedAt: number;
    controllerId?: Id<StructureController>;
    reservationConfirmedAt?: number;
    claimedAt?: number;
    completedAt?: number;
    abortReason?: TerritoryExpansionAbortReason;
    abortedAt?: number;
  }

  interface TerritoryExpansionReevaluationMemory {
    colony: string;
    roomName: string;
    reason: TerritoryExpansionAbortReason;
    updatedAt: number;
    score?: number;
  }

  interface TerritoryFollowUpMemory {
    source: TerritoryFollowUpSource;
    originRoom: string;
    originAction: TerritoryControlAction;
  }

  interface TerritoryFollowUpDemandMemory {
    type: TerritoryDemandType;
    colony: string;
    targetRoom: string;
    action: TerritoryControlAction;
    workerCount: number;
    updatedAt: number;
    followUp: TerritoryFollowUpMemory;
  }

  interface TerritoryExecutionHintMemory {
    type: 'activeFollowUpExecution';
    colony: string;
    targetRoom: string;
    action: TerritoryIntentAction;
    reason: TerritoryExecutionHintReason;
    updatedAt: number;
    controllerId?: Id<StructureController>;
    followUp: TerritoryFollowUpMemory;
  }

  interface TerritoryPostClaimBootstrapSpawnSiteMemory {
    roomName: string;
    x: number;
    y: number;
  }

  interface TerritoryPostClaimBootstrapMemory {
    colony: string;
    roomName: string;
    status: TerritoryPostClaimBootstrapStatus;
    claimedAt: number;
    updatedAt: number;
    workerTarget: number;
    controllerId?: Id<StructureController>;
    spawnSite?: TerritoryPostClaimBootstrapSpawnSiteMemory;
    lastResult?: ScreepsReturnCode;
  }

  interface TerritoryClaimedRoomBootstrapperMemory {
    rooms: Record<string, TerritoryClaimedRoomBootstrapMemory>;
  }

  interface TerritoryClaimedRoomBootstrapMemory {
    roomName: string;
    owned: boolean;
    updatedAt: number;
    claimedAt?: number;
    completedAt?: number;
  }

  type TerritoryRemoteMiningStatus =
    | 'unclaimed'
    | 'containerPending'
    | 'containerReady'
    | 'active'
    | 'suspended';

  interface TerritoryRemoteMiningRoomMemory {
    colony: string;
    roomName: string;
    status: TerritoryRemoteMiningStatus;
    updatedAt: number;
    sources: Record<string, TerritoryRemoteMiningSourceMemory>;
  }

  interface TerritoryRemoteMiningSourceMemory {
    sourceId: string;
    containerId?: string;
    containerBuilt: boolean;
    containerSitePending: boolean;
    harvesterAssigned: boolean;
    haulerAssigned: boolean;
    energyAvailable: number;
    energyFlowing: boolean;
  }

  interface CreepTerritoryMemory {
    targetRoom: string;
    action: TerritoryIntentAction;
    controllerId?: Id<StructureController>;
    followUp?: TerritoryFollowUpMemory;
  }

  type WorkerEfficiencySampleType = 'lowLoadReturn' | 'nearbyEnergyChoice';
  type WorkerEfficiencyLowLoadReturnReason =
    | 'emergencySpawnExtensionRefill'
    | 'controllerDowngradeGuard'
    | 'hostileSafety'
    | 'noReachableEnergy'
    | 'urgentSpawnExtensionRefill'
    | 'noNearbyEnergy';

  interface WorkerEfficiencySampleMemory {
    type: WorkerEfficiencySampleType;
    tick: number;
    carriedEnergy: number;
    freeCapacity: number;
    selectedTask: CreepTaskMemory['type'];
    targetId: string;
    energy?: number;
    range?: number;
    reason?: WorkerEfficiencyLowLoadReturnReason;
  }

  interface WorkerRefillTelemetryMemory {
    current?: WorkerRefillDeliveryMemory;
    recentDeliveries?: WorkerRefillDeliverySampleMemory[];
    refillActiveTicks?: number;
    idleOrOtherTaskTicks?: number;
    lastUpdatedAt?: number;
  }

  interface WorkerRefillDeliveryMemory {
    targetId: string;
    startedAt: number;
    activeTicks: number;
    idleOrOtherTaskTicks: number;
  }

  interface WorkerRefillDeliverySampleMemory {
    tick: number;
    targetId: string;
    deliveryTicks: number;
    activeTicks: number;
    idleOrOtherTaskTicks: number;
    energyDelivered: number;
  }

  interface WorkerConstructionPreBufferMemory {
    siteId: string;
    bufferId: string;
    tick: number;
  }

  interface WorkerSpawnCriticalRefillMemory {
    type: 'spawnCriticalRefill';
    tick: number;
    targetId: string;
    carriedEnergy: number;
    spawnEnergy: number;
    freeCapacity: number;
    threshold: number;
  }

  interface WorkerTaskSelectionNullLoopMemory {
    lastNullSelectionTick: number;
    nullSelectionCount: number;
    fallbackAttempts: number;
    idleStartTick: number;
  }

  type WorkerTaskBehaviorActionType = 'harvest' | 'transfer' | 'build' | 'repair' | 'upgrade';
  type WorkerTaskPolicyShadowFallbackReason =
    | 'untrainedModel'
    | 'lowConfidence'
    | 'unsupportedHeuristicAction'
    | 'actionMismatch';

  interface WorkerTaskBehaviorStateMemory {
    roomName: string;
    x?: number;
    y?: number;
    carriedEnergy: number;
    freeCapacity: number;
    energyCapacity: number;
    energyLoadRatio: number;
    currentTask: string;
    currentTaskCode: number;
    roomEnergyAvailable?: number;
    roomEnergyCapacity?: number;
    workerCount: number;
    spawnExtensionNeedCount: number;
    towerNeedCount: number;
    constructionSiteCount: number;
    repairTargetCount: number;
    sourceCount: number;
    hasContainerEnergy: boolean;
    containerEnergyAvailable: number;
    droppedEnergyAvailable: number;
    nearbyRoadCount: number;
    nearbyContainerCount: number;
    roadCoverage: number;
    hostileCreepCount: number;
    controllerLevel?: number;
    controllerTicksToDowngrade?: number;
    controllerProgressRatio?: number;
  }

  interface WorkerTaskBehaviorSampleMemory {
    type: 'workerTaskBehavior';
    schemaVersion: 1;
    tick: number;
    policyId: string;
    liveEffect: false;
    state: WorkerTaskBehaviorStateMemory;
    action: {
      type: WorkerTaskBehaviorActionType;
      targetId: string;
    };
  }

  interface WorkerTaskPolicyShadowMemory {
    type: 'workerTaskPolicyShadow';
    schemaVersion: 1;
    tick: number;
    policyId: string;
    liveEffect: false;
    predictedAction?: WorkerTaskBehaviorActionType;
    heuristicAction?: WorkerTaskBehaviorActionType;
    confidence?: number;
    matched: boolean;
    fallbackReason?: WorkerTaskPolicyShadowFallbackReason;
  }

  type WorkerEnergyCriticalPolicyReason = 'spawn' | 'storage' | 'spawnAndStorage';

  interface WorkerEnergyCriticalPolicyMemory {
    type: 'workerEnergyCriticalPolicy';
    schemaVersion: 1;
    active: true;
    reason: WorkerEnergyCriticalPolicyReason;
    enteredAt: number;
    updatedAt: number;
    spawnEnergy?: number;
    spawnEnterThreshold?: number;
    spawnExitThreshold?: number;
    storageEnergy?: number;
    storageEnterThreshold?: number;
    storageExitThreshold?: number;
  }

  interface CreepBehaviorPositionMemory {
    x: number;
    y: number;
    roomName: string;
  }

  interface CreepBehaviorTelemetryMemory {
    idleTicks?: number;
    moveTicks?: number;
    workTicks?: number;
    stuckTicks?: number;
    repairTargetId?: string;
    containerTransfers?: number;
    sourceContainerWithdrawals?: number;
    energyAcquisitionHarvested?: number;
    energyAcquisitionPickedUp?: number;
    energyAcquisitionWithdrawn?: number;
    pathLength?: number;
    lastPosition?: CreepBehaviorPositionMemory;
    lastMoveTick?: number;
    lastWorkTick?: number;
    lastObservedTick?: number;
    lastIdleTick?: number;
    lastSourceContainerWithdrawalTick?: number;
  }

  type CreepTaskMemory =
    | { type: 'harvest'; targetId: Id<Source>; sourceContainerAssigned?: true }
    | { type: 'pickup'; targetId: Id<Resource<ResourceConstant>> }
    | { type: 'withdraw'; targetId: Id<AnyStoreStructure> }
    | { type: 'transfer'; targetId: Id<AnyStoreStructure> }
    | { type: 'build'; targetId: Id<ConstructionSite> }
    | { type: 'repair'; targetId: Id<Structure> }
    | { type: 'claim'; targetId: Id<StructureController> }
    | { type: 'reserve'; targetId: Id<StructureController> }
    | { type: 'upgrade'; targetId: Id<StructureController> };
}
