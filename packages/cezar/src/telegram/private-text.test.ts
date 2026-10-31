import { describe, expect, it } from 'vitest';
import { scrubTelegramText } from './private-text.ts';

const roots = ['/srv/work/acme-project', '/'];

describe('scrubTelegramText (G2)', () => {
  it.each([
    'Fix <b>bold</b> rendering', 'Fix the /status command', 'Fix POST /api/v1/runs 500', 'Open it (/settings/global)',
    'Install to /usr/local', 'Install to /opt', 'Run ./build first', 'Use and/or 1/2 cups', 'See https://example.com/home/alice/x.ts',
    'Wrapped in /homework', 'Ask /tmpl',
  ])('keeps %s', text => expect(scrubTelegramText(text, roots)).toBe(text));

  it.each([
    ['open /home/alice/x.ts line 3', 'open …'],
    ['copy /Users/bob/a b', 'copy …'],
    ['edit ~/p', 'edit …'],
    ['edit ~alice/notes', 'edit …'],
    ['read C:\\x', 'read …'],
    ['load file:///x', 'load …'],
    ['write /tmp/x', 'write …'],
    ['write to /tmp.', 'write to ….'],
    ['share \\\\server\\share\\x', 'share …'],
    ['cache /var/folders/ab/T/x', 'cache …'],
    ['built /srv/work/acme-project/dist/app.js ok', 'built …'],
    ['built in /srv/work/acme-project.', 'built in ….'],
    ["ENOENT, open '/home/alice/.env' now", 'ENOENT, open … now'],
  ])('scrubs %s', (text, expected) => expect(scrubTelegramText(text, roots)).toBe(expected));

  it('never treats a one-character root as a path start', () => {
    expect(scrubTelegramText('Fix /status', ['/'])).toBe('Fix /status');
  });
});
