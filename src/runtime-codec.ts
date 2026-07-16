import {
  RuntimeContractDigest,
  RuntimeRequiredFeatures,
  RuntimeAssignmentRejectReasons,
  RuntimeCancelStates,
  RuntimeMaxMessageBytes,
  RuntimeMaxNodeCapacity,
  RuntimeMaxPullWaitSeconds,
  RuntimeMaxResumeAttempts,
  RuntimeMessageTypes,
  RuntimeResumeActions,
  RuntimeResumeDecisions,
  type RuntimeAssignmentAckPayload,
  type RuntimeAssignmentConfirmedPayload,
  type RuntimeAssignmentRejectPayload,
  type RuntimeAssignmentRejectedPayload,
  type RuntimeAttemptIdentity,
  type RuntimeCallAgentRequest,
  type RuntimeRunSummary,
  type RuntimeClaimRequest,
  type RuntimeCommandsResponse,
  type RuntimeCancelState,
  type RuntimeDispatchState,
  type RuntimeDrainPayload,
  type RuntimeErrorBody,
  type RuntimeErrorCode,
  type RuntimeErrorEnvelope,
  type RuntimeEventRange,
  type RuntimeHelloPayload,
  type RuntimeLeaseRenewedPayload,
  type RuntimeLeaseRenewPayload,
  type RuntimeMessageType,
  type RuntimePendingCommand,
  type RuntimeReadyPayload,
  type RuntimeResumeAcceptedPayload,
  type RuntimeResumeAction,
  type RuntimeResumeDecision,
  type RuntimeResumePayload,
  type RuntimeResumeResponse,
  type RuntimeResultClassification,
  type RuntimeRunAssignedPayload,
  type RuntimeRunCancelPayload,
  type RuntimeRunCancelAckPayload,
  type RuntimeRunCancellationState,
  type RuntimeRunEventAckPayload,
  type RuntimeRunEventPayload,
  type RuntimeRunLeaseRevokedPayload,
  type RuntimeRunResultAckPayload,
  type RuntimeRunResultPayload,
  type RuntimeRunStatus,
  type RuntimeSessionCloseRequest,
} from "./runtime-types.js";
import type { JsonObject } from "./types.js";

type RuntimeWireObject = Record<string, unknown>;

export interface RuntimeDecodedEnvelope {
  protocolVersion: number;
  runtimeContractId: string;
  messageId: string;
  replyToMessageId?: string;
  type: RuntimeMessageType;
  sentAt: string;
  payload: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const DISPATCH_STATES = new Set<RuntimeDispatchState>([
  "pending", "offered", "executing", "retry_wait", "terminal", "dead_letter",
]);
const RUN_STATUSES = new Set<RuntimeRunStatus>([
  "running", "success", "failed", "timeout", "canceled",
]);
const RESULT_CLASSIFICATIONS = new Set<RuntimeResultClassification>([
  "success", "retryable_failure", "non_retryable_failure", "timeout", "canceled", "dead_letter",
]);
const ERROR_CODES = new Set<RuntimeErrorCode>([
  "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "PERMISSION_DENIED", "NOT_FOUND", "CONFLICT",
  "VALIDATION_FAILED", "RATE_LIMITED", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE",
  "IDEMPOTENCY_KEY_REUSED", "RUN_ALREADY_TERMINAL", "STALE_LEASE", "LEASE_EXPIRED",
  "LEASE_IDENTITY_MISMATCH", "RESULT_ID_CONFLICT", "EVENT_ID_CONFLICT", "NODE_AT_CAPACITY",
  "RUNTIME_CLIENT_UPGRADE_REQUIRED", "RUNTIME_REQUIRED_FEATURE_MISSING", "RUN_CANCEL_REQUESTED",
  "RUN_CANCEL_UNCONFIRMED", "RUNTIME_RETRY_EXHAUSTED", "RUNTIME_DISPATCH_TIMEOUT",
  "RUN_DEADLINE_EXCEEDED", "EVENTS_MISSING", "REPLAY_INPUT_UNAVAILABLE", "ENDPOINT_RESULT_UNKNOWN",
  "RUNTIME_SESSION_CONFLICT", "RUNTIME_SPOOL_CORRUPT",
]);

export async function readRuntimeJSON(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > RuntimeMaxMessageBytes) {
      throw runtimeError("response exceeds 4 MiB");
    }
  }
  if (!response.body) {
    throw runtimeError("response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > RuntimeMaxMessageBytes) {
        await reader.cancel();
        throw runtimeError("response exceeds 4 MiB");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text.trim()) {
    throw runtimeError("response body is empty");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw runtimeError("response is not one complete JSON value", cause);
  }
}

export function assertRuntimeWaitSeconds(value: number): void {
  assertInteger(value, 0, RuntimeMaxPullWaitSeconds, "waitSeconds");
}

export function assertRuntimeUUID(value: unknown, label: string): string {
  return assertUUID(value, label);
}

export function encodeRuntimeEnvelope(
  type: RuntimeMessageType,
  messageId: string,
  sentAt: string,
  payload: unknown,
  replyToMessageId?: string,
): RuntimeWireObject {
  if (!Object.values(RuntimeMessageTypes).includes(type)) {
    throw runtimeError("envelope.type is invalid");
  }
  assertUUID(messageId, "envelope.messageId");
  assertTimestamp(sentAt, "envelope.sentAt");
  const wire: RuntimeWireObject = {
    protocol_version: 2,
    runtime_contract_id: "openlinker.runtime.v2",
    message_id: messageId,
    type,
    sent_at: sentAt,
    payload,
  };
  if (replyToMessageId !== undefined) {
    wire.reply_to_message_id = assertUUID(replyToMessageId, "envelope.replyToMessageId");
  }
  return wire;
}

export function decodeRuntimeEnvelope(value: unknown): RuntimeDecodedEnvelope {
  const object = exactObject(value, [
    "protocol_version", "runtime_contract_id", "message_id", "type", "sent_at", "payload",
  ], ["reply_to_message_id"], "Runtime envelope");
  if (object.protocol_version !== 2 || object.runtime_contract_id !== "openlinker.runtime.v2") {
    throw runtimeError("Runtime envelope contract is not supported");
  }
  if (typeof object.type !== "string" || !Object.values(RuntimeMessageTypes).includes(
    object.type as RuntimeMessageType,
  )) {
    throw runtimeError("Runtime envelope.type is invalid");
  }
  const decoded: RuntimeDecodedEnvelope = {
    protocolVersion: 2,
    runtimeContractId: "openlinker.runtime.v2",
    messageId: assertUUID(object.message_id, "Runtime envelope.message_id"),
    type: object.type as RuntimeMessageType,
    sentAt: assertTimestamp(object.sent_at, "Runtime envelope.sent_at"),
    payload: object.payload,
  };
  if (hasOwn(object, "reply_to_message_id")) {
    decoded.replyToMessageId = assertUUID(
      object.reply_to_message_id,
      "Runtime envelope.reply_to_message_id",
    );
  }
  return decoded;
}

export function encodeRuntimeHello(value: RuntimeHelloPayload): RuntimeWireObject {
  exactObject(value, [
    "nodeId", "agentId", "workerId", "runtimeSessionId", "sessionEpoch",
    "nodeVersion", "capacity", "features", "contractDigest",
  ], [], "hello");
  assertUUID(value.nodeId, "hello.nodeId");
  assertUUID(value.agentId, "hello.agentId");
  assertText(value.workerId, 200, "hello.workerId");
  assertUUID(value.runtimeSessionId, "hello.runtimeSessionId");
  assertInteger(value.sessionEpoch, 1, undefined, "hello.sessionEpoch");
  assertText(value.nodeVersion, 100, "hello.nodeVersion");
  assertCapacity(value.capacity, "hello.capacity");
  const features = assertFeatures(value.features, true, "hello.features");
  if (value.contractDigest !== RuntimeContractDigest) {
    throw runtimeError("hello.contractDigest does not match the packaged contract");
  }
  return {
    node_id: value.nodeId,
    agent_id: value.agentId,
    worker_id: value.workerId,
    runtime_session_id: value.runtimeSessionId,
    session_epoch: value.sessionEpoch,
    node_version: value.nodeVersion,
    capacity: value.capacity,
    features,
    contract_digest: value.contractDigest,
  };
}

export function decodeRuntimeReady(value: unknown): RuntimeReadyPayload {
  const object = exactObject(value, [
    "core_instance_id", "attachment_id", "features", "offer_ttl_seconds", "lease_ttl_seconds",
    "database_time",
  ], [], "ready response");
  const coreInstanceId = assertUUID(object.core_instance_id, "ready.core_instance_id");
  const attachmentId = assertUUID(object.attachment_id, "ready.attachment_id");
  const features = assertFeatures(object.features, true, "ready.features");
  const offerTtlSeconds = assertInteger(object.offer_ttl_seconds, 1, undefined, "ready.offer_ttl_seconds");
  const leaseTtlSeconds = assertInteger(object.lease_ttl_seconds, 1, undefined, "ready.lease_ttl_seconds");
  const databaseTime = assertTimestamp(object.database_time, "ready.database_time");
  return { coreInstanceId, attachmentId, features, offerTtlSeconds, leaseTtlSeconds, databaseTime };
}

export function encodeRuntimeSessionClose(value: RuntimeSessionCloseRequest): RuntimeWireObject {
  exactObject(value, [
    "nodeId", "agentId", "workerId", "runtimeSessionId", "sessionEpoch", "status", "reason",
  ], [], "session close");
  assertUUID(value.nodeId, "session close.nodeId");
  assertUUID(value.agentId, "session close.agentId");
  assertText(value.workerId, 200, "session close.workerId");
  assertUUID(value.runtimeSessionId, "session close.runtimeSessionId");
  assertInteger(value.sessionEpoch, 1, undefined, "session close.sessionEpoch");
  if (value.status !== "offline" && value.status !== "closed") {
    throw runtimeError("session close.status is invalid");
  }
  assertText(value.reason, 200, "session close.reason");
  return {
    node_id: value.nodeId,
    agent_id: value.agentId,
    worker_id: value.workerId,
    runtime_session_id: value.runtimeSessionId,
    session_epoch: value.sessionEpoch,
    status: value.status,
    reason: value.reason,
  };
}

export function encodeRuntimeDrain(value: RuntimeDrainPayload): RuntimeWireObject {
  exactObject(value, ["deadlineAt", "reasonCode", "capacity", "inflight"], [], "drain");
  const deadlineAt = assertTimestamp(value.deadlineAt, "drain.deadlineAt");
  const reasonCode = assertText(value.reasonCode, 120, "drain.reasonCode");
  if (value.capacity !== 0) throw runtimeError("drain.capacity must be zero");
  const inflight = assertInteger(value.inflight, 0, undefined, "drain.inflight");
  return {
    deadline_at: deadlineAt,
    reason_code: reasonCode,
    capacity: 0,
    inflight,
  };
}

export function decodeRuntimeDrain(value: unknown): RuntimeDrainPayload {
  return decodeDrain(value, "drain response");
}

export function encodeRuntimeClaim(value: RuntimeClaimRequest): RuntimeWireObject {
  exactObject(value, ["runtimeSessionId", "capacity", "inflight"], [], "claim");
  assertUUID(value.runtimeSessionId, "claim.runtimeSessionId");
  assertCapacity(value.capacity, "claim.capacity");
  assertCapacity(value.inflight, "claim.inflight");
  return {
    runtime_session_id: value.runtimeSessionId,
    capacity: value.capacity,
    inflight: value.inflight,
  };
}

export function decodeRuntimeAssignment(value: unknown): RuntimeRunAssignedPayload {
  const object = exactObject(value, [
    "attempt_identity", "offer_no", "offer_expires_at", "attempt_deadline_at",
    "run_deadline_at", "input", "node_envelope", "agent_invocation_token",
  ], ["metadata"], "assignment response");
  const assigned: RuntimeRunAssignedPayload = {
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, "assignment.attempt_identity"),
    offerNo: assertInteger(object.offer_no, 1, undefined, "assignment.offer_no"),
    offerExpiresAt: assertTimestamp(object.offer_expires_at, "assignment.offer_expires_at"),
    attemptDeadlineAt: assertTimestamp(object.attempt_deadline_at, "assignment.attempt_deadline_at"),
    runDeadlineAt: assertTimestamp(object.run_deadline_at, "assignment.run_deadline_at"),
    input: assertJSONObject(object.input, "assignment.input"),
    nodeEnvelope: assertText(object.node_envelope, undefined, "assignment.node_envelope"),
    agentInvocationToken: assertText(object.agent_invocation_token, undefined, "assignment.agent_invocation_token"),
  };
  if (hasOwn(object, "metadata")) {
    assigned.metadata = assertJSONObject(object.metadata, "assignment.metadata");
  }
  return assigned;
}

export function encodeRuntimeAssignmentAck(value: RuntimeAssignmentAckPayload): RuntimeWireObject {
  exactObject(value, ["attemptIdentity"], [], "assignment ACK");
  return { attempt_identity: encodeAttemptIdentity(value.attemptIdentity, "assignment ACK.attemptIdentity") };
}

export function decodeRuntimeAssignmentConfirmed(value: unknown): RuntimeAssignmentConfirmedPayload {
  const object = exactObject(value, ["attempt_identity", "attempt_no", "lease_expires_at"], [], "assignment confirmation");
  return {
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, "assignment confirmation.attempt_identity"),
    attemptNo: assertInteger(object.attempt_no, 1, undefined, "assignment confirmation.attempt_no"),
    leaseExpiresAt: assertTimestamp(object.lease_expires_at, "assignment confirmation.lease_expires_at"),
  };
}

export function encodeRuntimeAssignmentReject(value: RuntimeAssignmentRejectPayload): RuntimeWireObject {
  exactObject(value, ["attemptIdentity", "reasonCode", "capacity", "inflight"], [], "assignment rejection");
  if (!Object.values(RuntimeAssignmentRejectReasons).includes(value.reasonCode)) {
    throw runtimeError("assignment rejection.reasonCode is invalid");
  }
  assertCapacity(value.capacity, "assignment rejection.capacity");
  assertCapacity(value.inflight, "assignment rejection.inflight");
  return {
    attempt_identity: encodeAttemptIdentity(value.attemptIdentity, "assignment rejection.attemptIdentity"),
    reason_code: value.reasonCode,
    capacity: value.capacity,
    inflight: value.inflight,
  };
}

export function decodeRuntimeAssignmentRejected(value: unknown): RuntimeAssignmentRejectedPayload {
  const object = exactObject(value, ["attempt_identity", "outcome", "dispatch_state"], [], "assignment rejection response");
  const outcome = object.outcome;
  if (outcome !== "offer_rejected" && outcome !== "lease_revoked") {
    throw runtimeError("assignment rejection response.outcome is invalid");
  }
  return {
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, "assignment rejection response.attempt_identity"),
    outcome,
    dispatchState: assertDispatchState(object.dispatch_state, "assignment rejection response.dispatch_state"),
  };
}

export function encodeRuntimeLeaseRenew(value: RuntimeLeaseRenewPayload): RuntimeWireObject {
  exactObject(value, ["attemptIdentity", "lastClientEventSeq", "capacity", "inflight"], [], "lease renewal");
  assertInteger(value.lastClientEventSeq, 0, undefined, "lease renewal.lastClientEventSeq");
  assertCapacity(value.capacity, "lease renewal.capacity");
  assertCapacity(value.inflight, "lease renewal.inflight");
  return {
    attempt_identity: encodeAttemptIdentity(value.attemptIdentity, "lease renewal.attemptIdentity"),
    last_client_event_seq: value.lastClientEventSeq,
    capacity: value.capacity,
    inflight: value.inflight,
  };
}

export function decodeRuntimeLeaseRenewed(value: unknown): RuntimeLeaseRenewedPayload {
  const object = exactObject(value, ["attempt_identity", "lease_expires_at"], ["pending_command"], "lease renewal response");
  const renewed: RuntimeLeaseRenewedPayload = {
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, "lease renewal response.attempt_identity"),
    leaseExpiresAt: assertTimestamp(object.lease_expires_at, "lease renewal response.lease_expires_at"),
  };
  if (hasOwn(object, "pending_command")) {
    renewed.pendingCommand = object.pending_command === null
      ? null
      : decodePendingCommand(object.pending_command, "lease renewal response.pending_command");
  }
  return renewed;
}

export function encodeRuntimeEvent(value: RuntimeRunEventPayload): RuntimeWireObject {
  exactObject(value, ["attemptIdentity", "clientEventId", "clientEventSeq", "eventType", "payload"], [], "Event");
  assertUUID(value.clientEventId, "Event.clientEventId");
  assertInteger(value.clientEventSeq, 1, undefined, "Event.clientEventSeq");
  assertText(value.eventType, 120, "Event.eventType");
  if (!EVENT_TYPE_PATTERN.test(value.eventType)) {
    throw runtimeError("Event.eventType is not canonical");
  }
  return {
    attempt_identity: encodeAttemptIdentity(value.attemptIdentity, "Event.attemptIdentity"),
    client_event_id: value.clientEventId,
    client_event_seq: value.clientEventSeq,
    event_type: value.eventType,
    payload: assertJSONObject(value.payload, "Event.payload"),
  };
}

export function decodeRuntimeEventAck(value: unknown): RuntimeRunEventAckPayload {
  const object = exactObject(value, ["client_event_id", "client_event_seq", "sequence", "replayed"], [], "Event ACK");
  return {
    clientEventId: assertUUID(object.client_event_id, "Event ACK.client_event_id"),
    clientEventSeq: assertInteger(object.client_event_seq, 1, undefined, "Event ACK.client_event_seq"),
    sequence: assertInteger(object.sequence, 1, undefined, "Event ACK.sequence"),
    replayed: assertBoolean(object.replayed, "Event ACK.replayed"),
  };
}

export function encodeRuntimeResult(value: RuntimeRunResultPayload): RuntimeWireObject {
  exactObject(value, ["attemptIdentity", "resultId", "status", "durationMs", "finalClientEventSeq"], ["output", "error"], "Result");
  assertUUID(value.resultId, "Result.resultId");
  assertInteger(value.durationMs, 0, undefined, "Result.durationMs");
  assertInteger(value.finalClientEventSeq, 0, undefined, "Result.finalClientEventSeq");
  const wire: RuntimeWireObject = {
    attempt_identity: encodeAttemptIdentity(value.attemptIdentity, "Result.attemptIdentity"),
    result_id: value.resultId,
    status: value.status,
    duration_ms: value.durationMs,
    final_client_event_seq: value.finalClientEventSeq,
  };
  if (value.status === "success") {
    if (value.error !== undefined) {
      throw runtimeError("successful Result cannot contain error");
    }
    wire.output = assertJSONObject(value.output, "Result.output");
    return wire;
  }
  if (value.status !== "failed" || value.output !== undefined || value.error === undefined) {
    throw runtimeError("failed Result must contain only error");
  }
  const error = exactObject(value.error, ["errorCode", "message"], ["retryableHint"], "Result.error");
  const wireError: RuntimeWireObject = {
    error_code: assertText(error.errorCode, 120, "Result.error.errorCode"),
    message: assertText(error.message, 500, "Result.error.message"),
  };
  if (hasOwn(error, "retryableHint")) {
    wireError.retryable_hint = assertBoolean(error.retryableHint, "Result.error.retryableHint");
  }
  wire.error = wireError;
  return wire;
}

export function decodeRuntimeResultAck(value: unknown): RuntimeRunResultAckPayload {
  const object = exactObject(value, [
    "result_id", "classification", "run_status", "dispatch_state", "replayed",
  ], ["next_attempt_at"], "Result ACK");
  const classification = object.classification;
  if (typeof classification !== "string" || !RESULT_CLASSIFICATIONS.has(classification as RuntimeResultClassification)) {
    throw runtimeError("Result ACK.classification is invalid");
  }
  const ack: RuntimeRunResultAckPayload = {
    resultId: assertUUID(object.result_id, "Result ACK.result_id"),
    classification: classification as RuntimeResultClassification,
    runStatus: assertRunStatus(object.run_status, "Result ACK.run_status"),
    dispatchState: assertDispatchState(object.dispatch_state, "Result ACK.dispatch_state"),
    replayed: assertBoolean(object.replayed, "Result ACK.replayed"),
  };
  if (hasOwn(object, "next_attempt_at")) {
    ack.nextAttemptAt = assertTimestamp(object.next_attempt_at, "Result ACK.next_attempt_at");
  }
  return ack;
}

export function encodeRuntimeResume(value: RuntimeResumePayload): RuntimeWireObject {
  exactObject(value, ["nodeId", "agentId", "workerId", "runtimeSessionId", "attempts"], [], "Resume");
  assertUUID(value.nodeId, "Resume.nodeId");
  assertUUID(value.agentId, "Resume.agentId");
  assertText(value.workerId, 200, "Resume.workerId");
  assertUUID(value.runtimeSessionId, "Resume.runtimeSessionId");
  if (!Array.isArray(value.attempts) || value.attempts.length > RuntimeMaxResumeAttempts) {
    throw runtimeError("Resume.attempts is invalid");
  }
  const seen = new Set<string>();
  const attempts = value.attempts.map((attempt, index) => {
    const label = `Resume.attempts[${index}]`;
    exactObject(attempt, ["attemptIdentity", "lastAckedClientEventSeq", "pendingClientEventRanges"], [
      "pendingResultId", "finalClientEventSeq",
    ], label);
    const identity = encodeAttemptIdentity(attempt.attemptIdentity, `${label}.attemptIdentity`);
    if (attempt.attemptIdentity.nodeId !== value.nodeId || attempt.attemptIdentity.agentId !== value.agentId ||
      attempt.attemptIdentity.workerId !== value.workerId) {
      throw runtimeError(`${label} does not match the target Node identity`);
    }
    const identityKey = runtimeIdentityKey(attempt.attemptIdentity);
    if (seen.has(identityKey)) {
      throw runtimeError("Resume contains a duplicate Attempt identity");
    }
    seen.add(identityKey);
    assertInteger(attempt.lastAckedClientEventSeq, 0, undefined, `${label}.lastAckedClientEventSeq`);
    if (!Array.isArray(attempt.pendingClientEventRanges)) {
      throw runtimeError(`${label}.pendingClientEventRanges is invalid`);
    }
    let previous = attempt.lastAckedClientEventSeq;
    const ranges = attempt.pendingClientEventRanges.map((range, rangeIndex) => {
      const rangeLabel = `${label}.pendingClientEventRanges[${rangeIndex}]`;
      exactObject(range, ["start", "end"], [], rangeLabel);
      const start = assertInteger(range.start, 1, undefined, `${rangeLabel}.start`);
      const end = assertInteger(range.end, start, undefined, `${rangeLabel}.end`);
      if (start <= previous) {
        throw runtimeError(`${rangeLabel} overlaps or precedes acknowledged Events`);
      }
      previous = end;
      return { start, end };
    });
    const hasResult = attempt.pendingResultId !== undefined;
    const hasFinalSequence = attempt.finalClientEventSeq !== undefined;
    if (hasResult !== hasFinalSequence) {
      throw runtimeError(`${label} must provide pendingResultId and finalClientEventSeq together`);
    }
    const wire: RuntimeWireObject = {
      attempt_identity: identity,
      last_acked_client_event_seq: attempt.lastAckedClientEventSeq,
      pending_client_event_ranges: ranges,
    };
    if (hasResult && hasFinalSequence) {
      wire.pending_result_id = assertUUID(attempt.pendingResultId, `${label}.pendingResultId`);
      wire.final_client_event_seq = assertInteger(
        attempt.finalClientEventSeq, previous, undefined, `${label}.finalClientEventSeq`,
      );
    }
    return wire;
  });
  return {
    node_id: value.nodeId,
    agent_id: value.agentId,
    worker_id: value.workerId,
    runtime_session_id: value.runtimeSessionId,
    attempts,
  };
}

export function decodeRuntimeResumeResponse(value: unknown): RuntimeResumeResponse {
  const object = exactObject(value, ["decisions"], [], "Resume response");
  if (!Array.isArray(object.decisions)) {
    throw runtimeError("Resume response.decisions is invalid");
  }
  return {
    decisions: object.decisions.map((decision, index) => decodeResumeDecision(decision, index)),
  };
}

export function decodeRuntimeCommandsResponse(value: unknown): RuntimeCommandsResponse {
  const object = exactObject(value, ["commands", "database_time"], [], "commands response");
  if (!Array.isArray(object.commands)) {
    throw runtimeError("commands response.commands is invalid");
  }
  return {
    commands: object.commands.map((command, index) => decodePendingCommand(command, `commands response.commands[${index}]`)),
    databaseTime: assertTimestamp(object.database_time, "commands response.database_time"),
  };
}

export function decodeRuntimePendingCommand(value: unknown): RuntimePendingCommand {
  return decodePendingCommand(value, "Runtime command");
}

export function decodeRuntimeResumeAccepted(value: unknown): RuntimeResumeAcceptedPayload {
  return decodeResumeDecision(value, 0);
}

export function encodeRuntimeCancelAck(value: RuntimeRunCancelAckPayload): RuntimeWireObject {
  const source = exactObject(value, ["cancellationId", "attemptIdentity", "cancelState"], ["errorCode"], "cancel ACK");
  assertUUID(value.cancellationId, "cancel ACK.cancellationId");
  const cancelState = assertCancelState(value.cancelState, "cancel ACK.cancelState");
  const hasError = hasOwn(source, "errorCode") && value.errorCode !== undefined;
  switch (cancelState) {
    case RuntimeCancelStates.delivered:
    case RuntimeCancelStates.stopping:
    case RuntimeCancelStates.stopped:
      if (hasError) {
        throw runtimeError("cancel ACK.errorCode is not allowed for a successful stop state");
      }
      break;
    case RuntimeCancelStates.unsupported:
    case RuntimeCancelStates.failed:
      if (!hasError) {
        throw runtimeError("cancel ACK.errorCode is required for a negative stop state");
      }
      break;
    default:
      throw runtimeError("cancel ACK.cancelState is not an acknowledgement state");
  }
  const wire: RuntimeWireObject = {
    cancellation_id: value.cancellationId,
    attempt_identity: encodeAttemptIdentity(value.attemptIdentity, "cancel ACK.attemptIdentity"),
    cancel_state: cancelState,
  };
  if (hasError) {
    wire.error_code = assertText(value.errorCode, 120, "cancel ACK.errorCode");
  }
  return wire;
}

export function decodeRuntimeCancellationState(value: unknown): RuntimeRunCancellationState {
  const object = exactObject(value, ["cancellation_id", "cancel_state", "updated_at"], ["error_code"], "cancellation state");
  const state: RuntimeRunCancellationState = {
    cancellationId: assertUUID(object.cancellation_id, "cancellation state.cancellation_id"),
    cancelState: assertCancelState(object.cancel_state, "cancellation state.cancel_state"),
    updatedAt: assertTimestamp(object.updated_at, "cancellation state.updated_at"),
  };
  if (hasOwn(object, "error_code")) {
    state.errorCode = assertText(object.error_code, 120, "cancellation state.error_code");
  }
  const hasError = state.errorCode !== undefined;
  switch (state.cancelState) {
    case RuntimeCancelStates.requested:
    case RuntimeCancelStates.delivered:
    case RuntimeCancelStates.stopping:
    case RuntimeCancelStates.stopped:
      if (hasError) {
        throw runtimeError("cancellation state.error_code is not allowed for a successful stop state");
      }
      break;
    case RuntimeCancelStates.unsupported:
    case RuntimeCancelStates.failed:
    case RuntimeCancelStates.unconfirmed:
      if (!hasError) {
        throw runtimeError("cancellation state.error_code is required for a negative stop state");
      }
      break;
  }
  return state;
}

export function encodeRuntimeCallAgent(value: RuntimeCallAgentRequest): RuntimeWireObject {
  const source = exactObject(value, ["targetAgentId", "input"], ["metadata", "reason"], "delegated call");
  const wire: RuntimeWireObject = {
    target_agent_id: assertUUID(value.targetAgentId, "delegated call.targetAgentId"),
    input: assertJSONObject(value.input, "delegated call.input"),
  };
  if (hasOwn(source, "metadata")) {
    wire.metadata = assertJSONObject(value.metadata, "delegated call.metadata");
  }
  if (hasOwn(source, "reason")) {
    wire.reason = assertOptionalText(value.reason, 500, "delegated call.reason");
  }
  return wire;
}

export function decodeRuntimeRunSummary(value: unknown): RuntimeRunSummary {
  const object = exactObject(value, ["run_id", "status", "dispatch_state"], [], "delegated call response");
  const summary: RuntimeRunSummary = {
    runId: assertUUID(object.run_id, "delegated call response.run_id"),
    status: assertRunStatus(object.status, "delegated call response.status"),
    dispatchState: assertDispatchState(object.dispatch_state, "delegated call response.dispatch_state"),
  };
  switch (summary.status) {
    case "running":
      if (!["pending", "offered", "executing", "retry_wait"].includes(summary.dispatchState)) {
        throw runtimeError("delegated call response has an incoherent running state");
      }
      break;
    case "success":
    case "timeout":
    case "canceled":
      if (summary.dispatchState !== "terminal") {
        throw runtimeError("delegated call response has an incoherent terminal state");
      }
      break;
    case "failed":
      if (summary.dispatchState !== "terminal" && summary.dispatchState !== "dead_letter") {
        throw runtimeError("delegated call response has an incoherent failed state");
      }
      break;
  }
  return summary;
}

export function decodeRuntimeErrorEnvelope(value: unknown): RuntimeErrorEnvelope {
  const envelope = exactObject(value, ["error"], [], "error response");
  const object = exactObject(envelope.error, ["code", "message"], [
    "retryable", "missing_event_ranges", "current_run_status", "current_dispatch_state",
  ], "error response.error");
  if (typeof object.code !== "string" || !ERROR_CODES.has(object.code as RuntimeErrorCode)) {
    throw runtimeError("error response.error.code is invalid");
  }
  const error: RuntimeErrorBody = {
    code: object.code as RuntimeErrorCode,
    message: assertText(object.message, 500, "error response.error.message"),
  };
  if (hasOwn(object, "retryable")) {
    error.retryable = assertBoolean(object.retryable, "error response.error.retryable");
  }
  if (hasOwn(object, "missing_event_ranges")) {
    if (!Array.isArray(object.missing_event_ranges)) {
      throw runtimeError("error response.error.missing_event_ranges is invalid");
    }
    error.missingEventRanges = object.missing_event_ranges.map((range, index) =>
      decodeEventRange(range, `error response.error.missing_event_ranges[${index}]`));
  }
  if (hasOwn(object, "current_run_status")) {
    error.currentRunStatus = assertRunStatus(object.current_run_status, "error response.error.current_run_status");
  }
  if (hasOwn(object, "current_dispatch_state")) {
    error.currentDispatchState = assertDispatchState(
      object.current_dispatch_state, "error response.error.current_dispatch_state",
    );
  }
  return { error };
}

export function runtimeAttemptIdentityEqual(
  left: RuntimeAttemptIdentity,
  right: RuntimeAttemptIdentity,
): boolean {
  return left.runId === right.runId && left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId && left.fencingToken === right.fencingToken &&
    left.nodeId === right.nodeId && left.agentId === right.agentId &&
    left.workerId === right.workerId && left.runtimeSessionId === right.runtimeSessionId;
}

function encodeAttemptIdentity(value: RuntimeAttemptIdentity, label: string): RuntimeWireObject {
  exactObject(value, [
    "runId", "attemptId", "leaseId", "fencingToken", "nodeId", "agentId", "workerId", "runtimeSessionId",
  ], [], label);
  assertUUID(value.runId, `${label}.runId`);
  assertUUID(value.attemptId, `${label}.attemptId`);
  assertUUID(value.leaseId, `${label}.leaseId`);
  assertInteger(value.fencingToken, 1, undefined, `${label}.fencingToken`);
  assertUUID(value.nodeId, `${label}.nodeId`);
  assertUUID(value.agentId, `${label}.agentId`);
  assertText(value.workerId, 200, `${label}.workerId`);
  assertUUID(value.runtimeSessionId, `${label}.runtimeSessionId`);
  return {
    run_id: value.runId,
    attempt_id: value.attemptId,
    lease_id: value.leaseId,
    fencing_token: value.fencingToken,
    node_id: value.nodeId,
    agent_id: value.agentId,
    worker_id: value.workerId,
    runtime_session_id: value.runtimeSessionId,
  };
}

function decodeAttemptIdentity(value: unknown, label: string): RuntimeAttemptIdentity {
  const object = exactObject(value, [
    "run_id", "attempt_id", "lease_id", "fencing_token", "node_id", "agent_id", "worker_id", "runtime_session_id",
  ], [], label);
  return {
    runId: assertUUID(object.run_id, `${label}.run_id`),
    attemptId: assertUUID(object.attempt_id, `${label}.attempt_id`),
    leaseId: assertUUID(object.lease_id, `${label}.lease_id`),
    fencingToken: assertInteger(object.fencing_token, 1, undefined, `${label}.fencing_token`),
    nodeId: assertUUID(object.node_id, `${label}.node_id`),
    agentId: assertUUID(object.agent_id, `${label}.agent_id`),
    workerId: assertText(object.worker_id, 200, `${label}.worker_id`),
    runtimeSessionId: assertUUID(object.runtime_session_id, `${label}.runtime_session_id`),
  };
}

function decodePendingCommand(value: unknown, label: string): RuntimePendingCommand {
  const object = exactObject(value, ["type", "payload"], [], label);
  switch (object.type) {
    case RuntimeMessageTypes.runCancel:
      return { type: object.type, payload: decodeRunCancel(object.payload, `${label}.payload`) };
    case RuntimeMessageTypes.drain:
      return { type: object.type, payload: decodeDrain(object.payload, `${label}.payload`) };
    case RuntimeMessageTypes.leaseRevoked:
      return { type: object.type, payload: decodeLeaseRevoked(object.payload, `${label}.payload`) };
    default:
      throw runtimeError(`${label}.type is invalid`);
  }
}

function decodeRunCancel(value: unknown, label: string): RuntimeRunCancelPayload {
  const object = exactObject(value, ["cancellation_id", "attempt_identity", "reason_code", "deadline_at"], [], label);
  return {
    cancellationId: assertUUID(object.cancellation_id, `${label}.cancellation_id`),
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, `${label}.attempt_identity`),
    reasonCode: assertText(object.reason_code, 120, `${label}.reason_code`),
    deadlineAt: assertTimestamp(object.deadline_at, `${label}.deadline_at`),
  };
}

function decodeDrain(value: unknown, label: string): RuntimeDrainPayload {
  const object = exactObject(value, ["deadline_at", "reason_code", "capacity", "inflight"], [], label);
  const capacity = assertInteger(object.capacity, 0, undefined, `${label}.capacity`);
  if (capacity !== 0) throw runtimeError(`${label}.capacity must be zero`);
  return {
    deadlineAt: assertTimestamp(object.deadline_at, `${label}.deadline_at`),
    reasonCode: assertText(object.reason_code, 120, `${label}.reason_code`),
    capacity,
    inflight: assertInteger(object.inflight, 0, undefined, `${label}.inflight`),
  };
}

function decodeLeaseRevoked(value: unknown, label: string): RuntimeRunLeaseRevokedPayload {
  const object = exactObject(value, ["attempt_identity", "reason_code", "dispatch_state", "run_status"], [], label);
  return {
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, `${label}.attempt_identity`),
    reasonCode: assertText(object.reason_code, 120, `${label}.reason_code`),
    dispatchState: assertDispatchState(object.dispatch_state, `${label}.dispatch_state`),
    runStatus: assertRunStatus(object.run_status, `${label}.run_status`),
  };
}

function decodeResumeDecision(value: unknown, index: number): RuntimeResumeAcceptedPayload {
  const label = `Resume response.decisions[${index}]`;
  const object = exactObject(value, ["attempt_identity", "decision", "allowed_actions"], ["lease_expires_at"], label);
  if (typeof object.decision !== "string" || !Object.values(RuntimeResumeDecisions).includes(
    object.decision as (typeof RuntimeResumeDecisions)[keyof typeof RuntimeResumeDecisions],
  )) {
    throw runtimeError(`${label}.decision is invalid`);
  }
  if (!Array.isArray(object.allowed_actions)) {
    throw runtimeError(`${label}.allowed_actions is invalid`);
  }
  const actions = object.allowed_actions.map((action, actionIndex) => {
    if (typeof action !== "string" || !Object.values(RuntimeResumeActions).includes(action as RuntimeResumeAction)) {
      throw runtimeError(`${label}.allowed_actions[${actionIndex}] is invalid`);
    }
    return action as RuntimeResumeAction;
  });
  if (new Set(actions).size !== actions.length) {
    throw runtimeError(`${label}.allowed_actions contains duplicates`);
  }
  const hasLease = hasOwn(object, "lease_expires_at");
  const actionSet = new Set(actions);
  switch (object.decision) {
    case RuntimeResumeDecisions.continueExecution:
      if (!hasLease || actions.length !== 3 || !actionSet.has(RuntimeResumeActions.continueExecution) ||
        !actionSet.has(RuntimeResumeActions.uploadEvents) || !actionSet.has(RuntimeResumeActions.uploadResult)) {
        throw runtimeError(`${label} has incoherent continue_execution actions`);
      }
      break;
    case RuntimeResumeDecisions.uploadSpoolOnly:
      if (hasLease || actions.length < 1 || actions.length > 2 ||
        actions.some((action) => action !== RuntimeResumeActions.uploadEvents && action !== RuntimeResumeActions.uploadResult)) {
        throw runtimeError(`${label} has incoherent upload_spool_only actions`);
      }
      break;
    case RuntimeResumeDecisions.resultAlreadyAcked:
      if (hasLease || actions.length !== 1 || actions[0] !== RuntimeResumeActions.clearSpool) {
        throw runtimeError(`${label} has incoherent result_already_acked actions`);
      }
      break;
    case RuntimeResumeDecisions.leaseRevoked:
      if (hasLease || actions.length !== 2 || !actionSet.has(RuntimeResumeActions.stopExecution) ||
        !actionSet.has(RuntimeResumeActions.clearSpool)) {
        throw runtimeError(`${label} has incoherent lease_revoked actions`);
      }
      break;
  }
  const decoded: RuntimeResumeAcceptedPayload = {
    attemptIdentity: decodeAttemptIdentity(object.attempt_identity, `${label}.attempt_identity`),
    decision: object.decision as RuntimeResumeDecision,
    allowedActions: actions,
  };
  if (hasLease) {
    decoded.leaseExpiresAt = assertTimestamp(object.lease_expires_at, `${label}.lease_expires_at`);
  }
  return decoded;
}

function decodeEventRange(value: unknown, label: string): RuntimeEventRange {
  const object = exactObject(value, ["start", "end"], [], label);
  const start = assertInteger(object.start, 1, undefined, `${label}.start`);
  const end = assertInteger(object.end, start, undefined, `${label}.end`);
  return { start, end };
}

function runtimeIdentityKey(value: RuntimeAttemptIdentity): string {
  return [
    value.runId, value.attemptId, value.leaseId, value.fencingToken,
    value.nodeId, value.agentId, value.workerId, value.runtimeSessionId,
  ].join("\u0000");
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): RuntimeWireObject {
  if (!isObject(value)) {
    throw runtimeError(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw runtimeError(`${label} contains unknown field ${key}`);
    }
  }
  for (const key of required) {
    if (!hasOwn(value, key)) {
      throw runtimeError(`${label} is missing field ${key}`);
    }
  }
  return value;
}

function assertJSONObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw runtimeError(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function assertUUID(value: unknown, label: string): string {
  if (typeof value !== "string" || value === NIL_UUID || !UUID_PATTERN.test(value)) {
    throw runtimeError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw runtimeError(`${label} must be an RFC 3339 timestamp`);
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw runtimeError(`${label} must be an RFC 3339 timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (month < 1 || month > 12 || day < 1 || day > runtimeDaysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))) {
    throw runtimeError(`${label} must be an RFC 3339 timestamp`);
  }
  return value;
}

function runtimeDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertText(value: unknown, maximum: number | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim() || (maximum !== undefined && [...value].length > maximum)) {
    throw runtimeError(`${label} must be non-empty text${maximum === undefined ? "" : ` up to ${maximum} characters`}`);
  }
  return value;
}

function assertOptionalText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || [...value].length > maximum) {
    throw runtimeError(`${label} must be text up to ${maximum} characters`);
  }
  return value;
}

function assertInteger(value: unknown, minimum: number, maximum: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum ||
    (maximum !== undefined && value > maximum)) {
    throw runtimeError(`${label} must be a safe integer in range`);
  }
  return value;
}

function assertCapacity(value: unknown, label: string): number {
  return assertInteger(value, 0, RuntimeMaxNodeCapacity, label);
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw runtimeError(`${label} must be a boolean`);
  }
  return value;
}

function assertFeatures(value: unknown, requireProtocol: boolean, label: string): string[] {
  if (!Array.isArray(value)) {
    throw runtimeError(`${label} must be an array`);
  }
  const features = value.map((feature, index) => assertText(feature, 100, `${label}[${index}]`));
  const seen = new Set(features);
  if (seen.size !== features.length) {
    throw runtimeError(`${label} contains duplicates`);
  }
  if (requireProtocol) {
    for (const required of RuntimeRequiredFeatures) {
      if (!seen.has(required)) {
        throw runtimeError(`${label} is missing required feature ${required}`);
      }
    }
  }
  return features;
}

function assertDispatchState(value: unknown, label: string): RuntimeDispatchState {
  if (typeof value !== "string" || !DISPATCH_STATES.has(value as RuntimeDispatchState)) {
    throw runtimeError(`${label} is invalid`);
  }
  return value as RuntimeDispatchState;
}

function assertRunStatus(value: unknown, label: string): RuntimeRunStatus {
  if (typeof value !== "string" || !RUN_STATUSES.has(value as RuntimeRunStatus)) {
    throw runtimeError(`${label} is invalid`);
  }
  return value as RuntimeRunStatus;
}

function assertCancelState(value: unknown, label: string): RuntimeCancelState {
  if (typeof value !== "string" || !Object.values(RuntimeCancelStates).includes(
    value as (typeof RuntimeCancelStates)[keyof typeof RuntimeCancelStates],
  )) {
    throw runtimeError(`${label} is invalid`);
  }
  return value as RuntimeCancelState;
}

function isObject(value: unknown): value is RuntimeWireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RuntimeWireObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function runtimeError(message: string, cause?: unknown): Error {
  return new Error(`OpenLinker Runtime: ${message}`, cause === undefined ? undefined : { cause });
}
