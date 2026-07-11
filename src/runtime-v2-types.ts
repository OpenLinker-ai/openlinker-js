import type { JsonObject } from "./types.js";

export const RuntimeProtocolVersion = 2 as const;
export const RuntimeContractID = "openlinker.runtime.v2" as const;
export const RuntimeContractDigest =
  "60bef5cec7eeab563937187f48a458059995aebee161765032cddc17d0cdfa61" as const;
export const RuntimeRequiredFeatures = Object.freeze([
  "lease_fence",
  "assignment_confirm",
  "renew",
  "resume",
  "event_ack",
  "result_ack",
  "cancel",
  "persistent_spool",
] as const);

export const RuntimeV2MaxMessageBytes = 4 * 1024 * 1024;
export const RuntimeV2MaxPullWaitSeconds = 30;
export const RuntimeV2MaxNodeCapacity = 1024;
export const RuntimeV2MaxResumeAttempts = 1024;

export const RuntimeV2MessageTypes = Object.freeze({
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

export type RuntimeV2MessageType =
  (typeof RuntimeV2MessageTypes)[keyof typeof RuntimeV2MessageTypes];

export interface RuntimeV2EnvelopeFields<
  TType extends RuntimeV2MessageType = RuntimeV2MessageType,
> {
  protocolVersion: typeof RuntimeProtocolVersion;
  runtimeContractId: typeof RuntimeContractID;
  messageId: string;
  replyToMessageId?: string;
  type: TType;
  sentAt: string;
}

export interface RuntimeV2Envelope<
  TPayload = unknown,
  TType extends RuntimeV2MessageType = RuntimeV2MessageType,
> extends RuntimeV2EnvelopeFields<TType> {
  payload: TPayload;
}

export interface RuntimeV2AttemptIdentity {
  runId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
}

export interface RuntimeV2HelloPayload {
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

export interface RuntimeV2ReadyPayload {
  coreInstanceId: string;
  features: string[];
  offerTtlSeconds: number;
  leaseTtlSeconds: number;
  databaseTime: string;
}

export interface RuntimeV2SessionCloseRequest {
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
  sessionEpoch: number;
  status: "offline" | "closed";
  reason: string;
}

export interface RuntimeV2ClaimRequest {
  runtimeSessionId: string;
  capacity: number;
  inflight: number;
}

export interface RuntimeV2RunAssignedPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  offerNo: number;
  offerExpiresAt: string;
  attemptDeadlineAt: string;
  runDeadlineAt: string;
  input: JsonObject;
  metadata?: JsonObject;
  nodeEnvelope: string;
  agentInvocationToken: string;
}

export interface RuntimeV2AssignmentAckPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
}

export interface RuntimeV2AssignmentConfirmedPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  attemptNo: number;
  leaseExpiresAt: string;
}

export const RuntimeV2AssignmentRejectReasons = Object.freeze({
  nodeAtCapacity: "NODE_AT_CAPACITY",
  nodeDraining: "NODE_DRAINING",
  clientUpgradeRequired: "RUNTIME_CLIENT_UPGRADE_REQUIRED",
  requiredFeatureMissing: "RUNTIME_REQUIRED_FEATURE_MISSING",
} as const);

export type RuntimeV2AssignmentRejectReason =
  (typeof RuntimeV2AssignmentRejectReasons)[keyof typeof RuntimeV2AssignmentRejectReasons];

export interface RuntimeV2AssignmentRejectPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  reasonCode: RuntimeV2AssignmentRejectReason;
  capacity: number;
  inflight: number;
}

export type RuntimeV2AssignmentRejectOutcome = "offer_rejected" | "lease_revoked";

export type RuntimeV2DispatchState =
  | "pending"
  | "offered"
  | "executing"
  | "retry_wait"
  | "terminal"
  | "dead_letter";

export type RuntimeV2RunStatus =
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "canceled";

export interface RuntimeV2AssignmentRejectedPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  outcome: RuntimeV2AssignmentRejectOutcome;
  dispatchState: RuntimeV2DispatchState;
}

export interface RuntimeV2LeaseRenewPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  lastClientEventSeq: number;
  capacity: number;
  inflight: number;
}

export interface RuntimeV2LeaseRenewedPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  leaseExpiresAt: string;
  pendingCommand?: RuntimeV2PendingCommand | null;
}

export interface RuntimeV2RunEventPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  clientEventId: string;
  clientEventSeq: number;
  eventType: string;
  payload: JsonObject;
}

export interface RuntimeV2RunEventAckPayload {
  clientEventId: string;
  clientEventSeq: number;
  sequence: number;
  replayed: boolean;
}

export interface RuntimeV2RunErrorPayload {
  errorCode: string;
  message: string;
  retryableHint?: boolean;
}

interface RuntimeV2RunResultBase {
  attemptIdentity: RuntimeV2AttemptIdentity;
  resultId: string;
  durationMs: number;
  finalClientEventSeq: number;
}

export type RuntimeV2RunResultPayload =
  | RuntimeV2RunResultBase & {
    status: "success";
    output: JsonObject;
    error?: never;
  }
  | RuntimeV2RunResultBase & {
    status: "failed";
    error: RuntimeV2RunErrorPayload;
    output?: never;
  };

export type RuntimeV2ResultClassification =
  | "success"
  | "retryable_failure"
  | "non_retryable_failure"
  | "timeout"
  | "canceled"
  | "dead_letter";

export interface RuntimeV2RunResultAckPayload {
  resultId: string;
  classification: RuntimeV2ResultClassification;
  runStatus: RuntimeV2RunStatus;
  dispatchState: RuntimeV2DispatchState;
  replayed: boolean;
  nextAttemptAt?: string;
}

export const RuntimeV2CancelStates = Object.freeze({
  requested: "requested",
  delivered: "delivered",
  stopping: "stopping",
  stopped: "stopped",
  unsupported: "unsupported",
  failed: "failed",
  unconfirmed: "unconfirmed",
} as const);

export type RuntimeV2CancelState =
  (typeof RuntimeV2CancelStates)[keyof typeof RuntimeV2CancelStates];

export interface RuntimeV2RunCancelPayload {
  cancellationId: string;
  attemptIdentity: RuntimeV2AttemptIdentity;
  reasonCode: string;
  deadlineAt: string;
}

export interface RuntimeV2RunCancelAckPayload {
  cancellationId: string;
  attemptIdentity: RuntimeV2AttemptIdentity;
  cancelState: RuntimeV2CancelState;
  errorCode?: string;
}

export interface RuntimeV2RunCancellationState {
  cancellationId: string;
  cancelState: RuntimeV2CancelState;
  updatedAt: string;
  errorCode?: string;
}

export interface RuntimeV2EventRange {
  start: number;
  end: number;
}

export interface RuntimeV2ResumeAttempt {
  attemptIdentity: RuntimeV2AttemptIdentity;
  lastAckedClientEventSeq: number;
  pendingClientEventRanges: RuntimeV2EventRange[];
  pendingResultId?: string;
  finalClientEventSeq?: number;
}

export interface RuntimeV2ResumePayload {
  nodeId: string;
  agentId: string;
  workerId: string;
  runtimeSessionId: string;
  attempts: RuntimeV2ResumeAttempt[];
}

export const RuntimeV2ResumeDecisions = Object.freeze({
  continueExecution: "continue_execution",
  uploadSpoolOnly: "upload_spool_only",
  resultAlreadyAcked: "result_already_acked",
  leaseRevoked: "lease_revoked",
} as const);

export type RuntimeV2ResumeDecision =
  (typeof RuntimeV2ResumeDecisions)[keyof typeof RuntimeV2ResumeDecisions];

export const RuntimeV2ResumeActions = Object.freeze({
  continueExecution: "continue_execution",
  uploadEvents: "upload_events",
  uploadResult: "upload_result",
  stopExecution: "stop_execution",
  clearSpool: "clear_spool",
} as const);

export type RuntimeV2ResumeAction =
  (typeof RuntimeV2ResumeActions)[keyof typeof RuntimeV2ResumeActions];

export interface RuntimeV2ResumeAcceptedPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  decision: RuntimeV2ResumeDecision;
  leaseExpiresAt?: string;
  allowedActions: RuntimeV2ResumeAction[];
}

export interface RuntimeV2ResumeResponse {
  decisions: RuntimeV2ResumeAcceptedPayload[];
}

export interface RuntimeV2RunLeaseRevokedPayload {
  attemptIdentity: RuntimeV2AttemptIdentity;
  reasonCode: string;
  dispatchState: RuntimeV2DispatchState;
  runStatus: RuntimeV2RunStatus;
}

export interface RuntimeV2DrainPayload {
  deadlineAt: string;
  reasonCode: string;
  capacity: number;
  inflight: number;
}

export type RuntimeV2PendingCommand =
  | {
    type: typeof RuntimeV2MessageTypes.runCancel;
    payload: RuntimeV2RunCancelPayload;
  }
  | {
    type: typeof RuntimeV2MessageTypes.drain;
    payload: RuntimeV2DrainPayload;
  }
  | {
    type: typeof RuntimeV2MessageTypes.leaseRevoked;
    payload: RuntimeV2RunLeaseRevokedPayload;
  };

export interface RuntimeV2CommandsResponse {
  commands: RuntimeV2PendingCommand[];
  databaseTime: string;
}

export interface RuntimeV2CallAgentAuthorization {
  invocationContext: string;
  token: string;
  idempotencyKey: string;
}

export interface RuntimeV2CallAgentRequest {
  targetAgentId: string;
  input: JsonObject;
  metadata?: JsonObject;
  reason?: string;
}

export interface RuntimeV2RunSummary {
  runId: string;
  status: RuntimeV2RunStatus;
  dispatchState: RuntimeV2DispatchState;
}

export interface RuntimeV2InvocationProofRequest {
  method: string;
  path: string;
  idempotencyKey: string;
  context: string;
  body: Uint8Array;
}

export type RuntimeV2ErrorCode =
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

export interface RuntimeV2ErrorBody {
  code: RuntimeV2ErrorCode;
  message: string;
  retryable?: boolean;
  missingEventRanges?: RuntimeV2EventRange[];
  currentRunStatus?: RuntimeV2RunStatus;
  currentDispatchState?: RuntimeV2DispatchState;
}

export interface RuntimeV2ErrorEnvelope {
  error: RuntimeV2ErrorBody;
}

export type RuntimeV2HelloMessage = RuntimeV2Envelope<
  RuntimeV2HelloPayload,
  typeof RuntimeV2MessageTypes.hello
>;
export type RuntimeV2ReadyMessage = RuntimeV2Envelope<
  RuntimeV2ReadyPayload,
  typeof RuntimeV2MessageTypes.ready
>;
export type RuntimeV2RunAssignedMessage = RuntimeV2Envelope<
  RuntimeV2RunAssignedPayload,
  typeof RuntimeV2MessageTypes.runAssigned
>;
export type RuntimeV2AssignmentAckMessage = RuntimeV2Envelope<
  RuntimeV2AssignmentAckPayload,
  typeof RuntimeV2MessageTypes.assignmentAck
>;
export type RuntimeV2AssignmentConfirmedMessage = RuntimeV2Envelope<
  RuntimeV2AssignmentConfirmedPayload,
  typeof RuntimeV2MessageTypes.assignmentConfirmed
>;
export type RuntimeV2AssignmentRejectMessage = RuntimeV2Envelope<
  RuntimeV2AssignmentRejectPayload,
  typeof RuntimeV2MessageTypes.assignmentReject
>;
export type RuntimeV2AssignmentRejectedMessage = RuntimeV2Envelope<
  RuntimeV2AssignmentRejectedPayload,
  typeof RuntimeV2MessageTypes.assignmentRejected
>;
export type RuntimeV2LeaseRenewMessage = RuntimeV2Envelope<
  RuntimeV2LeaseRenewPayload,
  typeof RuntimeV2MessageTypes.leaseRenew
>;
export type RuntimeV2LeaseRenewedMessage = RuntimeV2Envelope<
  RuntimeV2LeaseRenewedPayload,
  typeof RuntimeV2MessageTypes.leaseRenewed
>;
export type RuntimeV2RunEventMessage = RuntimeV2Envelope<
  RuntimeV2RunEventPayload,
  typeof RuntimeV2MessageTypes.runEvent
>;
export type RuntimeV2RunEventAckMessage = RuntimeV2Envelope<
  RuntimeV2RunEventAckPayload,
  typeof RuntimeV2MessageTypes.runEventAck
>;
export type RuntimeV2RunResultMessage = RuntimeV2Envelope<
  RuntimeV2RunResultPayload,
  typeof RuntimeV2MessageTypes.runResult
>;
export type RuntimeV2RunResultAckMessage = RuntimeV2Envelope<
  RuntimeV2RunResultAckPayload,
  typeof RuntimeV2MessageTypes.runResultAck
>;
export type RuntimeV2RunCancelMessage = RuntimeV2Envelope<
  RuntimeV2RunCancelPayload,
  typeof RuntimeV2MessageTypes.runCancel
>;
export type RuntimeV2RunCancelAckMessage = RuntimeV2Envelope<
  RuntimeV2RunCancelAckPayload,
  typeof RuntimeV2MessageTypes.runCancelAck
>;
export type RuntimeV2ResumeMessage = RuntimeV2Envelope<
  RuntimeV2ResumePayload,
  typeof RuntimeV2MessageTypes.resume
>;
export type RuntimeV2ResumeAcceptedMessage = RuntimeV2Envelope<
  RuntimeV2ResumeAcceptedPayload,
  typeof RuntimeV2MessageTypes.resumeAccepted
>;
export type RuntimeV2RunLeaseRevokedMessage = RuntimeV2Envelope<
  RuntimeV2RunLeaseRevokedPayload,
  typeof RuntimeV2MessageTypes.leaseRevoked
>;
export type RuntimeV2DrainMessage = RuntimeV2Envelope<
  RuntimeV2DrainPayload,
  typeof RuntimeV2MessageTypes.drain
>;
export type RuntimeV2ErrorMessage = RuntimeV2Envelope<
  RuntimeV2ErrorBody,
  typeof RuntimeV2MessageTypes.error
>;

export type RuntimeV2Message =
  | RuntimeV2HelloMessage
  | RuntimeV2ReadyMessage
  | RuntimeV2RunAssignedMessage
  | RuntimeV2AssignmentAckMessage
  | RuntimeV2AssignmentConfirmedMessage
  | RuntimeV2AssignmentRejectMessage
  | RuntimeV2AssignmentRejectedMessage
  | RuntimeV2LeaseRenewMessage
  | RuntimeV2LeaseRenewedMessage
  | RuntimeV2RunEventMessage
  | RuntimeV2RunEventAckMessage
  | RuntimeV2RunResultMessage
  | RuntimeV2RunResultAckMessage
  | RuntimeV2RunCancelMessage
  | RuntimeV2RunCancelAckMessage
  | RuntimeV2ResumeMessage
  | RuntimeV2ResumeAcceptedMessage
  | RuntimeV2RunLeaseRevokedMessage
  | RuntimeV2DrainMessage
  | RuntimeV2ErrorMessage;
