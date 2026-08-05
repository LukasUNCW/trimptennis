// worker/sessions.ts
// Weekday sessions and their capacity.
//
// Grom's runs Monday to Thursday, a parent picks which days their child
// attends, and each weekday is a separate class of 18. The price does not
// change with the number of days: $250 buys the ten week term whether a child
// comes once a week or four times. Days decide capacity, not cost.
//
// The one thing here that has to be right is that eighteen means eighteen even
// when two parents click at the same moment. See claimSessions.

import type { Env } from './types';

export interface SessionRow {
  id: string;
  program: string;
  weekday: string;
  time_label: string | null;
  capacity: number;
  sort: number;
}

export interface SessionAvailability {
  id: string;
  weekday: string;
  timeLabel: string | null;
  capacity: number;
  taken: number;
  remaining: number;
  full: boolean;
}

/**
 * The bookable days for a program, with how many places are left on each.
 *
 * Remaining rather than taken, because "3 places left on Wednesday" is a
 * decision and "15 of 18" is arithmetic.
 */
export async function listSessions(env: Env, program: string): Promise<SessionAvailability[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT s.id, s.weekday, s.time_label, s.capacity, s.sort,
              (SELECT COUNT(*) FROM enrollment_sessions es WHERE es.session_id = s.id) AS taken
         FROM program_sessions s
        WHERE s.program = ?1 AND s.active = 1
        ORDER BY s.sort, s.weekday`
    )
    .bind(program)
    .all<SessionRow & { taken: number }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    weekday: r.weekday,
    timeLabel: r.time_label,
    capacity: r.capacity,
    taken: r.taken,
    // Clamped: a capacity lowered below what is already booked would otherwise
    // report a negative number of places, which reads as a bug to whoever sees
    // it rather than as the deliberate over-booking it actually is.
    remaining: Math.max(0, r.capacity - r.taken),
    full: r.taken >= r.capacity
  }));
}

export interface ClaimResult {
  ok: boolean;
  /** Weekdays that filled up, when ok is false. */
  full: string[];
  /** Human-readable days claimed, in weekday order, when ok is true. */
  labels: string[];
}

/**
 * Takes one place on each requested day for this enrolment, or none at all.
 *
 * The capacity check is the INSERT itself:
 *
 *     INSERT ... SELECT WHERE (count of takers) < (capacity)
 *
 * One statement, so SQLite evaluates the count and does the insert without
 * anything slipping between them. The obvious alternative — read the count,
 * decide, then insert — has a gap between the decision and the write, and two
 * parents taking the last place at the same moment both pass the check. That
 * would not happen often. It would happen on the evening registration opens,
 * which is exactly the evening it must not.
 *
 * All-or-nothing across days: a parent who asked for Monday and Wednesday and
 * can only have Monday should be told, not quietly given half of what they
 * chose and charged the same $250 for it. If any day is full, everything already
 * claimed for this enrolment is released.
 */
export async function claimSessions(
  env: Env,
  enrollmentId: string,
  program: string,
  sessionIds: string[]
): Promise<ClaimResult> {
  if (sessionIds.length === 0) return { ok: true, full: [], labels: [] };

  // Every id has to belong to this program and still be running. Without this a
  // request could book a Grom's child onto an Elite session by passing its id.
  const placeholders = sessionIds.map((_, i) => `?${i + 2}`).join(',');
  const { results: valid } = await env.DB
    .prepare(
      `SELECT id, weekday, sort FROM program_sessions
        WHERE program = ?1 AND active = 1 AND id IN (${placeholders})`
    )
    .bind(program, ...sessionIds)
    .all<{ id: string; weekday: string; sort: number }>();

  const known = new Map((valid ?? []).map((r) => [r.id, r]));
  const unknown = sessionIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(`Unknown session for ${program}: ${unknown.join(', ')}`);
  }

  await env.DB.batch(
    sessionIds.map((id) =>
      env.DB
        .prepare(
          `INSERT INTO enrollment_sessions (enrollment_id, session_id)
           SELECT ?1, ?2
            WHERE (SELECT COUNT(*) FROM enrollment_sessions WHERE session_id = ?2)
                < (SELECT capacity FROM program_sessions WHERE id = ?2 AND active = 1)`
        )
        .bind(enrollmentId, id)
    )
  );

  const { results: claimed } = await env.DB
    .prepare('SELECT session_id FROM enrollment_sessions WHERE enrollment_id = ?1')
    .bind(enrollmentId)
    .all<{ session_id: string }>();

  const got = new Set((claimed ?? []).map((r) => r.session_id));
  const missed = sessionIds.filter((id) => !got.has(id));

  if (missed.length) {
    await env.DB
      .prepare('DELETE FROM enrollment_sessions WHERE enrollment_id = ?1')
      .bind(enrollmentId)
      .run();
    return {
      ok: false,
      full: missed.map((id) => known.get(id)!.weekday),
      labels: []
    };
  }

  const labels = sessionIds
    .map((id) => known.get(id)!)
    .sort((a, b) => a.sort - b.sort)
    .map((r) => r.weekday);

  return { ok: true, full: [], labels };
}

/** The weekdays an enrolment holds, for the account page and the office email. */
export async function sessionLabelsFor(env: Env, enrollmentId: string): Promise<string[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT s.weekday FROM enrollment_sessions es
         JOIN program_sessions s ON s.id = es.session_id
        WHERE es.enrollment_id = ?1
        ORDER BY s.sort, s.weekday`
    )
    .bind(enrollmentId)
    .all<{ weekday: string }>();
  return (results ?? []).map((r) => r.weekday);
}
