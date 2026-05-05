export {};

declare global {
  interface Memory {
    meta: {
      version: number;
    };
    defense?: DefenseMemory;
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
    remoteHarvester?: CreepRemoteHarvesterMemory;
    remoteHauler?: CreepRemoteHaulerMemory;
    workerEfficiency?: WorkerEfficiencySampleMemory;
    refillTelemetry?: WorkerRefillTelemetryMemory;
    spawnCriticalRefill?: WorkerSpawnCriticalRefillMemory;
    workerBehavior?: WorkerTaskBehaviorSampleMemory;
    workerTaskPolicyShadow?: WorkerTaskPolicyShadowMemory;
    behaviorTelemetry?: CreepBehaviorTelemetryMemory;
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
  type TerritoryIntentSuppressionReason = 'deadZoneTarget' | 'deadZoneRoute';

  interface DefenseMemory {
    actions?: DefenseActionMemory[];
    rooms?: Record<string, DefenseActionMemory>;
    unsafeRooms?: Record<string, DefenseUnsafeRoomMemory>;
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

  interface CreepDefenseMemory {
    homeRoom: string;
  }

  type CreepControllerSustainRole = 'upgrader' | 'hauler';

  interface CreepControllerSustainMemory {
    homeRoom: string;
    targetRoom: string;
    role: CreepControllerSustainRole;
  }

  interface CreepRemoteHarvesterMemory {
    homeRoom: string;
    targetRoom: string;
    sourceId: Id<Source>;
    containerId: Id<StructureContainer>;
  }

  interface CreepRemoteHaulerMemory {
    homeRoom: string;
    targetRoom: string;
    sourceId: Id<Source>;
    containerId: Id<StructureContainer>;
  }

  interface EconomyMemory {
    sourceWorkloads?: Record<string, EconomyRoomSourceWorkloadMemory>;
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
    | 'hostileSpawn'
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
    | 'roomLimitReached'
    | 'unmetPreconditions'
    | 'insufficientEvidence'
    | 'unavailable';

  interface RoomMemory {
    lastExpansionScoreTime?: number;
    cachedExpansionSelection?: RoomExpansionSelectionMemory;
    colonyStage?: RoomColonyStageMemory;
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
    postClaimBootstraps?: Record<string, TerritoryPostClaimBootstrapMemory>;
    remoteMining?: Record<string, TerritoryRemoteMiningRoomMemory>;
    reservations?: Record<string, TerritoryReservationMemory>;
    scoutAttempts?: Record<string, TerritoryScoutAttemptMemory>;
    scoutIntel?: Record<string, TerritoryScoutIntelMemory>;
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
  }

  interface TerritoryIntentMemory {
    colony: string;
    targetRoom: string;
    action: TerritoryIntentAction;
    status: 'planned' | 'active' | 'suppressed';
    updatedAt: number;
    createdBy?: TerritoryAutomationSource;
    reason?: TerritoryIntentSuppressionReason;
    lastAttemptAt?: number;
    controllerId?: Id<StructureController>;
    requiresControllerPressure?: boolean;
    followUp?: TerritoryFollowUpMemory;
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
    mineral?: TerritoryScoutMineralIntelMemory;
    hostileCreepCount: number;
    hostileStructureCount: number;
    hostileSpawnCount: number;
    scoutName?: string;
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
    pathLength?: number;
    lastPosition?: CreepBehaviorPositionMemory;
    lastMoveTick?: number;
    lastWorkTick?: number;
    lastObservedTick?: number;
    lastIdleTick?: number;
  }

  type CreepTaskMemory =
    | { type: 'harvest'; targetId: Id<Source> }
    | { type: 'pickup'; targetId: Id<Resource<ResourceConstant>> }
    | { type: 'withdraw'; targetId: Id<AnyStoreStructure> }
    | { type: 'transfer'; targetId: Id<AnyStoreStructure> }
    | { type: 'build'; targetId: Id<ConstructionSite> }
    | { type: 'repair'; targetId: Id<Structure> }
    | { type: 'claim'; targetId: Id<StructureController> }
    | { type: 'reserve'; targetId: Id<StructureController> }
    | { type: 'upgrade'; targetId: Id<StructureController> };
}
