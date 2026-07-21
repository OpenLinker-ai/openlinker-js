import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  RuntimeContractDigest,
  RuntimeProtocolVersion,
  RuntimeRequiredFeatures,
} from "./runtime-types.js";

const credentialFile = "runtime-credential.json";
const credentialFormat = 1;
const maximumResponseBytes = 64 * 1024;
const renewRetryMs = 5 * 60 * 1_000;

export interface RuntimeTLSMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  serverName?: string | undefined;
}

interface CredentialDisk {
  format: typeof credentialFormat;
  nodeId: string;
  agentId?: string | undefined;
  privateKeyPEM: string;
  publicKeyThumbprint: string;
  certificateChainPEM?: string | undefined;
  trustBundlePEM?: string | undefined;
  certificateSerial?: string | undefined;
  notBefore?: string | undefined;
  notAfter?: string | undefined;
  renewAfter?: string | undefined;
  checksum: string;
}

interface CredentialResponse {
  node_id: string;
  agent_id: string;
  certificate_chain_pem: string;
  trust_bundle_pem: string;
  certificate_serial: string;
  public_key_thumbprint: string;
  not_before: string;
  not_after: string;
  renew_after: string;
}

export interface RuntimeCredentialManagerOptions {
  dataDir: string;
  credentialEndpoint: string;
  agentToken: string;
  nodeId?: string | undefined;
  agentId?: string | undefined;
  nodeVersion: string;
  capacity: number;
  logger?: { warn?(message: string): void } | undefined;
}

export class RuntimeCredentialManager {
  private disk!: CredentialDisk;
  private renewal: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private update: ((material: RuntimeTLSMaterial) => Promise<void> | void) | undefined;

  private constructor(
    private readonly directory: string,
    private readonly endpoint: string,
    private readonly options: RuntimeCredentialManagerOptions,
  ) {}

  static async open(options: RuntimeCredentialManagerOptions): Promise<RuntimeCredentialManager> {
    const directory = resolve(options.dataDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const manager = new RuntimeCredentialManager(
      directory,
      validateCredentialEndpoint(options.credentialEndpoint),
      options,
    );
    manager.disk = await loadOrCreateCredential(directory, options.nodeId);
    if (options.nodeId && manager.disk.nodeId !== options.nodeId) {
      throw new Error("configured RuntimeWorker nodeId differs from the key bound to this dataDir");
    }
    if (options.agentId && manager.disk.agentId && manager.disk.agentId !== options.agentId) {
      throw new Error("configured RuntimeWorker agentId differs from the credential bound to this dataDir");
    }
    return manager;
  }

  identity(): { nodeId: string; agentId: string } {
    if (!this.disk.agentId) throw new Error("Runtime credential has not been enrolled");
    return { nodeId: this.disk.nodeId, agentId: this.disk.agentId };
  }

  material(serverName?: string): RuntimeTLSMaterial {
    if (!this.disk.certificateChainPEM || !this.disk.trustBundlePEM) {
      throw new Error("Runtime mTLS credential is unavailable");
    }
    return {
      cert: Buffer.from(this.disk.certificateChainPEM),
      key: Buffer.from(this.disk.privateKeyPEM),
      ca: Buffer.from(this.disk.trustBundlePEM),
      ...(serverName?.trim() ? { serverName: serverName.trim() } : {}),
    };
  }

  onUpdate(callback: (material: RuntimeTLSMaterial) => Promise<void> | void): void {
    this.update = callback;
  }

  async ensure(force = false, signal?: AbortSignal): Promise<void> {
    if (!force && !credentialNeedsRenewal(this.disk)) return;
    if (!this.renewal) {
      this.renewal = this.issue(signal).finally(() => {
        this.renewal = undefined;
      });
    }
    await this.renewal;
  }

  start(signal: AbortSignal): void {
    const schedule = () => {
      if (signal.aborted) return;
      const renewAt = Date.parse(this.disk.renewAfter ?? "");
      const delay = Number.isFinite(renewAt) ? Math.max(1_000, renewAt - Date.now()) : 1_000;
      this.timer = setTimeout(async () => {
        try {
          await this.ensure(false, signal);
        } catch (error) {
          this.options.logger?.warn?.(
            `Runtime certificate renewal failed; retrying in 5 minutes: ${safeError(error)}`,
          );
          this.timer = setTimeout(schedule, renewRetryMs);
          return;
        }
        schedule();
      }, delay);
      this.timer.unref?.();
    };
    signal.addEventListener("abort", () => {
      if (this.timer) clearTimeout(this.timer);
    }, { once: true });
    schedule();
  }

  private async issue(signal?: AbortSignal): Promise<void> {
    const privateKey = createPrivateKey(this.disk.privateKeyPEM);
    const csr = createCSR(privateKey);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.agentToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-openlinker-sdk": "openlinker-js/runtime-worker",
      },
      body: JSON.stringify({
        node_id: this.disk.nodeId,
        display_name: `runtime-${this.disk.nodeId.replaceAll("-", "").slice(0, 12)}`,
        node_version: this.options.nodeVersion,
        protocol_version: RuntimeProtocolVersion,
        runtime_contract_id: "openlinker.runtime.v2",
        runtime_contract_digest: RuntimeContractDigest,
        features: [...RuntimeRequiredFeatures],
        capacity: this.options.capacity,
        csr_pem: csr,
      }),
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) {
      throw new Error(`Runtime certificate request failed with HTTP ${response.status}`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > maximumResponseBytes) {
      throw new Error("Runtime certificate response exceeds 64 KiB");
    }
    const issued = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as CredentialResponse;
    validateCredentialResponse(this.disk, issued);
    this.disk = {
      ...this.disk,
      agentId: issued.agent_id,
      certificateChainPEM: issued.certificate_chain_pem,
      trustBundlePEM: issued.trust_bundle_pem,
      certificateSerial: issued.certificate_serial.toLowerCase(),
      notBefore: issued.not_before,
      notAfter: issued.not_after,
      renewAfter: issued.renew_after,
    };
    await persistCredential(this.directory, this.disk);
    await this.update?.(this.material());
  }
}

function credentialNeedsRenewal(disk: CredentialDisk): boolean {
  if (!disk.certificateChainPEM || !disk.trustBundlePEM) return true;
  const notAfter = Date.parse(disk.notAfter ?? "");
  const renewAfter = Date.parse(disk.renewAfter ?? "");
  return !Number.isFinite(notAfter) || Date.now() + 5 * 60 * 1_000 >= notAfter ||
    !Number.isFinite(renewAfter) || Date.now() >= renewAfter;
}

async function loadOrCreateCredential(directory: string, configuredNodeId?: string): Promise<CredentialDisk> {
  const path = join(directory, credentialFile);
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size <= 0 || info.size > maximumResponseBytes) {
      throw new Error("Runtime credential file is corrupt or not private");
    }
    const disk = JSON.parse(await readFile(path, "utf8")) as CredentialDisk;
    if (disk.format !== credentialFormat || !isUUID(disk.nodeId) || !checksumValid(disk)) {
      throw new Error("Runtime credential file is corrupt");
    }
    const publicKey = createPublicKey(createPrivateKey(disk.privateKeyPEM));
    if (thumbprint(publicKey) !== disk.publicKeyThumbprint) {
      throw new Error("Runtime credential public key does not match its identity");
    }
    return disk;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const nodeId = configuredNodeId ?? randomUUID();
  if (!isUUID(nodeId)) throw new Error("RuntimeWorker nodeId must be a non-zero lowercase UUID");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const disk: CredentialDisk = {
    format: credentialFormat,
    nodeId,
    privateKeyPEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyThumbprint: thumbprint(publicKey),
    checksum: "",
  };
  await persistCredential(directory, disk);
  return disk;
}

async function persistCredential(directory: string, disk: CredentialDisk): Promise<void> {
  const value = withChecksum(disk);
  const path = join(directory, credentialFile);
  const temporary = join(directory, `.runtime-credential-${process.pid}-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directoryHandle = await open(dirname(path), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  disk.checksum = value.checksum;
}

function withChecksum(disk: CredentialDisk): CredentialDisk {
  const unsigned = { ...disk, checksum: "" };
  return { ...unsigned, checksum: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
}

function checksumValid(disk: CredentialDisk): boolean {
  return withChecksum(disk).checksum === disk.checksum;
}

function thumbprint(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

function createCSR(privateKey: KeyObject): string {
  const publicKey = createPublicKey(privateKey);
  const subject = derSequence(derSet(derSequence(derOID("2.5.4.3"), derUTF8("OpenLinker Runtime Node"))));
  const info = derSequence(
    Buffer.from([0x02, 0x01, 0x00]),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    Buffer.from([0xa0, 0x00]),
  );
  const algorithm = derSequence(derOID("1.2.840.10045.4.3.2"));
  const signature = sign("sha256", info, privateKey);
  return pemEncode("CERTIFICATE REQUEST", derSequence(info, algorithm, derBitString(signature)));
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function derSequence(...values: Buffer[]): Buffer { return der(0x30, Buffer.concat(values)); }
function derSet(...values: Buffer[]): Buffer { return der(0x31, Buffer.concat(values)); }
function derUTF8(value: string): Buffer { return der(0x0c, Buffer.from(value, "utf8")); }
function derBitString(value: Buffer): Buffer { return der(0x03, Buffer.concat([Buffer.from([0]), value])); }

function derOID(value: string): Buffer {
  const parts = value.split(".").map(Number);
  const encoded: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const bytes = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) bytes.unshift(0x80 | (rest & 0x7f));
    encoded.push(...bytes);
  }
  return der(0x06, Buffer.from(encoded));
}

function pemEncode(label: string, value: Buffer): string {
  const base64 = value.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function validateCredentialResponse(current: CredentialDisk, value: CredentialResponse): void {
  const notBefore = Date.parse(value.not_before);
  const notAfter = Date.parse(value.not_after);
  const renewAfter = Date.parse(value.renew_after);
  if (value.node_id !== current.nodeId || !isUUID(value.agent_id) ||
    value.public_key_thumbprint !== current.publicKeyThumbprint ||
    !value.certificate_chain_pem?.includes("BEGIN CERTIFICATE") ||
    !value.trust_bundle_pem?.includes("BEGIN CERTIFICATE") || !value.certificate_serial ||
    !Number.isFinite(notBefore) || !Number.isFinite(notAfter) || !Number.isFinite(renewAfter) ||
    notAfter <= notBefore || notAfter - notBefore < (23 * 60 + 50) * 60 * 1_000 ||
    notAfter - notBefore > (24 * 60 + 10) * 60 * 1_000 ||
    renewAfter <= notBefore || renewAfter >= notAfter) {
    throw new Error("Runtime certificate response is invalid");
  }
}

function validateCredentialEndpoint(raw: string): string {
  const url = new URL(raw.trim());
  if (url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) {
    throw new Error("Runtime credential endpoint must use HTTPS");
  }
  return url.toString();
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
