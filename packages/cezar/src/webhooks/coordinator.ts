import { listServerInstances } from '../server-install/state.ts';
import { hostedTaskLink } from './links.ts';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { WebhookService, webhooksEnabled } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookStateError } from './endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import { getRepoInfo } from '../server/git.ts';
import { parseRemote } from '../server/forge/index.ts';
interface Project { id: string; root: string; status: string }
interface Dependencies { mode(): 'local' | 'hosted'; ports(): readonly number[]; projects(): Promise<readonly Project[]>; dryRun?: boolean; singleProject?: boolean }
/** Storage owners are independent of RunManagers; discovery never starts or recovers tasks. */
export class WebhookCoordinator {
  private services = new Map<string, WebhookService>();
  private opening = new Map<string, Promise<WebhookService>>();
  private contexts = new Map<string, { context: ProjectContext; ready: boolean }>();
  private pinned = new Set<string>();
  private scheduler = new WebhookScheduler();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private readonly deps: Dependencies) {}
  count(): number { return this.services.size; }
  async get(projectId: string, root: string, pin = false): Promise<WebhookService> {
    if (!webhooksEnabled()) throw new WebhookStateError(409, 'Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar');
    if (this.stopped) throw new WebhookStateError(503, 'Webhook service is unavailable');
    let canonical: string;
    try { canonical = realpathSync(root); } catch { throw new WebhookStateError(503, 'Project root is unavailable'); }
    if (pin) this.pinned.add(canonical);
    const existing = this.services.get(canonical);
    if (existing) { existing.setProjectId(projectId); return existing; }
    const pending = this.opening.get(canonical); if (pending) return pending;
    const work = (async () => {
      const remote = parseRemote((await getRepoInfo(canonical))?.remote ?? '');
      const service = await WebhookService.open({ root: canonical, dataDir: join(canonical, '.ai/cezar'), projectId, mode: this.deps.mode(), serverPorts: this.deps.ports,
        cockpitLink: (projectId, taskId) => hostedTaskLink(listServerInstances(), this.deps.mode(), this.deps.ports()[0], process.env.CEZ_INSTANCE_ID, projectId, taskId),
        scheduler: this.scheduler, dryRun: this.deps.dryRun, ...(remote?.host === 'github.com' ? { repository: `${remote.owner}/${remote.repo}` } : {}) });
      if (!service) throw new WebhookStateError(409, 'Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar');
      if (this.stopped) { await service.dispose(); throw new WebhookStateError(503, 'Webhook service is unavailable'); }
      this.services.set(canonical, service);
      const attached = this.contexts.get(canonical);
      if (attached) service.attach(attached.context.store, attached.context.manager, attached.ready);
      if (this.timer) service.start();
      return service;
    })();
    this.opening.set(canonical, work);
    try { return await work; } finally { this.opening.delete(canonical); }
  }
  async attach(context: ProjectContext, publicId: string, ready: boolean, pin = false): Promise<void> {
    if (!webhooksEnabled()) return;
    try {
      const root = realpathSync(context.root); this.contexts.set(root, { context, ready });
      const service = await this.get(publicId, root, pin); service.attach(context.store, context.manager, ready);
    } catch { /* Optional integration never prevents task recovery or server boot. */ }
  }
  ready(root: string): void {
    try { const canonical = realpathSync(root); const entry = this.contexts.get(canonical); if (entry) entry.ready = true; this.services.get(canonical)?.markReady(); } catch { /* Gone root. */ }
  }
  start(): void {
    if (this.timer || !webhooksEnabled() || this.stopped) return;
    for (const service of this.services.values()) service.start();
    this.timer = setInterval(() => { void this.discover().catch(() => undefined); }, 15000); this.timer.unref();
    void this.discover().catch(() => undefined);
  }
  async discover(): Promise<void> {
    if (!webhooksEnabled() || this.stopped) return;
    const projects = this.deps.singleProject ? [] : await this.deps.projects();
    for (const project of projects) {
      if (project.status === 'missing' || !existsSync(join(project.root, '.ai/cezar/webhooks/endpoints.json'))) continue;
      await this.get(project.id, project.root).catch(() => undefined);
    }
    // The boot owner remains pinned even when omitted by workspace registration.
    // Explicit removal owns the pause policy; discovery cannot promise another owner's stop.
    for (const [root, entry] of this.contexts) if (!this.services.has(root)) await this.attach(entry.context, entry.context.id, entry.ready, this.pinned.has(root));
  }
  async remove(root: string): Promise<string | undefined> {
    let canonical: string;
    try { canonical = realpathSync(root); } catch { return 'Webhook receivers could not be paused because the project root is unavailable'; }
    const service = this.services.get(canonical);
    this.contexts.delete(canonical); this.pinned.delete(canonical);
    if (!service) return existsSync(join(canonical, '.ai/cezar/webhooks/endpoints.json')) ? 'Webhook receivers may be owned by another cockpit; pause them there before unregistering' : undefined;
    let warning: string | undefined;
    try { for (const receiver of service.list().receivers) if (['active', 'suspended'].includes(receiver.state)) await service.pause(receiver.id, receiver.revision); }
    catch { warning = 'Webhook pause could not be saved; this instance stopped but another owner may resume delivery'; }
    await service.dispose(); this.services.delete(canonical); return warning;
  }
  async dispose(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.services.values()].map(service => service.dispose())); this.services.clear(); this.contexts.clear();
  }
}
