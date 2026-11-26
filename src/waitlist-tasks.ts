import { getPrivyConfig } from './config.js';
import type { PrivyConfig } from './config.js';
import { query } from './db.js';
import { AppError, UnauthorizedError, ValidationError } from './errors.js';
import { PostgresWaitlistRepository, verifyIdentity } from './waitlist.js';
import type { WaitlistRepository } from './waitlist.js';

/**
 * Waitlist bonus tasks (backend#198, db 0062). Same Privy identity-token auth as GET /waitlist/me.
 * Points only reorder the waitlist (more points first, then earlier joins); they grant no access by themselves.
 */
export const TASK_POINTS = { post: 5, gmail: 5, quiz: 15, tg: 10 } as const;
export type TaskId = keyof typeof TASK_POINTS;
export const TASK_IDS = Object.keys(TASK_POINTS) as TaskId[];
export const MAX_TASK_POINTS = 35;
export type QuizAnswers = Record<string, string>;
export type TaskEvidence = { postUrl: string | null; answers: QuizAnswers | null };

/** Mirrors the waitlist page's QUESTIONS (cre8-web waitlist.html); which ones apply depends on earlier answers. */
export const QUIZ: Record<string, readonly string[]> = {
  hold: ['Yes', 'Not yet'],
  where: ['On-chain wallet', 'Binance', 'Both'],
  other: ['Yes', 'No'],
  otherWhere: ['On-chain wallet', 'Exchange', 'Both'],
  type: ['Passive', 'Active trader', 'Yield-focused', 'Just exploring'],
};

export interface WaitlistTaskRepository {
  done(waitlistId: string): Promise<TaskId[]>;
  /** Idempotent: a second completion of the same task keeps the first row and adds no points. */
  complete(waitlistId: string, task: TaskId, evidence: TaskEvidence): Promise<void>;
}

export class PostgresWaitlistTaskRepository implements WaitlistTaskRepository {
  async done(waitlistId: string): Promise<TaskId[]> {
    const rows = (await query<{ task: string }>('select task from waitlist_tasks where waitlist_id=$1', [waitlistId])).rows;
    return rows.map(row => row.task).filter((task): task is TaskId => (TASK_IDS as string[]).includes(task));
  }
  async complete(waitlistId: string, task: TaskId, evidence: TaskEvidence): Promise<void> {
    await query(`insert into waitlist_tasks(waitlist_id,task,points,post_url,answers) values($1,$2,$3,$4,$5::jsonb)
      on conflict (waitlist_id,task) do nothing`,
    [waitlistId, task, TASK_POINTS[task], evidence.postUrl, evidence.answers === null ? null : JSON.stringify(evidence.answers)]);
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalidUrl = () => new ValidationError('TASK_INVALID_URL', 'post a link to your own X post: https://x.com/<your handle>/status/<id>');
const invalidAnswers = () => new ValidationError('TASK_INVALID_ANSWERS', 'answer every question with one of the listed options');
const POST_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,25})(?:[/?#]\S*)?$/i;

/** Returns the normalized https://x.com/<handle>/status/<id>, only when the handle is one of the member's own X handles. */
export function postUrl(input: unknown, handles: readonly string[]): string {
  if (!record(input) || typeof input.url !== 'string' || input.url.length > 512) throw invalidUrl();
  const match = POST_URL.exec(input.url.trim());
  const handle = match?.[1], id = match?.[2];
  if (!handle || !id || !handles.some(own => own.toLowerCase() === handle.toLowerCase())) throw invalidUrl();
  return `https://x.com/${handle}/status/${id}`;
}

/** Validates every given answer and keeps only the questions that apply to this path (stale answers are dropped). */
export function quizAnswers(input: unknown): QuizAnswers {
  if (!record(input) || !record(input.answers)) throw invalidAnswers();
  const answers = input.answers;
  for (const [key, value] of Object.entries(answers)) {
    if (!Object.hasOwn(QUIZ, key) || typeof value !== 'string' || !QUIZ[key]?.includes(value)) throw invalidAnswers();
  }
  const needed = ['hold', ...(answers.hold === 'Yes' ? ['where'] : ['other', ...(answers.other === 'Yes' ? ['otherWhere'] : [])]), 'type'];
  const kept: QuizAnswers = {};
  for (const key of needed) {
    const value = answers[key];
    if (typeof value !== 'string') throw invalidAnswers();
    kept[key] = value;
  }
  return kept;
}

function xHandle(accounts: unknown[]): string | null {
  const twitter = accounts.filter((a): a is Record<string, unknown> => record(a) && a.type === 'twitter_oauth');
  const x = twitter[0];
  return twitter.length === 1 && x && typeof x.username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(x.username) ? x.username : null;
}
const hasGoogle = (accounts: unknown[]) => accounts.some(a => record(a) && a.type === 'google_oauth' &&
  typeof a.subject === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(a.subject));

export function createWaitlistTaskService(options: {
  repository?: WaitlistTaskRepository;
  entries?: Pick<WaitlistRepository, 'find'>;
  config?: () => PrivyConfig | null;
  now?: () => number;
} = {}) {
  const repository = options.repository ?? new PostgresWaitlistTaskRepository();
  const entries = options.entries ?? new PostgresWaitlistRepository();
  const storage = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch { throw new AppError(503, 'WAITLIST_UNAVAILABLE', 'waitlist is unavailable; try again later'); }
  };
  async function member(authorization: string | undefined) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
    if (!match) throw new UnauthorizedError();
    const identity = await verifyIdentity(match[1], (options.config ?? getPrivyConfig)(), (options.now ?? Date.now)());
    const entry = await storage(() => entries.find(identity.privyUserId));
    if (!entry) throw new AppError(404, 'NOT_JOINED', 'waitlist entry not found');
    return { identity, entry };
  }
  async function view(waitlistId: string) {
    const done = new Set(await storage(() => repository.done(waitlistId)));
    const tasks = TASK_IDS.map(id => ({ id, points: TASK_POINTS[id], done: done.has(id) }));
    return { points: tasks.reduce((sum, task) => sum + (task.done ? task.points : 0), 0), max: MAX_TASK_POINTS, tasks };
  }
  return {
    async tasks(authorization: string | undefined) {
      const { entry } = await member(authorization);
      return view(entry.id);
    },
    async complete(authorization: string | undefined, id: string, body: unknown) {
      if (!(TASK_IDS as string[]).includes(id)) throw new AppError(404, 'TASK_NOT_FOUND', 'unknown waitlist task');
      const task = id as TaskId;
      const { identity, entry } = await member(authorization);
      let evidence: TaskEvidence = { postUrl: null, answers: null };
      if (task === 'post') {
        const handles = [xHandle(identity.accounts), entry.xHandle].filter((h): h is string => h !== null);
        evidence = { postUrl: postUrl(body, handles), answers: null };
      } else if (task === 'gmail') {
        if (!hasGoogle(identity.accounts)) throw new AppError(409, 'TASK_NOT_LINKED', 'connect Google to your account first');
      } else if (task === 'quiz') {
        evidence = { postUrl: null, answers: quizAnswers(body) };
      } // tg: self-reported until a Telegram bot can verify membership.
      await storage(() => repository.complete(entry.id, task, evidence));
      return view(entry.id);
    },
  };
}
