// Telegram text names commands (/status), routes (/api/v1/runs) and markup (</b>), so unlike
// webhook payloads a path starts only at a private root (G2); its tail is still discarded.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A root ends at a separator, whitespace, a quote, punctuation or the end of the text.
const rootEnd = String.raw`(?=[\\/\s"'\x60.,;:!?)\]}]|$)`;
const fixedStarts = [String.raw`file:\/\/`, String.raw`[A-Za-z]:[\\/]`, String.raw`\\\\`, String.raw`~[A-Za-z0-9_.-]*[\\/]`,
  String.raw`\/(?:home|Users|root|tmp|var\/folders|private\/var\/folders)${rootEnd}`];

function privatePath(roots: readonly string[]): RegExp {
  const literal = [...new Set(roots.map(root => root.replace(/[\\/]+$/, '')).filter(root => root.length > 1))]
    .sort((a, b) => b.length - a.length).map(root => `${escape(root)}${rootEnd}`);
  const start = `(?:${[...literal, ...fixedStarts].join('|')})`;
  // Unquoted paths can contain spaces: drop the rest of the line rather than expose a suffix.
  return new RegExp(String.raw`(?<![\w/\\])(?:(["'\x60])${start}[^\r\n]*?\1|${start}[^\r\n]*)`, 'gi');
}

/** Scrub local private paths from Telegram-bound text; HTTP(S) links are kept whole. */
export function scrubTelegramText(text: string, roots: readonly string[]): string {
  const path = privatePath(roots);
  return text.split(/(https?:\/\/\S+)/gi).map((part, index) => {
    if (index % 2) {
      try { if (new URL(part).hostname) return part; } catch { /* scrub malformed URLs as text */ }
    }
    return part.replace(path, match => `…${/[.,;:!?\])}]+$/.exec(match)?.[0] ?? ''}`);
  }).join('');
}
