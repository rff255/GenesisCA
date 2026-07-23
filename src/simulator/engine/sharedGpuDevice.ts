// ---------------------------------------------------------------------------
// Shared GPUDevice singleton (Phase E1).
//
// Before E1 the grid runtime (webgpuRuntime.ts) and each agent runtime
// (agentWebgpuRuntime.ts) requested their OWN adapter + device. Consequences:
//   - a WebGPU grid + WebGPU agents model held TWO devices (double driver
//     pressure; the two can't share a buffer, so a field-coupled model must
//     round-trip the field CPU-side every generation);
//   - a re-attach / rebuild that built a fresh render-only device without
//     destroying the prior one leaked a whole GPUDevice (the C-report note).
//
// E1 makes ONE worker-owned device serve every runtime. Both grid + agent
// runtimes now take the device as a constructor input from this refcounted
// singleton, so:
//   - the adapter is requested ONCE per worker (the device-leak metric);
//   - rebuilds (recompile / reset / target flip) reuse the ONE device — a
//     runtime teardown RELEASES its reference; the device is destroyed only
//     when the LAST reference is released (both runtimes gone);
//   - the field bridge can bind buffers from both runtimes on one device.
//
// The union of the required limits both runtimes ask for is requested up front
// (the grid's superset), so neither runtime is limit-starved on the shared
// device. onuncapturederror + device.lost are registered ONCE here (the
// per-runtime hooks are removed) — the lost handler filters reason 'destroyed'
// (our own teardown, not a real loss).
// ---------------------------------------------------------------------------

export interface SharedGpuDevice {
  device: GPUDevice;
  adapter: GPUAdapter;
}

/** The device+adapter, shared by every WebGPU runtime in this worker. */
let shared: SharedGpuDevice | null = null;
/** Reference count — each successful acquire() increments, each release()
 *  decrements; the device is destroyed at zero. */
let refCount = 0;
/** In-flight acquisition (both runtimes may request the device before the first
 *  device request resolves — they share the ONE request rather than racing two). */
let acquiring: Promise<SharedGpuDevice | null> | null = null;
/** DEV/verification only — how many times the ADAPTER has actually been
 *  requested (the device-leak metric: this stays 1 across all in-session
 *  rebuilds/target-flips because the singleton is reused). */
let adapterRequestCount = 0;

/** True when WebGPU is present in this context. */
function gpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

/** The union of the limit keys the grid + agent runtimes request (the grid's set
 *  is the superset — the agent set is a subset of it). Requested at device
 *  creation so a large grid / large agent count isn't limit-starved. */
const UNION_LIMIT_KEYS = [
  'maxStorageBufferBindingSize', 'maxBufferSize', 'maxUniformBufferBindingSize',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension',
  'maxStorageBuffersPerShaderStage',
] as const;

async function requestSharedDevice(): Promise<SharedGpuDevice | null> {
  if (!gpuAvailable()) return null;
  try {
    const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
    adapterRequestCount++;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const required: Record<string, number> = {};
    const limits = adapter.limits as unknown as Record<string, number>;
    for (const k of UNION_LIMIT_KEYS) { const v = limits[k]; if (typeof v === 'number') required[k] = v; }
    // Some adapters report supported limits the device can't actually back; the
    // first requestDevice then fails opaquely. Retry once with default limits so
    // we degrade gracefully (models within the default caps still work; a larger
    // grid surfaces the specific "buffer exceeds device limit" error downstream).
    let device: GPUDevice;
    try { device = await adapter.requestDevice({ requiredLimits: required }); }
    catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[webgpu] shared requestDevice with adapter max limits failed, retrying with defaults:', err);
      device = await adapter.requestDevice();
    }
    if (!device) return null;
    // Consolidated diagnostics for BOTH runtimes (the per-runtime hooks are
    // removed). Without these a failing dispatch is SILENT (dropped work + a
    // readback of unchanged state = "frozen / wrong dynamics, zero errors").
    device.addEventListener('uncapturederror', (ev: Event) => {
      // eslint-disable-next-line no-console
      console.error('[webgpu] uncaptured device error:', (ev as GPUUncapturedErrorEvent).error.message);
    });
    void device.lost.then((info) => {
      // reason 'destroyed' = our own release-at-refcount-zero teardown, not a
      // real loss. Only a genuine loss (driver reset / TDR / adapter removed)
      // surfaces.
      if (info.reason === 'destroyed') return;
      // eslint-disable-next-line no-console
      console.error(`[webgpu] shared device lost (${info.reason}): ${info.message}`);
    });
    return { device, adapter };
  } catch {
    return null;
  }
}

/** Acquire the worker's shared GPUDevice (creating it on first call). Returns
 *  null when WebGPU is unavailable / device acquisition fails — the caller keeps
 *  its non-GPU fallback path. EVERY successful (non-null) acquire MUST be paired
 *  with exactly one releaseSharedGpuDevice(device). */
export async function acquireSharedGpuDevice(): Promise<SharedGpuDevice | null> {
  if (shared) { refCount++; return shared; }
  if (acquiring) {
    const s = await acquiring;
    // The in-flight request may have resolved into `shared` already (another
    // acquirer stored it); prefer the stored singleton.
    if (shared) { refCount++; return shared; }
    if (s) { shared = s; refCount++; return shared; }
    return null;
  }
  acquiring = requestSharedDevice();
  const s = await acquiring;
  acquiring = null;
  if (!s) return null;
  // A concurrent acquire may have resolved first and stored the singleton — if
  // so, drop our redundant device and use the stored one (one device per worker).
  if (shared) {
    try { (s.device as GPUDevice & { destroy?: () => void }).destroy?.(); } catch { /* non-fatal */ }
    refCount++;
    return shared;
  }
  shared = s;
  refCount++;
  return shared;
}

/** Release a reference to the shared device. When the last reference is
 *  released the device is destroyed. Safe to call with a stale/foreign device
 *  reference (only the current singleton's refcount is touched). */
export function releaseSharedGpuDevice(device: GPUDevice | null | undefined): void {
  if (!shared || !device) return;
  // Only balance releases against the CURRENT singleton (a stale device from a
  // prior singleton — impossible in practice since we never swap — is ignored).
  if (device !== shared.device) return;
  refCount--;
  if (refCount <= 0) {
    const dev = shared.device as GPUDevice & { destroy?: () => void };
    shared = null;
    refCount = 0;
    try { dev.destroy?.(); } catch { /* non-fatal */ }
  }
}

/** DEV/verification only — how many live references the singleton holds (0 when
 *  no runtime is using the device). Not used in production paths. */
export function sharedGpuRefCount(): number {
  return shared ? refCount : 0;
}

/** DEV/verification only — the total number of GPU ADAPTER requests this worker
 *  has made. Stays 1 across all rebuilds/target-flips once the device is up (the
 *  device-leak metric). Not used in production paths. */
export function sharedGpuAdapterRequestCount(): number {
  return adapterRequestCount;
}
