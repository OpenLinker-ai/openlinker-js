import type { JsonObject } from "./types.js";

export const RuntimeProtocolVersion = 2 as const;
export const RuntimeContractID = "openlinker.runtime.v2" as const;
export const RuntimeContractDigest =
  "4be9b2fe09eeedf0e37119075134064be88f93b301c502cdfa21a6cb978c6481" as const;
export const RuntimeAttachmentHeader = "OpenLinker-Runtime-Attachment" as const;
export const RuntimeRequiredFeatures = Object.freeze([
  "lease_fence",
  "assignment_confirm",
  "renew",
  "resume",
  "event_ack",
  "result_ack",
  "cancel",
  "persistent_spool",
  "session_drain",
] as const);

export const RuntimeMaxMessageBytes = 4 * 1024 * 1024;
export const RuntimeMaxPullWaitSeconds = 30;
export const RuntimeMaxNodeCapacity = 1024;
export const RuntimeMaxResumeAttempts = 1024;

export const RuntimeMessageTypes = Object.freeze({
  hello: "runtime.hello",
  ready: "runtime.ready",
  runAssigned: "run.assigned",
  assignmentAck: "run.assignment.ack",
  assignmentConfirmed: "run.assignment.confirmed",
  assignmentReject: "run.assignment.reject",
  assignmentRejected: "run.assignment.rejected",
  leaseRenew: "run.lease.renew",
  leaseRenewed: "run.lease.renewed",
  runEvent: "run.event",
  runEventAck: "run.event.ack",
  runResult: "run.result",
  runResultAck: "run.result.ack",
  runCancel: "run.cancel",
  runCancelAck: "run.cancel.ack",
  resume: "runtime.resume",
  resumeAccepted: "run.resume.accepted",
  leaseRevoked: "run.lease.revoked",
  drain: "runtime.drain",
  error: "runtime.error",
} as const);

export type RuntimeMessageType =
  (typeof RuntimeMessageTypes)[keyof typeof RuntimeMessageTypes];

export interface RuntimeEnvelopeFields<
  TType extends RuntimeMessageType = RuntimeMessageType,
> {
  protocolVersion: typeof RuntimeProtocolVersion;
  runtimeContractId: typeof RuntimeContractID;
  messageId: string;
  replyToMessageId?: string;
  type: TType;
  sentAt: string;
}

export interface RuntimeEnvelope<
  TPayload = unknown,
  TType extends RuntimeMessageType = RuntimeMessageType,
> extends RuntimeEnvelopeFields<TType> {
  payload: TPayload;
}

export interface RuntimeAttemptIdentity {
  runId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
}

export interface RuntimeHelloPayload {
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
  sessionEpoch: number;
  nodeVersion: string;
  capacity: number;
  features: readonly string[];
  contractDigest: string;
}

export interface RuntimeReadyPayload {
  coreInstanceId: string;
  attachmentId: string;
  features: string[];
  offerTtlSeconds: number;
  leaseTtlSeconds: number;
  databaseTime: string;
}

export interface RuntimeSessionCloseRequest {
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
  sessionEpoch: number;
  status: "offline" | "closed";
  reason: string;
}

export interface RuntimeClaimRequest {
  runtimeSessionId: string;
  capacity: number;
  inflight: number;
}

export interface RuntimeRunAssignedPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  offerNo: number;
  offerExpiresAt: string;
  attemptDeadlineAt: string;
  runDeadlineAt: string;
  input: JsonObject;
  metadata?: JsonObject;
  nodeEnvelope: string;
  agentInvocationToken: string;
}

export interface RuntimeAssignmentAckPayload {
  attemptIdentity: RuntimeAttemptIdentity;
}

export interface RuntimeAssignmentConfirmedPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  attemptNo: number;
  leaseExpiresAt: string;
}

export const RuntimeAssignmentRejectReasons = Object.freeze({
  nodeAtCapacity: "NODE_AT_CAPACITY",
  nodeDraining: "NODE_DRAINING",
  clientUpgradeRequired: "RUNTIME_CLIENT_UPGRADE_REQUIRED",
  requiredFeatureMissing: "RUNTIME_REQUIRED_FEATURE_MISSING",
} as const);

export type RuntimeAssignmentRejectReason =
  (typeof RuntimeAssignmentRejectReasons)[keyof typeof RuntimeAssignmentRejectReasons];

export interface RuntimeAssignmentRejectPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  reasonCode: RuntimeAssignmentRejectReason;
  capacity: number;
  inflight: number;
}

export type RuntimeAssignmentRejectOutcome = "offer_rejected" | "lease_revoked";

export type RuntimeDispatchState =
  | "pending"
  | "offered"
  | "executing"
  | "retry_wait"
  | "terminal"
  | "dead_letter";

export type RuntimeRunStatus =
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "canceled";

export interface RuntimeAssignmentRejectedPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  outcome: RuntimeAssignmentRejectOutcome;
  dispatchState: RuntimeDispatchState;
}

export interface RuntimeLeaseRenewPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  lastClientEventSeq: number;
  capacity: number;
  inflight: number;
}

export interface RuntimeLeaseRenewedPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  leaseExpiresAt: string;
  pendingCommand?: RuntimePendingCommand | null;
}

export interface RuntimeRunEventPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  clientEventId: string;
  clientEventSeq: number;
  eventType: string;
  payload: JsonObject;
}

export interface RuntimeRunEventAckPayload {
  clientEventId: string;
  clientEventSeq: number;
  sequence: number;
  replayed: boolean;
}

export interface RuntimeRunErrorPayload {
  errorCode: string;
  message: string;
  retryableHint?: boolean;
}

interface RuntimeRunResultBase {
  attemptIdentity: RuntimeAttemptIdentity;
  resultId: string;
  durationMs: number;
  finalClientEventSeq: number;
}

export type RuntimeRunResultPayload =
  | RuntimeRunResultBase & {
    status: "success";
    output: JsonObject;
    error?: never;
  }
  | RuntimeRunResultBase & {
    status: "failed";
    error: RuntimeRunErrorPayload;
    output?: never;
  };

export type RuntimeResultClassification =
  | "success"
  | "retryable_failure"
  | "non_retryable_failure"
  | "timeout"
  | "canceled"
  | "dead_letter";

export interface RuntimeRunResultAckPayload {
  resultId: string;
  classification: RuntimeResultClassification;
  runStatus: RuntimeRunStatus;
  dispatchState: RuntimeDispatchState;
  replayed: boolean;
  nextAttemptAt?: string;
}

export const RuntimeCancelStates = Object.freeze({
  requested: "requested",
  delivered: "delivered",
  stopping: "stopping",
  stopped: "stopped",
  unsupported: "unsupported",
  failed: "failed",
  unconfirmed: "unconfirmed",
} as const);

export type RuntimeCancelState =
  (typeof RuntimeCancelStates)[keyof typeof RuntimeCancelStates];

export interface RuntimeRunCancelPayload {
  cancellationId: string;
  attemptIdentity: RuntimeAttemptIdentity;
  reasonCode: string;
  deadlineAt: string;
}

export interface RuntimeRunCancelAckPayload {
  cancellationId: string;
  attemptIdentity: RuntimeAttemptIdentity;
  cancelState: RuntimeCancelState;
  errorCode?: string;
}

export interface RuntimeRunCancellationState {
  cancellationId: string;
  cancelState: RuntimeCancelState;
  updatedAt: string;
  errorCode?: string;
}

export interface RuntimeEventRange {
  start: number;
  end: number;
}

export interface RuntimeResumeAttempt {
  attemptIdentity: RuntimeAttemptIdentity;
  lastAckedClientEventSeq: number;
  pendingClientEventRanges: RuntimeEventRange[];
  pendingResultId?: string;
  finalClientEventSeq?: number;
}

export interface RuntimeResumePayload {
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
  attempts: RuntimeResumeAttempt[];
}

export const RuntimeResumeDecisions = Object.freeze({
  continueExecution: "continue_execution",
  uploadSpoolOnly: "upload_spool_only",
  resultAlreadyAcked: "result_already_acked",
  leaseRevoked: "lease_revoked",
} as const);

export type RuntimeResumeDecision =
  (typeof RuntimeResumeDecisions)[keyof typeof RuntimeResumeDecisions];

export const RuntimeResumeActions = Object.freeze({
  continueExecution: "continue_execution",
  uploadEvents: "upload_events",
  uploadResult: "upload_result",
  stopExecution: "stop_execution",
  clearSpool: "clear_spool",
} as const);

export type RuntimeResumeAction =
  (typeof RuntimeResumeActions)[keyof typeof RuntimeResumeActions];

export interface RuntimeResumeAcceptedPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  decision: RuntimeResumeDecision;
  leaseExpiresAt?: string;
  allowedActions: RuntimeResumeAction[];
}

export interface RuntimeResumeResponse {
  decisions: RuntimeResumeAcceptedPayload[];
}

export interface RuntimeRunLeaseRevokedPayload {
  attemptIdentity: RuntimeAttemptIdentity;
  reasonCode: string;
  dispatchState: RuntimeDispatchState;
  runStatus: RuntimeRunStatus;
}

export interface RuntimeDrainPayload {
  deadlineAt: string;
  reasonCode: string;
  capacity: number;
  inflight: number;
}

export type RuntimePendingCommand =
  | {
    type: typeof RuntimeMessageTypes.runCancel;
    payload: RuntimeRunCancelPayload;
  }
  | {
    type: typeof RuntimeMessageTypes.drain;
    payload: RuntimeDrainPayload;
  }
  | {
    type: typeof RuntimeMessageTypes.leaseRevoked;
    payload: RuntimeRunLeaseRevokedPayload;
  };

export interface RuntimeCommandsResponse {
  commands: RuntimePendingCommand[];
  databaseTime: string;
}

export interface RuntimeCallAgentAuthorization {
  invocationContext: string;
  token: string;
  idempotencyKey: string;
}

export interface RuntimeCallAgentRequest {
  targetAgentId: string;
  input: JsonObject;
  metadata?: JsonObject;
  reason?: string;
}

export interface RuntimeRunSummary {
  runId: string;
  status: RuntimeRunStatus;
  dispatchState: RuntimeDispatchState;
}

export interface RuntimeInvocationProofRequest {
  method: string;
  path: string;
  idempotencyKey: string;
  context: string;
  body: Uint8Array;
}

export type RuntimeErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RUN_ALREADY_TERMINAL"
  | "STALE_LEASE"
  | "LEASE_EXPIRED"
  | "LEASE_IDENTITY_MISMATCH"
  | "RESULT_ID_CONFLICT"
  | "EVENT_ID_CONFLICT"
  | "NODE_AT_CAPACITY"
  | "RUNTIME_CLIENT_UPGRADE_REQUIRED"
  | "RUNTIME_REQUIRED_FEATURE_MISSING"
  | "RUN_CANCEL_REQUESTED"
  | "RUN_CANCEL_UNCONFIRMED"
  | "RUNTIME_RETRY_EXHAUSTED"
  | "RUNTIME_DISPATCH_TIMEOUT"
  | "RUN_DEADLINE_EXCEEDED"
  | "EVENTS_MISSING"
  | "REPLAY_INPUT_UNAVAILABLE"
  | "ENDPOINT_RESULT_UNKNOWN"
  | "RUNTIME_SESSION_CONFLICT"
  | "RUNTIME_SPOOL_CORRUPT";

export interface RuntimeErrorBody {
  code: RuntimeErrorCode;
  message: string;
  retryable?: boolean;
  missingEventRanges?: RuntimeEventRange[];
  currentRunStatus?: RuntimeRunStatus;
  currentDispatchState?: RuntimeDispatchState;
}

export interface RuntimeErrorEnvelope {
  error: RuntimeErrorBody;
}

export type RuntimeHelloMessage = RuntimeEnvelope<
  RuntimeHelloPayload,
  typeof RuntimeMessageTypes.hello
>;
export type RuntimeReadyMessage = RuntimeEnvelope<
  RuntimeReadyPayload,
  typeof RuntimeMessageTypes.ready
>;
export type RuntimeRunAssignedMessage = RuntimeEnvelope<
  RuntimeRunAssignedPayload,
  typeof RuntimeMessageTypes.runAssigned
>;
export type RuntimeAssignmentAckMessage = RuntimeEnvelope<
  RuntimeAssignmentAckPayload,
  typeof RuntimeMessageTypes.assignmentAck
>;
export type RuntimeAssignmentConfirmedMessage = RuntimeEnvelope<
  RuntimeAssignmentConfirmedPayload,
  typeof RuntimeMessageTypes.assignmentConfirmed
>;
export type RuntimeAssignmentRejectMessage = RuntimeEnvelope<
  RuntimeAssignmentRejectPayload,
  typeof RuntimeMessageTypes.assignmentReject
>;
export type RuntimeAssignmentRejectedMessage = RuntimeEnvelope<
  RuntimeAssignmentRejectedPayload,
  typeof RuntimeMessageTypes.assignmentRejected
>;
export type RuntimeLeaseRenewMessage = RuntimeEnvelope<
  RuntimeLeaseRenewPayload,
  typeof RuntimeMessageTypes.leaseRenew
>;
export type RuntimeLeaseRenewedMessage = RuntimeEnvelope<
  RuntimeLeaseRenewedPayload,
  typeof RuntimeMessageTypes.leaseRenewed
>;
export type RuntimeRunEventMessage = RuntimeEnvelope<
  RuntimeRunEventPayload,
  typeof RuntimeMessageTypes.runEvent
>;
export type RuntimeRunEventAckMessage = RuntimeEnvelope<
  RuntimeRunEventAckPayload,
  typeof RuntimeMessageTypes.runEventAck
>;
export type RuntimeRunResultMessage = RuntimeEnvelope<
  RuntimeRunResultPayload,
  typeof RuntimeMessageTypes.runResult
>;
export type RuntimeRunResultAckMessage = RuntimeEnvelope<
  RuntimeRunResultAckPayload,
  typeof RuntimeMessageTypes.runResultAck
>;
export type RuntimeRunCancelMessage = RuntimeEnvelope<
  RuntimeRunCancelPayload,
  typeof RuntimeMessageTypes.runCancel
>;
export type RuntimeRunCancelAckMessage = RuntimeEnvelope<
  RuntimeRunCancelAckPayload,
  typeof RuntimeMessageTypes.runCancelAck
>;
export type RuntimeResumeMessage = RuntimeEnvelope<
  RuntimeResumePayload,
  typeof RuntimeMessageTypes.resume
>;
export type RuntimeResumeAcceptedMessage = RuntimeEnvelope<
  RuntimeResumeAcceptedPayload,
  typeof RuntimeMessageTypes.resumeAccepted
>;
export type RuntimeRunLeaseRevokedMessage = RuntimeEnvelope<
  RuntimeRunLeaseRevokedPayload,
  typeof RuntimeMessageTypes.leaseRevoked
>;
export type RuntimeDrainMessage = RuntimeEnvelope<
  RuntimeDrainPayload,
  typeof RuntimeMessageTypes.drain
>;
export type RuntimeErrorMessage = RuntimeEnvelope<
  RuntimeErrorBody,
  typeof RuntimeMessageTypes.error
>;

export type RuntimeMessage =
  | RuntimeHelloMessage
  | RuntimeReadyMessage
  | RuntimeRunAssignedMessage
  | RuntimeAssignmentAckMessage
  | RuntimeAssignmentConfirmedMessage
  | RuntimeAssignmentRejectMessage
  | RuntimeAssignmentRejectedMessage
  | RuntimeLeaseRenewMessage
  | RuntimeLeaseRenewedMessage
  | RuntimeRunEventMessage
  | RuntimeRunEventAckMessage
  | RuntimeRunResultMessage
  | RuntimeRunResultAckMessage
  | RuntimeRunCancelMessage
  | RuntimeRunCancelAckMessage
  | RuntimeResumeMessage
  | RuntimeResumeAcceptedMessage
  | RuntimeRunLeaseRevokedMessage
  | RuntimeDrainMessage
  | RuntimeErrorMessage;
