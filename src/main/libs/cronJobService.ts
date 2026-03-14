import { BrowserWindow } from 'electron';
import type {
  Schedule,
  ScheduleAt,
  ScheduleInterval,
  ScheduleCron,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  TaskState,
  NotifyPlatform,
} from '../../renderer/types/scheduledTask';

// Minimal gateway client interface (matches OpenClawRuntimeAdapter's GatewayClientLike)
type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

// --- OpenClaw cron types (derived from gateway protocol schema) ---

interface OCScheduleAt { kind: 'at'; at: string }
interface OCScheduleEvery { kind: 'every'; everyMs: number; anchorMs?: number }
interface OCScheduleCron { kind: 'cron'; expr: string; tz?: string; staggerMs?: number }
type OCSchedule = OCScheduleAt | OCScheduleEvery | OCScheduleCron;

interface OCPayloadAgentTurn {
  kind: 'agentTurn';
  message: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  bestEffortDeliver?: boolean;
}

interface OCDelivery {
  mode: 'none' | 'announce' | 'webhook';
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

interface OCCronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: 'ok' | 'error' | 'skipped';
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: string;
  lastDeliveryError?: string;
}

interface OCCronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: OCSchedule;
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'next-heartbeat' | 'now';
  payload: OCPayloadAgentTurn | { kind: 'systemEvent'; text: string };
  delivery?: OCDelivery;
  failureAlert?: false | Record<string, unknown>;
  deleteAfterRun?: boolean;
  agentId?: string | null;
  sessionKey?: string | null;
  state: OCCronJobState;
  createdAtMs: number;
  updatedAtMs: number;
}

interface OCCronRunLogEntry {
  ts: number;
  jobId: string;
  action: 'finished';
  status?: 'ok' | 'error' | 'skipped';
  trigger?: 'scheduled' | 'manual' | string;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  jobName?: string;
}

// --- Metadata encoding in description ---

const META_MARKER = '<!--lobsterai:';
const META_MARKER_END = '-->';

interface LobsterMeta {
  workingDirectory?: string;
  systemPrompt?: string;
  expiresAt?: string | null;
}

function encodeDescription(userDesc: string, meta: LobsterMeta): string {
  const hasMetadata = meta.workingDirectory || meta.systemPrompt || meta.expiresAt;
  if (!hasMetadata) return userDesc;
  const metaJson = JSON.stringify(meta);
  return userDesc
    ? `${userDesc}\n${META_MARKER}${metaJson}${META_MARKER_END}`
    : `${META_MARKER}${metaJson}${META_MARKER_END}`;
}

function decodeDescription(desc: string | undefined): { userDesc: string; meta: LobsterMeta } {
  if (!desc) return { userDesc: '', meta: {} };
  const markerIdx = desc.indexOf(META_MARKER);
  if (markerIdx === -1) return { userDesc: desc, meta: {} };

  const userDesc = desc.slice(0, markerIdx).trimEnd();
  const jsonStart = markerIdx + META_MARKER.length;
  const jsonEnd = desc.indexOf(META_MARKER_END, jsonStart);
  if (jsonEnd === -1) return { userDesc: desc, meta: {} };

  try {
    const meta = JSON.parse(desc.slice(jsonStart, jsonEnd)) as LobsterMeta;
    return { userDesc, meta };
  } catch {
    return { userDesc: desc, meta: {} };
  }
}

// --- Type conversion: LobsterAI ↔ OpenClaw ---

function scheduleToOC(schedule: Schedule): OCSchedule {
  switch (schedule.type) {
    case 'at':
      return { kind: 'at', at: schedule.datetime };
    case 'interval':
      return { kind: 'every', everyMs: schedule.intervalMs };
    case 'cron':
      return { kind: 'cron', expr: schedule.expression };
  }
}

function scheduleFromOC(ocs: OCSchedule): Schedule {
  switch (ocs.kind) {
    case 'at':
      return { type: 'at', datetime: ocs.at };
    case 'every':
      return { type: 'interval', intervalMs: ocs.everyMs, unit: 'minutes', value: ocs.everyMs / 60000 };
    case 'cron':
      return { type: 'cron', expression: ocs.expr };
  }
}

function executionModeToSessionTarget(mode: 'auto' | 'local' | 'sandbox'): 'main' | 'isolated' {
  return mode === 'local' ? 'main' : 'isolated';
}

function sessionTargetToExecutionMode(target: 'main' | 'isolated'): 'auto' | 'local' | 'sandbox' {
  return target === 'main' ? 'local' : 'auto';
}

const PLATFORM_TO_CHANNEL: Record<NotifyPlatform, string> = {
  dingtalk: 'dingtalk-connector',
  feishu: 'feishu',
  telegram: 'telegram',
  discord: 'discord',
  qq: 'qqbot',
  wecom: 'wecom',
};

/**
 * Delivery address format builders per platform.
 * Used to construct delivery target strings like "qqbot:c2c:123".
 */
export const PLATFORM_DELIVERY_FORMAT: Record<NotifyPlatform, {
  dmFormat: (id: string) => string;
  groupFormat?: (id: string) => string;
}> = {
  qq:       { dmFormat: id => `qqbot:c2c:${id}`,          groupFormat: id => `qqbot:group:${id}` },
  telegram: { dmFormat: id => `telegram:${id}`,            groupFormat: id => `telegram:group:${id}` },
  discord:  { dmFormat: id => `discord:${id}`,             groupFormat: id => `discord:channel:${id}` },
  feishu:   { dmFormat: id => `feishu:${id}`,              groupFormat: id => `feishu:group:${id}` },
  wecom:    { dmFormat: id => `wecom:${id}`,               groupFormat: id => `wecom:group:${id}` },
  dingtalk: { dmFormat: id => `dingtalk-connector:${id}` },
};

/**
 * Extract the "to" field user/target ID from a raw IM session key using platform-specific rules.
 * Returns the extracted ID or null if extraction fails.
 */
export function extractToFromSessionKey(platform: NotifyPlatform, sessionKey: string): string | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(':');

  switch (platform) {
    case 'dingtalk': {
      // dingtalk-connector:__default__:1628274430672514[:1773314791206]
      // Extract the segment after __default__ (index 2)
      const defaultIdx = parts.indexOf('__default__');
      if (defaultIdx >= 0 && parts.length > defaultIdx + 1) {
        return parts[defaultIdx + 1] || null;
      }
      return null;
    }
    case 'feishu': {
      // feishu:direct:ou_xxx → extract ou_xxx (user ID)
      // feishu:oc_xxx → group chat, skip
      const last = parts[parts.length - 1];
      if (last && last.startsWith('ou_')) return last;
      return null;
    }
    case 'qq': {
      // qqbot:c2c:direct:255058bbf46f5890ed9facfe74abe75e → 255058BBF46F5890ED9FACFE74ABE75E
      // QQ openid letters must be uppercased
      const last = parts[parts.length - 1];
      return last ? last.toUpperCase() : null;
    }
    case 'wecom':
    case 'telegram':
    case 'discord': {
      // Take the last segment:
      // wecom:direct:liugang → liugang
      // telegram:direct:8322789714 or telegram:8322789714 → 8322789714
      // discord:channel:1470329860667867203 → 1470329860667867203
      const last = parts[parts.length - 1];
      return last || null;
    }
    default:
      return null;
  }
}

/**
 * Detect whether a session key or conversationId represents a DM or group conversation.
 */
export function detectSessionType(sessionKeyOrConvId: string): 'dm' | 'group' {
  return sessionKeyOrConvId.includes(':group:') ? 'group' : 'dm';
}

const CHANNEL_TO_PLATFORM: Record<string, NotifyPlatform> = Object.fromEntries(
  Object.entries(PLATFORM_TO_CHANNEL).map(([k, v]) => [v, k as NotifyPlatform])
) as Record<string, NotifyPlatform>;

function notifyPlatformToDelivery(platform: NotifyPlatform | null, to?: string): OCDelivery | undefined {
  if (!platform) return undefined;
  const channel = PLATFORM_TO_CHANNEL[platform];
  if (!channel) return undefined;
  return { mode: 'announce', channel, bestEffort: true, ...(to ? { to } : {}) };
}

function deliveryToNotifyPlatform(delivery: OCDelivery | undefined): NotifyPlatform | null {
  if (!delivery || delivery.mode === 'none' || !delivery.channel) return null;
  return CHANNEL_TO_PLATFORM[delivery.channel] || null;
}

function ocStateToTaskState(state: OCCronJobState): TaskState {
  const mapStatus = (s?: 'ok' | 'error' | 'skipped'): TaskState['lastStatus'] => {
    if (s === 'ok') return 'success';
    if (s === 'error') return 'error';
    if (state.runningAtMs) return 'running';
    return null;
  };

  return {
    nextRunAtMs: state.nextRunAtMs ?? null,
    lastRunAtMs: state.lastRunAtMs ?? null,
    lastStatus: mapStatus(state.lastRunStatus ?? state.lastStatus),
    lastError: state.lastError ?? null,
    lastDurationMs: state.lastDurationMs ?? null,
    runningAtMs: state.runningAtMs ?? null,
    consecutiveErrors: state.consecutiveErrors ?? 0,
  };
}

function ocJobToScheduledTask(job: OCCronJob): ScheduledTask {
  const { userDesc, meta } = decodeDescription(job.description);
  const prompt = job.payload.kind === 'agentTurn'
    ? (typeof job.payload.message === 'string' ? job.payload.message : '')
    : (job.payload as { text?: string }).text || '';
  const notifyPlatform = deliveryToNotifyPlatform(job.delivery);

  return {
    id: job.id,
    name: job.name,
    description: userDesc,
    enabled: job.enabled,
    schedule: scheduleFromOC(job.schedule),
    prompt,
    workingDirectory: meta.workingDirectory || '',
    systemPrompt: meta.systemPrompt || '',
    executionMode: sessionTargetToExecutionMode(job.sessionTarget),
    expiresAt: meta.expiresAt ?? null,
    notifyPlatforms: notifyPlatform ? [notifyPlatform] : [],
    deliveryTo: job.delivery?.to || '',
    state: ocStateToTaskState(job.state),
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
  };
}

function ocRunToScheduledTaskRun(entry: OCCronRunLogEntry): ScheduledTaskRun {
  const mapStatus = (s?: 'ok' | 'error' | 'skipped'): 'success' | 'error' | 'running' => {
    if (s === 'ok') return 'success';
    return 'error';
  };

  return {
    id: `${entry.jobId}-${entry.ts}`,
    taskId: entry.jobId,
    sessionId: entry.sessionId ?? null,
    sessionKey: entry.sessionKey ?? null,
    status: mapStatus(entry.status),
    startedAt: new Date(entry.runAtMs ?? entry.ts).toISOString(),
    finishedAt: new Date(entry.ts).toISOString(),
    durationMs: entry.durationMs ?? null,
    error: entry.error ?? null,
  };
}

// --- CronJobService ---

interface CronJobServiceDeps {
  getGatewayClient: () => GatewayClientLike | null;
  ensureGatewayReady: () => Promise<void>;
  getDeliveryTarget?: (platform: NotifyPlatform) => string | undefined;
}

export class CronJobService {
  private readonly getGatewayClient: () => GatewayClientLike | null;
  private readonly ensureGatewayReady: () => Promise<void>;
  private readonly getDeliveryTarget: (platform: NotifyPlatform) => string | undefined;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownStates: Map<string, string> = new Map(); // jobId → JSON state hash
  private lastKnownRunAtMs: Map<string, number> = new Map(); // jobId → lastRunAtMs
  private polling = false;
  private firstPollDone = false;

  private static readonly POLL_INTERVAL_MS = 15_000;

  constructor(deps: CronJobServiceDeps) {
    this.getGatewayClient = deps.getGatewayClient;
    this.ensureGatewayReady = deps.ensureGatewayReady;
    this.getDeliveryTarget = deps.getDeliveryTarget ?? (() => undefined);
  }

  private async client(): Promise<GatewayClientLike> {
    let c = this.getGatewayClient();
    if (!c) {
      await this.ensureGatewayReady();
      c = this.getGatewayClient();
    }
    if (!c) throw new Error('OpenClaw gateway client is unavailable for cron operations.');
    return c;
  }

  // --- CRUD ---

  async addJob(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const c = await this.client();
    const notifyPlatform = input.notifyPlatforms?.[0] ?? null;
    // Prefer user-specified deliveryTo, fallback to auto-detection
    const deliveryTo = input.deliveryTo || (notifyPlatform ? this.getDeliveryTarget(notifyPlatform) : undefined);
    const delivery = notifyPlatformToDelivery(notifyPlatform, deliveryTo);
    const description = encodeDescription(input.description, {
      workingDirectory: input.workingDirectory || undefined,
      systemPrompt: input.systemPrompt || undefined,
      expiresAt: input.expiresAt || undefined,
    });

    // When delivery is configured, force isolated session + agentTurn payload
    // because main sessions with systemEvent don't support channel-based delivery
    const baseSessionTarget = executionModeToSessionTarget(input.executionMode);
    const sessionTarget = (baseSessionTarget === 'main' && delivery) ? 'isolated' : baseSessionTarget;
    const payload = sessionTarget === 'main'
      ? { kind: 'systemEvent' as const, text: input.prompt }
      : {
          kind: 'agentTurn' as const,
          message: input.prompt,
          ...(delivery ? { deliver: true, channel: delivery.channel, bestEffortDeliver: true } : {}),
        };

    const params: Record<string, unknown> = {
      name: input.name,
      description,
      enabled: input.enabled,
      schedule: scheduleToOC(input.schedule),
      sessionTarget,
      wakeMode: 'now' as const,
      payload,
      delivery: delivery ?? { mode: 'none' },
      ...(input.schedule.type === 'at' ? { deleteAfterRun: false } : {}),
    };

    const job = await c.request<OCCronJob>('cron.add', params);
    return ocJobToScheduledTask(job);
  }

  async updateJob(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
    const c = await this.client();

    // First fetch current job to preserve metadata
    const currentJob = await this.getJobRaw(id);
    const { meta: currentMeta } = decodeDescription(currentJob?.description);

    const patch: Record<string, unknown> = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.schedule !== undefined) patch.schedule = scheduleToOC(input.schedule);
    if (input.executionMode !== undefined) {
      // Will be overridden below if delivery forces isolated
      patch.sessionTarget = executionModeToSessionTarget(input.executionMode);
    }

    // Compute effective delivery first (needed for payload deliver flag)
    let effectiveDelivery: OCDelivery | undefined;
    if (input.notifyPlatforms !== undefined) {
      const platform = input.notifyPlatforms[0] ?? null;
      // Prefer user-specified deliveryTo, fallback to auto-detection
      const deliveryTo = input.deliveryTo || (platform ? this.getDeliveryTarget(platform) : undefined);
      effectiveDelivery = notifyPlatformToDelivery(platform, deliveryTo);
      patch.delivery = effectiveDelivery || { mode: 'none' };
    } else if (input.deliveryTo !== undefined) {
      // deliveryTo changed but platform didn't — update delivery.to
      const currentPlatform = deliveryToNotifyPlatform(currentJob?.delivery);
      const deliveryTo = input.deliveryTo || (currentPlatform ? this.getDeliveryTarget(currentPlatform) : undefined);
      effectiveDelivery = notifyPlatformToDelivery(currentPlatform, deliveryTo);
      patch.delivery = effectiveDelivery || { mode: 'none' };
    } else {
      effectiveDelivery = currentJob?.delivery;
    }

    // When delivery is configured, force isolated session + agentTurn payload
    // because main sessions with systemEvent don't support channel-based delivery
    const hasDelivery = effectiveDelivery && effectiveDelivery.mode !== 'none';

    // Determine effective sessionTarget
    const baseSessionTarget = input.executionMode !== undefined
      ? executionModeToSessionTarget(input.executionMode)
      : (currentJob?.sessionTarget ?? 'isolated');
    const effectiveSessionTarget = (baseSessionTarget === 'main' && hasDelivery) ? 'isolated' : baseSessionTarget;

    // Override sessionTarget if delivery forces isolated
    if (baseSessionTarget === 'main' && hasDelivery) {
      patch.sessionTarget = 'isolated';
    }

    // Rebuild payload when prompt, executionMode, or delivery changes
    if (input.prompt !== undefined || input.executionMode !== undefined || input.notifyPlatforms !== undefined || input.deliveryTo !== undefined) {
      const prompt = input.prompt ?? (
        currentJob?.payload.kind === 'agentTurn'
          ? (currentJob.payload as { message?: string }).message ?? ''
          : (currentJob?.payload as { text?: string }).text ?? ''
      );
      patch.payload = effectiveSessionTarget === 'main'
        ? { kind: 'systemEvent', text: prompt }
        : {
            kind: 'agentTurn',
            message: prompt,
            ...(hasDelivery
              ? { deliver: true, channel: effectiveDelivery!.channel, bestEffortDeliver: true }
              : {}),
          };
    }

    // Merge metadata
    const newMeta: LobsterMeta = { ...currentMeta };
    if (input.workingDirectory !== undefined) newMeta.workingDirectory = input.workingDirectory || undefined;
    if (input.systemPrompt !== undefined) newMeta.systemPrompt = input.systemPrompt || undefined;
    if (input.expiresAt !== undefined) newMeta.expiresAt = input.expiresAt || undefined;

    const userDesc = input.description ?? decodeDescription(currentJob?.description).userDesc;
    patch.description = encodeDescription(userDesc, newMeta);

    const job = await c.request<OCCronJob>('cron.update', { id, patch });
    return ocJobToScheduledTask(job);
  }

  async removeJob(id: string): Promise<void> {
    const c = await this.client();
    await c.request('cron.remove', { id });
    this.lastKnownStates.delete(id);
  }

  async listJobs(): Promise<ScheduledTask[]> {
    const c = await this.client();
    const result = await c.request<{ jobs: OCCronJob[] }>('cron.list', {
      includeDisabled: true,
      limit: 200,
    });
    const jobs = result.jobs || [];
    return jobs.map(ocJobToScheduledTask);
  }

  async getJob(id: string): Promise<ScheduledTask | null> {
    const raw = await this.getJobRaw(id);
    return raw ? ocJobToScheduledTask(raw) : null;
  }

  private async getJobRaw(id: string): Promise<OCCronJob | null> {
    const c = await this.client();
    try {
      const result = await c.request<{ jobs: OCCronJob[] }>('cron.list', {
        includeDisabled: true,
        query: id,
        limit: 1,
      });
      const jobs = result.jobs || [];
      return jobs.find(j => j.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async toggleJob(id: string, enabled: boolean): Promise<{ warning?: string }> {
    const c = await this.client();

    // Check for warnings before toggling
    if (enabled) {
      const job = await this.getJobRaw(id);
      if (job) {
        const { meta } = decodeDescription(job.description);
        if (meta.expiresAt) {
          const todayStr = new Date().toISOString().slice(0, 10);
          if (meta.expiresAt <= todayStr) {
            return { warning: 'TASK_EXPIRED' };
          }
        }
        if (job.schedule.kind === 'at') {
          const atDate = new Date(job.schedule.at);
          if (atDate.getTime() < Date.now()) {
            return { warning: 'TASK_AT_PAST' };
          }
        }
      }
    }

    await c.request('cron.update', { id, patch: { enabled } });
    return {};
  }

  async runJob(id: string): Promise<void> {
    const c = await this.client();
    await c.request('cron.run', { id });
  }

  // --- Run history ---

  async listRuns(jobId: string, limit = 20, offset = 0): Promise<ScheduledTaskRun[]> {
    const c = await this.client();
    const result = await c.request<{ entries: OCCronRunLogEntry[]; total: number }>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit,
      offset,
      sortDir: 'desc',
    });
    return (result.entries || []).map(ocRunToScheduledTaskRun);
  }

  async countRuns(jobId: string): Promise<number> {
    const c = await this.client();
    const result = await c.request<{ entries: OCCronRunLogEntry[]; total: number }>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit: 0,
    });
    return result.total ?? 0;
  }

  async listAllRuns(limit = 20, offset = 0): Promise<ScheduledTaskRunWithName[]> {
    const c = await this.client();
    const result = await c.request<{ entries: OCCronRunLogEntry[]; total: number }>('cron.runs', {
      scope: 'all',
      limit,
      offset,
      sortDir: 'desc',
    });
    return (result.entries || []).map(entry => ({
      ...ocRunToScheduledTaskRun(entry),
      taskName: entry.jobName || entry.jobId,
    }));
  }

  // --- Polling ---

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    console.log('[CronJobService] Started polling');
    this.pollOnce(); // immediate first poll
    this.pollingTimer = setInterval(() => this.pollOnce(), CronJobService.POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.lastKnownStates.clear();
    this.lastKnownRunAtMs.clear();
    this.firstPollDone = false;
    console.log('[CronJobService] Stopped polling');
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling) return;

    try {
      const c = this.getGatewayClient();
      if (!c) return; // not ready yet, skip this tick

      const result = await c.request<{ jobs: OCCronJob[] }>('cron.list', {
        includeDisabled: true,
        limit: 200,
      });
      const jobs = result.jobs || [];

      for (const job of jobs) {
        const stateHash = JSON.stringify(job.state);
        const prevHash = this.lastKnownStates.get(job.id);

        if (prevHash !== stateHash) {
          this.lastKnownStates.set(job.id, stateHash);
          if (prevHash !== undefined) {
            // State changed, emit update
            const task = ocJobToScheduledTask(job);
            this.emitStatusUpdate(task.id, task.state);
          }
        }

        // Detect new run completions by tracking lastRunAtMs
        const lastRunAtMs = job.state.lastRunAtMs ?? 0;
        const prevRunAtMs = this.lastKnownRunAtMs.get(job.id) ?? 0;
        if (lastRunAtMs > prevRunAtMs && prevRunAtMs > 0) {
          try {
            const runs = await this.listRuns(job.id, 1, 0);
            if (runs.length > 0) {
              const task = ocJobToScheduledTask(job);
              this.emitRunUpdate({ ...runs[0], taskName: task.name });
            }
          } catch { /* ignore run fetch errors during polling */ }
        }
        this.lastKnownRunAtMs.set(job.id, lastRunAtMs);

        // Check expiresAt and auto-disable expired tasks
        const { meta } = decodeDescription(job.description);
        if (meta.expiresAt && job.enabled) {
          const todayStr = new Date().toISOString().slice(0, 10);
          if (meta.expiresAt <= todayStr) {
            try {
              await c.request('cron.update', { id: job.id, patch: { enabled: false } });
              console.log(`[CronJobService] Auto-disabled expired task ${job.id}`);
            } catch (err) {
              console.warn(`[CronJobService] Failed to auto-disable expired task ${job.id}:`, err);
            }
          }
        }
      }

      // Detect removed jobs
      const currentIds = new Set(jobs.map(j => j.id));
      for (const knownId of this.lastKnownStates.keys()) {
        if (!currentIds.has(knownId)) {
          this.lastKnownStates.delete(knownId);
          this.lastKnownRunAtMs.delete(knownId);
        }
      }

      // First poll completed — notify renderer to refresh full task list
      if (!this.firstPollDone) {
        this.firstPollDone = true;
        this.emitFullRefresh();
      }
    } catch (err) {
      console.warn('[CronJobService] Polling error:', err);
    }
  }

  private emitStatusUpdate(taskId: string, state: TaskState): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('scheduledTask:statusUpdate', { taskId, state });
      }
    });
  }

  private emitRunUpdate(run: ScheduledTaskRunWithName): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('scheduledTask:runUpdate', { run });
      }
    });
  }

  private emitFullRefresh(): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('scheduledTask:refresh');
      }
    });
  }

  // --- Migration ---

  async migrateFromLegacy(tasks: Array<{
    name: string;
    description: string;
    schedule: Schedule;
    prompt: string;
    workingDirectory: string;
    systemPrompt: string;
    executionMode: 'auto' | 'local' | 'sandbox';
    expiresAt: string | null;
    notifyPlatforms: NotifyPlatform[];
    enabled: boolean;
  }>): Promise<{ migrated: number; failed: number }> {
    let migrated = 0;
    let failed = 0;

    for (const task of tasks) {
      try {
        // Log warning if multiple notify platforms will be reduced to one
        if (task.notifyPlatforms.length > 1) {
          const kept = task.notifyPlatforms[0];
          const dropped = task.notifyPlatforms.slice(1);
          console.warn(
            `[CronJobService] Migration: task "${task.name}" had ${task.notifyPlatforms.length} notification platforms. ` +
            `Keeping "${kept}", dropping: ${dropped.join(', ')}. ` +
            `OpenClaw delivery only supports a single channel. Please reconfigure if needed.`
          );
        }

        await this.addJob({
          name: task.name,
          description: task.description,
          schedule: task.schedule,
          prompt: task.prompt,
          workingDirectory: task.workingDirectory,
          systemPrompt: task.systemPrompt,
          executionMode: task.executionMode,
          expiresAt: task.expiresAt,
          notifyPlatforms: task.notifyPlatforms,
          deliveryTo: '',
          enabled: task.enabled,
        });
        migrated++;
        console.log(`[CronJobService] Migrated task: ${task.name}`);
      } catch (err) {
        failed++;
        console.error(`[CronJobService] Failed to migrate task ${task.name}:`, err);
      }
    }

    return { migrated, failed };
  }
}
