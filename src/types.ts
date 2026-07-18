export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type A2ADialect = "current" | "legacy" | string;

export type ConnectionMode = "direct_http" | "mcp_server" | "runtime";

export type RunStatus =
  "running" | "success" | "failed" | "timeout" | "canceled";

export interface ListAgentsParams {
  query?: string;
  tags?: string[];
  page?: number;
  size?: number;
  callableOnly?: boolean;
}

export interface CreatorMini {
  display_name: string;
}

export interface Availability {
  status: string;
  label: string;
  hint: string;
  last_successful_run_at?: string;
  last_failed_run_at?: string;
  last_checked_at?: string;
  consecutive_failures: number;
}

export interface Readiness {
  listed: boolean;
  discoverable: boolean;
  callable: boolean;
  verified: boolean;
  certified: boolean;
  paid_enabled: boolean;
  agent_card_url: string;
  a2a_endpoint: string;
  last_successful_run_at?: string;
  availability_status: string;
  verified_skill_count: number;
  latest_benchmark_batch_id?: string;
  explanation: Record<string, string>;
}

export interface MarketListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  price_per_call_cents: number;
  tags: string[];
  total_calls: number;
  creator: CreatorMini;
  connection_mode: ConnectionMode | string;
  mcp_tool_name?: string;
  availability: Availability;
  readiness: Readiness;
}

export interface MarketListResponse {
  items: MarketListItem[];
  total: number;
  page: number;
  size: number;
}

export interface SkillMini {
  id: string;
  category: string;
  name: string;
  description: string;
}

export interface AgentDetailResponse extends MarketListItem {
  endpoint_url: string;
  created_at: string;
  certified_at?: string;
  lifecycle_status: string;
  visibility: string;
  certification_status: string;
  verified_skill_count: number;
  latest_benchmark_batch_id?: string;
  skills: SkillMini[];
  capability?: JsonObject;
  examples: JsonObject[];
}

export interface AgentCardResponse {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion?: string;
  protocolVersions?: string[];
  preferredTransport?: string;
  additionalInterfaces?: JsonObject[];
  supportedInterfaces?: JsonObject[];
  supportsAuthenticatedExtendedCard?: boolean;
  provider: JsonObject;
  capabilities: JsonObject;
  default_input_modes: string[];
  default_output_modes: string[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: JsonObject[];
  securitySchemes?: JsonObject;
  security?: Array<Record<string, string[]>>;
  securityRequirements?: Array<Record<string, string[]>>;
  authentication: JsonObject;
  openlinker: JsonObject;
  capability?: JsonObject;
  examples?: JsonObject[];
  signature?: JsonObject;
}

export interface RunAgentRequest {
  agentId: string;
  input: JsonValue;
  /**
   * Stable identity for one logical Run creation operation. Reuse the same
   * key when retrying that operation from a separate SDK method call.
   *
   * When omitted, the SDK generates a cryptographically strong key for this
   * method invocation only.
   */
  idempotencyKey?: string;
  metadata?: JsonValue;
  a2aContext?: RunA2AContext;
  callback?: RunCallbackConfig;
  taskCallback?: TaskCallbackConfig;
  pushNotification?: TaskCallbackConfig;
  pushNotificationConfig?: TaskCallbackConfig;
}

export interface RunA2AContext {
  protocol_context_id?: string;
  protocol_task_id?: string;
  root_context_id?: string;
  parent_context_id?: string;
  parent_task_id?: string;
  parent_run_id?: string;
  caller_agent_id?: string;
  target_agent_id?: string;
  trace_id?: string;
  reference_task_ids?: string[];
  source?: string;
}

export interface PlatformRunCallbackConfig {
  mode?: "platform";
  eventTypes?: string[];
  afterSequence?: number;
  onEvent?: (event: unknown) => void | Promise<void>;
  onTerminal?: (event: unknown) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface WebhookRunCallbackConfig extends TaskCallbackConfig {
  mode: "webhook";
}

export type RunCallbackConfig =
  PlatformRunCallbackConfig | WebhookRunCallbackConfig;

export interface TaskCallbackAuthentication {
  scheme?: string;
  credentials?: string;
}

export interface TaskCallbackConfig {
  url?: string;
  token?: string;
  secret?: string;
  authentication?: TaskCallbackAuthentication;
  metadata?: JsonValue;
  eventTypes?: string[];
  event_types?: string[];
}

export interface TaskCallbackSubscription {
  id: string;
  run_id: string;
  target_url: string;
  event_types: string[];
  auth_scheme?: string;
  status: string;
  consecutive_failures: number;
  secret?: string;
  created_at: string;
  updated_at: string;
}

export interface RunResponse {
  run_id: string;
  agent_id?: string;
  agent_slug?: string;
  agent_name?: string;
  agent_connection_mode?: "direct_http" | "mcp_server" | "runtime" | string;
  status: RunStatus | string;
  input?: JsonValue;
  output?: JsonValue;
  error_code?: string;
  error_message?: string;
  cost_cents: number;
  duration_ms: number;
  started_at: string;
  finished_at?: string;
  source?: string;
  runtime_contract_id: string;
  runtime_transport?: "websocket" | "long_poll" | string;
  runtime_transport_reason?: string;
  runtime_transport_changed_at?: string;
  dispatch_state: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at?: string;
  latest_attempt_id?: string;
  active_attempt_id?: string;
  cancel_state?: string;
  cancel_requested_at?: string;
  cancel_acknowledged_at?: string;
  cancel_reason?: string;
  dead_lettered_at?: string;
  replay_of_run_id?: string;
  parent_run_id?: string;
  caller_agent_id?: string;
  billing_mode?: string;
  a2a_context?: RunA2AContext;
  task_callback?: TaskCallbackSubscription;
  requirement_evidence?: JsonValue;
  evidence_summary?: JsonValue;
  next_action?: JsonValue;
  replayed: boolean;
}

export interface RunEventResponse {
  event_id: string;
  run_id: string;
  parent_run_id?: string;
  sequence: number;
  event_type: string;
  payload: JsonValue;
  created_at: string;
}

export interface ListRunEventsParams {
  afterSequence?: number;
  limit?: number;
}

export interface RunEventPageMeta {
  requested_after_sequence: number;
  effective_after_sequence: number;
  retained_through_sequence: number;
  earliest_available_sequence: number | null;
  latest_available_sequence: number | null;
  retention_gap: boolean;
  terminal: boolean;
  stream_complete: boolean;
}

export interface ListRunEventsResponse {
  items: RunEventResponse[];
  meta: RunEventPageMeta;
}

export interface RunChildResponse {
  child_run_id: string;
  status: string;
}

export interface ListRunChildrenResponse {
  items: RunChildResponse[];
}

export interface RunArtifactResponse {
  id: string;
  run_id: string;
  artifact_type: string;
  title: string;
  content: JsonValue;
  visibility: string;
  source_artifact_id?: string;
  mime_type?: string;
  file_uri?: string;
  file_name?: string;
  file_sha256?: string;
  file_size_bytes?: number;
  created_at: string;
}

export interface RunMessageResponse {
  id: string;
  run_id: string;
  event_sequence?: number;
  role: string;
  content: string;
  payload: JsonValue;
  created_at: string;
}

export interface ListItemsResponse<T> {
  items: T[];
}

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: JsonValue;
}

export interface A2AJsonRpcError {
  code: string | number;
  message: string;
  data?: JsonValue;
}

export interface A2AJsonRpcResponse<T = JsonValue> {
  jsonrpc?: "2.0";
  id?: string | number;
  result?: T;
  error?: A2AJsonRpcError;
}

export interface A2AMessageSendParams {
  message: A2AMessage;
  configuration?: A2ASendConfiguration;
  metadata?: JsonObject;
}

export interface A2ASendConfiguration {
  acceptedOutputModes?: string[];
  blocking?: boolean;
  returnImmediately?: boolean;
  pushNotificationConfig?: A2APushNotificationConfig;
  taskPushNotificationConfig?: A2ATaskPushNotificationConfig;
  historyLength?: number;
}

export interface A2APushNotificationConfig {
  id?: string;
  url?: string;
  token?: string;
  secret?: string;
  authentication?: A2APushAuthenticationInfo;
  metadata?: JsonObject;
  eventTypes?: string[];
  event_types?: string[];
}

export interface A2APushAuthenticationInfo {
  scheme?: string;
  credentials?: string;
}

export interface A2ATaskPushNotificationConfig {
  tenant?: string;
  id?: string;
  taskId?: string;
  url?: string;
  token?: string;
  secret?: string;
  authentication?: A2APushAuthenticationInfo;
  metadata?: JsonObject;
  eventTypes?: string[];
  event_types?: string[];
  pushNotificationConfig?: A2APushNotificationConfig;
}

export interface A2ATaskPushConfigParams {
  id?: string;
  taskId?: string;
  pushNotificationConfigId?: string;
  pushNotificationConfig?: A2APushNotificationConfig;
  url?: string;
  token?: string;
  secret?: string;
  authentication?: A2APushAuthenticationInfo;
  metadata?: JsonObject;
  eventTypes?: string[];
  event_types?: string[];
  pageSize?: number;
  pageToken?: string;
}

export interface A2ATaskPushConfigList {
  configs?: A2ATaskPushNotificationConfig[];
  nextPageToken?: string;
  items?: A2ATaskPushNotificationConfig[];
}

export interface A2ASendMessageResponse {
  task?: A2ATask;
  message?: A2AMessage;
}

export interface A2ATaskQueryParams {
  id: string;
  historyLength?: number;
}

export interface A2ATaskListParams {
  contextId?: string;
  status?: string;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
}

export interface A2ATaskListResponse {
  tasks: A2ATask[];
  nextPageToken?: string;
  pageSize?: number;
  totalSize?: number;
}

export interface A2AMessage {
  kind?: string;
  messageId?: string;
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  extensions?: string[];
  role?: string;
  parts?: JsonObject[];
  metadata?: JsonObject;
}

export interface A2ATask {
  kind?: string;
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: JsonObject;
}

export interface A2ATaskStatus {
  state: string;
  timestamp?: string;
  message?: A2AMessage;
}

export interface A2AArtifact {
  artifactId?: string;
  name?: string;
  extensions?: string[];
  parts?: JsonObject[];
  metadata?: JsonObject;
}

export interface A2ATaskStatusUpdateEvent {
  kind?: string;
  taskId?: string;
  contextId?: string;
  status: A2ATaskStatus;
  final?: boolean;
  metadata?: JsonObject;
}

export interface A2ATaskArtifactUpdateEvent {
  kind?: string;
  taskId?: string;
  contextId?: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: JsonObject;
}

export interface A2AStreamResponse {
  task?: A2ATask;
  message?: A2AMessage;
  statusUpdate?: A2ATaskStatusUpdateEvent;
  artifactUpdate?: A2ATaskArtifactUpdateEvent;
}

export interface A2AStreamEvent {
  id?: string;
  event: string;
  data: unknown;
  result?: A2AStreamResponse;
}

export interface A2AStreamEventHandlers {
  onEvent?: (event: A2AStreamEvent) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}
