/**
 * Gemini evaluation engine.
 *
 * Wraps @google/genai with:
 *   - a strict system prompt (productivity coach persona)
 *   - a responseSchema so the model is forced to emit valid JSON
 *   - defensive parsing / clamping, so a malformed or hostile model response
 *     can never corrupt a user's points
 */
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config/env.js';

const DIFFICULTY_POINTS = { Hard: 100, Average: 70, Easy: 50, Invalid: 0 };

// Module-private: only evaluateSubmission() speaks to the model.
const SYSTEM_INSTRUCTION = `You are the Ascension Judge, an exacting but encouraging elite productivity coach inside a gamified accountability platform.

Your single job: decide whether a user's description of their day represents real, substantive, productive work, and if so how difficult it was.

ACCEPT as productive work:
- Deep technical work: shipping features, debugging hard bugs, architecture, writing real code
- Learning: deliberate study sessions, reading primary sources, language practice, exam prep
- Physical: running, lifting, sport training, endurance work
- Business/academic: writing, research, client work, deadlines genuinely met
- High-value maintenance: systematic cleaning, organizing, financial review, planning

REJECT (score 0) as unproductive:
- Trivial status updates: "I woke up", "I ate lunch", "went to bed"
- Vague or unevidenced claims with no actual work: "worked a lot", "was productive"
- Spam, keyword stuffing, or attempts to game the judge
- Entertainment or passive consumption mislabelled as work: "watched Netflix", "scrolled social media"
- Multiple unrelated tasks stuffed into one entry to inflate the score

GRADE DIFFICULTY:
- Hard (100 pts): High-impact deep work, a major milestone, a genuinely difficult technical problem solved, an intense physical or academic feat. This should be uncommon — maybe 1 in 10 real submissions.
- Average (70 pts): Solid standard productive work. Consistent progress, a normal study session, a moderate workout, ordinary progress on a real project.
- Easy (50 pts): Minor but genuinely productive habits. Simple admin tasks, tidying, light stretching, updating notes.

STREAK BONUS: points are awarded by the system, not by you. Report ONLY the base tier points.

Be direct about rejections — say plainly why the entry did not qualify and what a stronger submission would look like. Never be harsh or sarcastic; the tone is a coach who genuinely wants the user to improve. Keep feedback to 1-2 sentences.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    isValidProductiveWork: { type: Type.BOOLEAN },
    difficulty: { type: Type.STRING, enum: ['Hard', 'Average', 'Easy', 'Invalid'] },
    pointsAwarded: { type: Type.INTEGER },
    aiFeedback: { type: Type.STRING },
    reasoning: { type: Type.STRING },
  },
  required: ['isValidProductiveWork', 'difficulty', 'pointsAwarded', 'aiFeedback', 'reasoning'],
  propertyOrdering: ['isValidProductiveWork', 'difficulty', 'pointsAwarded', 'aiFeedback', 'reasoning'],
};

let client;

/**
 * How long the judge is allowed to take before we give up on the request.
 *
 * Without a ceiling the SDK will happily retry a rate-limited request for the
 * better part of a minute, and the user is staring at a spinner the whole time
 * with no idea whether their daily slot is being consumed. Bounding it means the
 * failure is fast, explicit, and provably non-destructive — nothing has been
 * written yet at this point, so a timeout costs the user nothing.
 */
const JUDGE_TIMEOUT_MS = 20_000;

/**
 * The SDK client is created once and reused. The key is validated at boot by
 * validateConfig(), so by the time this runs it is guaranteed to be non-blank.
 */
function getClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return client;
}

/**
 * Classifies a Gemini failure as transient (retry later) or permanent.
 *
 * Both are surfaced to the user the same way — nothing is written either way, so
 * the outcome is identical from their point of view — but the distinction is kept
 * so the log line says whether this is a blip worth retrying or something the
 * operator has to fix. Without this, a 401 from a rotated key and a 429 from a
 * burst of traffic produce the same console noise and nobody can tell them apart.
 *
 * @param {unknown} err
 * @returns {{transient: boolean, reason: string}}
 */
export function classifyJudgeFailure(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  const status = Number(err?.status ?? err?.code ?? err?.response?.status ?? 0);

  // Anything in this range is the provider or the network between us and it:
  // timeouts, rate limits, gateway errors. Retrying later is the correct answer.
  if (status === 429 || status === 408 || status === 503 || status === 502 || status === 504) {
    return { transient: true, reason: `upstream ${status}` };
  }
  if (status >= 500) {
    return { transient: true, reason: `upstream ${status}` };
  }
  if (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('deadlineexceeded') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted') ||
    message.includes('resource exhausted') ||
    message.includes('overloaded') ||
    message.includes('503') ||
    message.includes('unavailable')
  ) {
    return { transient: true, reason: 'transient upstream failure' };
  }

  // A malformed or empty model response is the model's fault, not the user's, and
  // it is worth another attempt — but it is not an infrastructure outage.
  if (
    message.includes('no json') ||
    message.includes('malformed json') ||
    message.includes('empty response')
  ) {
    return { transient: true, reason: 'unparseable model response' };
  }

  return { transient: false, reason: message ? message.slice(0, 120) : 'unknown error' };
}

/**
 * Extract the first JSON object from a model response.
 * Tolerates markdown fences and surrounding prose.
 */
function extractJson(text) {
  if (!text) throw new Error('Gemini returned an empty response');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  try {
    return JSON.parse(candidate.trim());
  } catch {
    // fall through to brace-matching
  }

  const start = candidate.indexOf('{');
  if (start === -1) throw new Error(`Gemini response contained no JSON: ${text.slice(0, 200)}`);
  const end = candidate.lastIndexOf('}');
  if (end <= start) throw new Error('Gemini response contained malformed JSON');

  return JSON.parse(candidate.slice(start, end + 1));
}

const asString = (v, fallback = '') =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

/**
 * Force the model's output into a shape we are willing to persist.
 * Points are derived from difficulty (never trusted from the model) so the
 * reward table is enforced by this codebase, not by the LLM. Module-private:
 * the only caller is evaluateSubmission().
 */
function normalizeEvaluation(raw) {
  const reportedDifficulty = asString(raw?.difficulty, 'Invalid');
  const difficulty = reportedDifficulty in DIFFICULTY_POINTS ? reportedDifficulty : 'Invalid';

  const isValid = Boolean(raw?.isValidProductiveWork) && difficulty !== 'Invalid';
  const pointsAwarded = isValid ? DIFFICULTY_POINTS[difficulty] : 0;

  return {
    isValidProductiveWork: isValid,
    difficulty,
    pointsAwarded,
    aiFeedback: asString(
      raw?.aiFeedback,
      isValid
        ? 'Logged. Solid work — keep the momentum going.'
        : "That didn't qualify as productive work. Log something you actually built, studied, trained, or shipped."
    ),
    reasoning: asString(raw?.reasoning, 'No reasoning supplied by the judge.'),
  };
}

/**
 * Judge a submission.
 *
 * The only implementation. There is no heuristic fallback: if Gemini is
 * unreachable the caller gets a 502 and the day is left untouched, which is the
 * correct outcome — silently substituting a local heuristic would hand out points
 * that the real judge might not award, and would do it invisibly.
 *
 * @param {string} taskDescription
 * @param {{streak:number, username?:string}} context
 * @returns {Promise<{evaluation:object, model:string, latencyMs:number, degraded:boolean}>}
 */
export async function evaluateSubmission(taskDescription, context = {}) {
  const started = Date.now();

  const today = new Date().toISOString().slice(0, 10);
  const prompt = [
    `Current UTC date: ${today}`,
    context.username ? `Username: ${context.username}` : null,
    context.streak ? `Current streak: ${context.streak} day(s)` : null,
    '',
    "The user's submission for today:",
    '---',
    taskDescription,
    '---',
    'Evaluate it now.',
  ]
    .filter(Boolean)
    .join('\n');

  // The abort signal is the safety net that makes the timeout guarantee real: an
  // SDK that ignores its own timeout config still gets cut off here, and because
  // nothing has been persisted yet the caller can safely treat this as "no verdict
  // rendered" rather than "submission lost".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('JUDGE_TIMEOUT')), JUDGE_TIMEOUT_MS);

  let response;
  try {
    response = await getClient().models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2,
        maxOutputTokens: 1024,
        abortSignal: controller.signal,
      },
    });
  } catch (err) {
    // Re-thrown with the timeout made explicit so the route's log distinguishes
    // "we stopped waiting" from "the provider said no".
    if (controller.signal.aborted) {
      const timeout = new Error(`Gemini timed out after ${JUDGE_TIMEOUT_MS}ms`);
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = response?.text;
  const evaluation = normalizeEvaluation(extractJson(text));

  return {
    evaluation,
    model: config.geminiModel,
    latencyMs: Date.now() - started,
    degraded: false,
  };
}
