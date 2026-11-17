import { z } from 'zod';
import { parseWhen, type ParsedWhen } from '../time.js';

export type Command =
  | { type: 'add_task'; title: string; when?: ParsedWhen; remind: boolean }
  | { type: 'snooze'; ref: string | null; when?: ParsedWhen }
  | { type: 'done'; ref: string | null }
  | { type: 'dismiss'; ref: string | null; forever: boolean }
  | { type: 'list' }
  | { type: 'suggest'; minutes?: number }
  | { type: 'approve'; code?: string }
  | { type: 'deny'; code?: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'status' }
  | { type: 'usage' }
  | { type: 'help' };

const PRONOUN = /^(that|it|this|that one|this one|the last one|the task)?$/i;

function cleanRef(s: string): string | null {
  const t = s
    .replace(/^[\s,:-]+|[\s,.!?:-]+$/g, '')
    .replace(/^(?:the|my)\s+/i, '')
    .trim();
  return PRONOUN.test(t) ? null : t;
}

/** Remove the understood time phrase and leftover filler from a task title. */
export function cleanTitle(raw: string, when?: ParsedWhen): string {
  let t = raw;
  if (when?.matched) t = t.replace(when.matched, ' ');
  t = t
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:-]*\b(?:sometime|some time|on|at|by|before|until|till|around)\s*$/i, '')
    .replace(/^[\s,.;:-]+|[\s,.;:!?-]+$/g, '')
    .replace(/^(?:sometime|some time)\s+/i, '')
    .replace(/^(?:to|a|an)\s+/i, '')
    .trim();
  return t.length ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** "2h", "90m", "7 hours", "an hour" style durations -> a phrase parseWhen understands ("in 7 hours"). */
function expandShorthand(s: string): string {
  return s.replace(
    /\b(?:in\s+|for\s+)?(?:(\d+)\s*|(an?)\s+)(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\b/i,
    (_all, n: string | undefined, _article: string | undefined, u: string) => {
      const l = u.toLowerCase();
      const unit = l.startsWith('m') ? 'minutes' : l.startsWith('h') ? 'hours' : l.startsWith('d') ? 'days' : 'weeks';
      const count = n ?? '1';
      return `in ${count} ${unit}`;
    },
  );
}

/**
 * Deterministic command parser. No model call. Returns undefined when the text is not one of
 * the known shapes, in which case the caller may ask a small model to classify it.
 */
export function parseCommand(text: string, now: Date, zone: string): Command | undefined {
  const raw = text.trim().replace(/\s+/g, ' ');
  const t = raw.replace(/[.!]+$/, '');
  const lower = t.toLowerCase().replace(/[‘’]/g, "'");
  if (!lower) return undefined;
  let m: RegExpExecArray | null;

  if (/^(pause|pause everything|stop everything|kill switch)$/.test(lower)) return { type: 'pause' };
  if (/^(resume|unpause)$/.test(lower)) return { type: 'resume' };
  if (/^(status|health)$/.test(lower)) return { type: 'status' };
  if (/^(usage|cost|costs|spend|spending)$/.test(lower)) return { type: 'usage' };
  if (/^(help|\?)$/.test(lower)) return { type: 'help' };

  if ((m = /^(?:approve|yes|y|ok|okay|confirm)(?:\s+([a-z0-9]{4,8}))?$/.exec(lower))) {
    return m[1] ? { type: 'approve', code: m[1].toUpperCase() } : { type: 'approve' };
  }
  if ((m = /^(?:deny|no|n|reject)(?:\s+([a-z0-9]{4,8}))?$/.exec(lower))) {
    return m[1] ? { type: 'deny', code: m[1].toUpperCase() } : { type: 'deny' };
  }

  const LISTS = String.raw`(?:tasks?|reminders?|to-?dos?|to-?do list|list)`;
  if (new RegExp(String.raw`^(?:(?:list|show|check)(?: me)?\s+)?(?:all\s+)?(?:my\s+)?(?:tasks|reminders|to-?dos?|to-?do list)\??$`).test(lower)) return { type: 'list' };
  if (new RegExp(String.raw`^what(?:'s| is| are)?\s+(?:on\s+)?(?:all\s+)?my\s+${LISTS}\??$`).test(lower)) return { type: 'list' };
  if (new RegExp(String.raw`^(?:what|which)\s+${LISTS}\s+(?:do|have)\s+i\s*(?:got|have|set|got set)?\b.*$`).test(lower)) return { type: 'list' };
  if (/^(?:what do i have to do|what's left|what is left|anything (?:due|left))\b.*$/.test(lower)) return { type: 'list' };

  if (/^what (?:should|can|could) i (?:do|work on)\b/.test(lower) || /\bfree (?:hour|time|\d+\s*min)/.test(lower)) {
    const mins = /(\d+)\s*(?:min|minutes)/.exec(lower);
    const hrs = /(\d+)\s*(?:hours?|hrs?)/.exec(lower);
    if (mins) return { type: 'suggest', minutes: Number(mins[1]) };
    if (hrs) return { type: 'suggest', minutes: Number(hrs[1]) * 60 };
    if (/free hour/.test(lower)) return { type: 'suggest', minutes: 60 };
    return { type: 'suggest' };
  }

  if ((m = /^snooze\b\s*(.*)$/i.exec(t))) {
    const rest = expandShorthand(m[1] ?? '');
    const when = parseWhen(rest, now, zone);
    const refText = (when ? rest.replace(when.matched, ' ') : rest).replace(/\b(?:until|till|for)\b/gi, ' ');
    return { type: 'snooze', ref: cleanRef(refText), ...(when ? { when } : {}) };
  }

  if ((m = /^(?:don'?t|do not|stop|never)\s+remind(?:ing)?\s+me\s*(?:about\s+)?(.*?)(?:\s+(?:again|anymore|any more|ever))?$/i.exec(t))) {
    return { type: 'dismiss', ref: cleanRef(m[1] ?? ''), forever: true };
  }
  if ((m = /^dismiss\b\s*(.*)$/i.exec(t))) return { type: 'dismiss', ref: cleanRef(m[1] ?? ''), forever: false };

  if ((m = /^(?:i'?m\s+|i am\s+|i\s+)?(?:done|finished|completed?)(?:\s+with)?\b\s*(.*)$/i.exec(t))) {
    return { type: 'done', ref: cleanRef(m[1] ?? '') };
  }
  if ((m = /^mark\s+(.*?)\s+(?:as\s+)?(?:done|complete|completed)$/i.exec(t))) return { type: 'done', ref: cleanRef(m[1]!) };

  const add = (body: string, remind: boolean): Command | undefined => {
    const when = parseWhen(body, now, zone);
    const title = cleanTitle(body, when);
    if (!title) return undefined;
    return { type: 'add_task', title, remind, ...(when ? { when } : {}) };
  };

  if ((m = /^remind me\s+(?:to\s+|about\s+)?(.+)$/i.exec(t))) return add(m[1]!, true);
  if ((m = /^(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my|the)\s+(?:shopping|grocery|groceries)\s+list$/i.exec(t))) {
    // No separate shopping list yet (Phase 3): it becomes a task, so it is not lost.
    const item = m[1]!.trim();
    return add(/^(?:buy|get|pick up)\b/i.test(item) ? item : `buy ${item}`, false);
  }
  if ((m = /^(?:add|put)\s+(.+?)\s+(?:to|on)\s+my\s+(?:tasks?|to-?dos?|to-?do list|list)$/i.exec(t))) return add(m[1]!, false);
  if ((m = /^(?:todo|to-do|task|add task|new task)\s*[: ]\s*(.+)$/i.exec(t))) return add(m[1]!, false);
  if ((m = /^i\s+(?:need|have|want|should|gotta|got)\s+(?:to\s+)?(.+)$/i.exec(t))) return add(m[1]!, false);

  return undefined;
}

/** What a small model may return when the deterministic parser gives up. Dates stay as TEXT. */
export const LlmIntentSchema = z.object({
  intent: z.enum(['add_task', 'snooze', 'done', 'dismiss', 'list', 'suggest', 'unknown']),
  title: z.string().max(300).optional(),
  /** The user's own time words, copied verbatim. HomePilot does the date math, not the model. */
  when_text: z.string().max(120).optional(),
  ref: z.string().max(200).optional(),
  remind: z.boolean().optional(),
});
export type LlmIntent = z.infer<typeof LlmIntentSchema>;

export const INTENT_SYSTEM_PROMPT = [
  'You classify one text message sent to a personal task assistant by its owner.',
  'Reply with ONLY a JSON object: {"intent": "add_task"|"snooze"|"done"|"dismiss"|"list"|"suggest"|"unknown",',
  '"title"?: string, "when_text"?: string, "ref"?: string, "remind"?: boolean}.',
  'title: the task in a few words. when_text: copy the user\'s time words exactly, do not compute dates.',
  'ref: words identifying an existing task. Use "unknown" if unsure. Never invent details.',
].join(' ');

/** Turn a validated model classification into a Command, re-parsing any date deterministically. */
export function commandFromLlm(intent: LlmIntent, now: Date, zone: string): Command | undefined {
  const when = intent.when_text ? parseWhen(intent.when_text, now, zone) : undefined;
  const w = when ? { when } : {};
  switch (intent.intent) {
    case 'add_task': {
      const title = intent.title ? cleanTitle(intent.title) : '';
      return title ? { type: 'add_task', title, remind: intent.remind ?? false, ...w } : undefined;
    }
    case 'snooze':
      return { type: 'snooze', ref: intent.ref ? cleanRef(intent.ref) : null, ...w };
    case 'done':
      return { type: 'done', ref: intent.ref ? cleanRef(intent.ref) : null };
    case 'dismiss':
      return { type: 'dismiss', ref: intent.ref ? cleanRef(intent.ref) : null, forever: false };
    case 'list':
      return { type: 'list' };
    case 'suggest':
      return { type: 'suggest' };
    default:
      return undefined;
  }
}

const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'this', 'to', 'for', 'of', 'with', 'about', 'on', 'in', 'at', 'and']);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/**
 * Match free text against task titles. Returns the single best match, or all tied candidates
 * so the caller can ask "which one?" instead of guessing.
 */
export function matchTasks<T extends { id: string; title: string }>(ref: string, tasks: T[]): { match?: T; ambiguous: T[] } {
  const byId = tasks.find((t) => t.id === ref.trim());
  if (byId) return { match: byId, ambiguous: [] };
  const want = tokens(ref);
  if (want.length === 0) return { ambiguous: [] };
  const scored = tasks
    .map((t) => {
      const have = new Set(tokens(t.title));
      const hits = want.filter((w) => have.has(w)).length;
      return { t, score: hits / want.length };
    })
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { ambiguous: [] };
  const top = scored.filter((s) => s.score === scored[0]!.score).map((s) => s.t);
  return top.length === 1 ? { match: top[0]!, ambiguous: [] } : { ambiguous: top };
}
