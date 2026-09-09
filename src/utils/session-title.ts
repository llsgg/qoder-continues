import type { ConversationMessage, UnifiedSession } from '../types/index.js';

/**
 * Unified source-title resolution shared by the pickers and every forge.
 *
 * The three qoder-family sources keep their authoritative titles in
 * machine-written registries (New Qoder's chat_sessions.title, QoderWork's
 * chats.name, Codex's threads.title) while other tools only have derived
 * summaries — this module defines one priority order so session lists and
 * forged continuation titles stay consistent everywhere:
 *
 *   native registry title  >  parsed summary  >  first user prompt
 */

/** First real user prompt in a unified conversation (title fallback). */
export function firstUserPrompt(messages: ConversationMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user' && m.content.trim() && !m.content.trim().startsWith('<'));
  return first ? first.content.trim() : null;
}

/** The source session's display title: native title > summary > first user prompt. */
export function sourceSessionTitle(
  session: UnifiedSession,
  recentMessages: ConversationMessage[] = [],
): string {
  return (
    session.title?.trim() ||
    session.summary?.trim() ||
    firstUserPrompt(recentMessages) ||
    'session'
  );
}

/**
 * Title for a forged (continued) session — 「续」+ the source session's title,
 * capped at 40 source characters to stay sidebar-friendly. `overrideTitle`
 * lets forges pass a freshly-read registry title when one is available
 * (e.g. QoderWork's chats.name at forge time).
 */
export function continuedSessionTitle(
  session: UnifiedSession,
  recentMessages: ConversationMessage[] = [],
  overrideTitle?: string | null,
): string {
  const base = overrideTitle?.trim() || sourceSessionTitle(session, recentMessages);
  return `续 ${base.slice(0, 40)}`;
}
