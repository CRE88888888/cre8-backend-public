import { parseAbi } from 'viem';

/** cre8-contracts main e699bd8 (#54 final): keep the full Version tuple in one place. */
export const REGISTRY_VERSION_ABI = parseAbi([
  'function MAX_STRATEGY_ASSETS() view returns (uint256)',
  'function activeVersion(uint256) view returns (uint16)',
  'function pendingVersion(uint256) view returns (uint16)',
  'function versionCount(uint256) view returns (uint256)',
  'function lastPublishedAt(uint256) view returns (uint64)',
  'function cancelledVersion(uint256,uint16) view returns (bool)',
  'function historicalAssets(uint256) view returns (address[])',
  'function wasAssetAllowed(uint256,address) view returns (bool)',
  'function version(uint256,uint16) view returns ((address[] assets,uint16[] weightsBps,bytes32 scheduleHash,uint64 activeAt,bytes32 settingsHash,uint16 performanceFeeBps,bytes32 configHash))',
]);

export const REGISTRY_ABI = parseAbi([
  'function numeraire() view returns (address)',
  'function operator() view returns (address)',
  'function registerStrategy(string name,string description,bool isPublic) returns (uint256 id)',
  'function publishVersion(uint256 id,address[] assets,uint16[] weightsBps,bytes32 scheduleHash,uint64 activeAt) returns (uint16 versionNumber)',
  'function publishSettingsVersion(uint256 id,address[] assets,uint16[] weightsBps,bytes32 scheduleHash,bytes32 settingsHash,uint16 performanceFeeBps,uint64 activeAt) returns (uint16 versionNumber)',
  'function cancelVersion(uint256 id)',
  'function enroll(address account,uint256 id,uint16 expectedVersion)',
  'function approveEnrollment(uint256 id,uint16 expectedVersion)',
  'function revokeEnrollmentApproval()',
  'function enrollmentApproval(address) view returns (bytes32)',
  'function isEnrolled(address account) view returns (bool)',
  'function enrollments(address account) view returns (uint256 strategyId,uint16 version,bool paused)',
  'function pauseFlags(address account) view returns (uint8)',
  'event StrategyRegistered(uint256 indexed id,address indexed provider,string name)',
  'event VersionPublished(uint256 indexed id,uint16 version,bytes32 scheduleHash)',
  'event VersionScheduled(uint256 indexed id,uint16 indexed version,uint64 activeAt,bytes32 configHash)',
  'event VersionCancelled(uint256 indexed id,uint16 indexed version)',
  'event EnrollmentApproved(address indexed account,uint256 indexed id,uint16 version,bytes32 terms)',
  'event Enrolled(address indexed account,uint256 id,uint16 version)',
  'event PauseFlagsSet(address indexed account,uint8 flags)',
  'error Unauthorized()', 'error AlreadyEnrolled(address account)', 'error ConsentRequired()',
  'error UnexpectedVersion(uint16 expected,uint16 actual)', 'error PendingVersionExists(uint256 id)',
  'error NoPendingVersion(uint256 id)', 'error PublicationTooSoon(uint256 earliest)',
  'error ActivationTooSoon(uint256 earliest)', 'error PerformanceFeeOutOfRange(uint16 bps)',
  'error StrategyAssetLimitExceeded(uint256 count)',
]);
