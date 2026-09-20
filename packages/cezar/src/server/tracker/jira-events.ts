import { z } from 'zod';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import {
  candidate,
  createEventScanner,
  type EventIssue,
} from './event-scan.ts';
import { TrackerRequestError } from './transport.ts';
const timestamp = z.string().refine((x) => Number.isFinite(Date.parse(x)));
const historySchema = z.array(
  z.object({
    id: z.string().min(1),
    created: timestamp,
    items: z.array(
      z.object({
        fieldId: z.string().optional(),
        field: z.string().optional(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
        toString: z.preprocess(
          (x) => (typeof x === 'function' ? undefined : x),
          z.string().nullable().optional(),
        ),
      }),
    ),
  }),
);
export function mapJiraHistory(
  association: TrackerAssociation,
  issue: EventIssue,
  raw: unknown,
) {
  return historySchema
    .parse(raw)
    .flatMap((h) =>
      h.items.flatMap((item, index) =>
        item.fieldId === 'status' || (!item.fieldId && item.field === 'status')
          ? [
              candidate(
                association,
                { ...issue, status: item.toString ?? item.to ?? '' },
                'issue.status_changed',
                `${h.id}:status:${index}`,
                h.created,
                {
                  ...(item.from ? { fromId: item.from } : {}),
                  ...(item.to ? { toId: item.to } : {}),
                },
              ),
            ]
          : [],
      ),
    );
}
export function createJiraEventSource(
  association: TrackerAssociation,
  request: (
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  return createEventScanner(
    association,
    async (from, _until, cursor, signal) => {
      // No upper updated bound: an issue changing again during discovery must remain discoverable.
      const raw = await request(
        '/rest/api/3/search/jql',
        {
          method: 'POST',
          body: JSON.stringify({
            jql: `project = ${association.externalId} AND updated >= ${Math.floor(Date.parse(from) / 60_000) * 60_000} ORDER BY id ASC`,
            fields: ['project', 'summary', 'created', 'status', 'labels'],
            maxResults: 100,
            ...(cursor ? { nextPageToken: cursor } : {}),
          }),
        },
        signal,
      );
      if (cursor && raw && typeof raw === 'object' && 'errorMessages' in raw)
        throw new TrackerRequestError(
          'invalid_cursor',
          'Jira rejected the continuation token; rescan the unfinished window.',
        );
      const page = z
        .object({
          isLast: z.boolean(),
          nextPageToken: z.string().optional(),
          issues: z.array(
            z.object({
              id: z.string(),
              key: z.string(),
              fields: z.object({
                project: z.object({ id: z.string() }),
                summary: z.string(),
                created: timestamp,
                status: z.object({ name: z.string() }),
                labels: z.array(z.string()),
              }),
            }),
          ),
        })
        .parse(raw);
      if (!page.isLast && !page.nextPageToken)
        throw new TrackerRequestError(
          'invalid_response',
          'Jira pagination is incomplete.',
        );
      return {
        issues: page.issues.map((i) => {
          if (i.fields.project.id !== association.externalId)
            throw new TrackerRequestError(
              'source_changed',
              'Jira issue scope changed.',
            );
          return {
            id: i.id,
            key: i.key,
            title: i.fields.summary,
            createdAt: i.fields.created,
            url: `${association.source.webUrl}/browse/${encodeURIComponent(i.key)}`,
            status: i.fields.status.name,
            labels: i.fields.labels,
          };
        }),
        ...(!page.isLast ? { cursor: page.nextPageToken } : {}),
      };
    },
    async (issue, cursor, signal) => {
      const page = z
        .object({
          isLast: z.boolean(),
          startAt: z.number().int().nonnegative(),
          maxResults: z.number().int().positive(),
          values: historySchema,
        })
        .parse(
          await request(
            `/rest/api/3/issue/${encodeURIComponent(issue.id)}/changelog?startAt=${cursor ?? '0'}&maxResults=100`,
            { method: 'GET' },
            signal,
          ),
        );
      if (!page.isLast && !page.values.length)
        throw new TrackerRequestError(
          'invalid_response',
          'Jira history pagination made no progress.',
        );
      return {
        events: mapJiraHistory(association, issue, page.values),
        ...(!page.isLast
          ? { cursor: String(page.startAt + page.values.length) }
          : {}),
      };
    },
  );
}
