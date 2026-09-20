import { dashboardOverviewQuerySchema } from '@open-mercato/cezar-contract';
import { Hono } from 'hono';
import {
  dashboardCostsQuerySchema,
  dashboardFeedQuerySchema,
  dashboardTasksQuerySchema,
} from '@open-mercato/cezar-contract';
import { DashboardReader } from '../workspace/dashboard.ts';
import type { CostVisibility } from '../workspace/dashboard-costs.ts';
import { queryZodValidator } from './validators.ts';

/** Keep the family chained: this return value is part of AppType and the typed client. */
export function dashboardRoutes(
  reader: DashboardReader,
  visibility: () => CostVisibility = () => ({ tokens: true, cost: true }),
) {
  return new Hono()
    .get('/workspace/dashboard', async (c) => c.json(await reader.snapshot()))
    .get(
      '/workspace/dashboard/overview',
      queryZodValidator(dashboardOverviewQuerySchema),
      async (c) => {
        const result = await reader.overview(c.req.valid('query'));
        return result
          ? c.json(result)
          : c.json(
              {
                error: 'Dashboard changed; refresh the list' as const,
                code: 'snapshot-expired' as const,
              },
              409,
            );
      },
    )
    .get(
      '/workspace/dashboard/tasks',
      queryZodValidator(dashboardTasksQuerySchema),
      async (c) => {
        const q = c.req.valid('query');
        const result = await reader.tasks(q.snapshotId, q.group, q.offset, q.limit);
        return result
          ? c.json(result)
          : c.json(
              {
                error: 'Dashboard changed; refresh the list' as const,
                code: 'snapshot-expired' as const,
              },
              409,
            );
      },
    )
    .get(
      '/workspace/dashboard/costs',
      queryZodValidator(dashboardCostsQuerySchema),
      async (c) => {
        const result = await reader.costs(c.req.valid('query'), visibility);
        return result
          ? c.json(result)
          : c.json(
              {
                error: 'Dashboard changed; refresh the list' as const,
                code: 'snapshot-expired' as const,
              },
              409,
            );
      },
    )
    .get('/workspace/dashboard/telemetry', async (c) => c.json(await reader.telemetry()))
    .get('/workspace/dashboard/feed', queryZodValidator(dashboardFeedQuerySchema), async (c) =>
      c.json(await reader.feed(c.req.valid('query').filter, c.req.raw.signal)),
    );
}
