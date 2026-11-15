// The agent: a Gemini (Interactions API) function-calling loop, max 6 tool rounds, 10 s total,
// with the rule-based fallback on LLM=off, no key, timeout, empty reply, or error.
// Gemini chooses words and tools; tools return facts. A reply that states a dollar amount no tool
// (or the user) produced is rejected.

import { GoogleGenAI } from "@google/genai";
import { describeToolResult, parseIntent, runFallback } from "./fallback";
import { systemPrompt, turnContext } from "./prompt";
import { runToolAsync, toolDefinitions, type ToolContext } from "./tools";

export const MAX_TOOL_ITERATIONS = 6;
export const AGENT_TIMEOUT_MS = 10_000;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** The slice of the Interactions API we use (lets tests pass a fake). */
export interface GeminiLike {
  interactions: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<GeminiInteraction>;
  };
}

/** The response fields we read. Steps are passed back to the API exactly as received. */
export interface GeminiInteraction {
  status?: string;
  output_text?: string;
  steps: Record<string, any>[];
}

export interface AgentInput {
  text: string;
  ctx: ToolContext;
  history: HistoryTurn[];
  botName: string;
  model: string;
  localDate: string;
  /** null = LLM off or no key: use the fallback. */
  client: GeminiLike | null;
  timeoutMs?: number;
}

export interface AgentResult {
  reply: string | null;
  source: "gemini" | "fallback" | "tools" | "none";
  toolCalls: string[];
  /** Why the model wasn't used, for logs (never contains message text). */
  note?: string;
}

const SORRY = "Sorry, I'm having trouble right now. Try again in a minute.";
const AMOUNT = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
const normAmount = (s: string) => s.replace(/[\s,]/g, "").replace(/\.00$/, "");

/** Every dollar amount in the reply must come from a tool result or the user's own message. */
export function amountsAreGrounded(reply: string, sources: string[]): boolean {
  const known = new Set(sources.flatMap((s) => (s.match(AMOUNT) ?? []).map(normAmount)));
  return (reply.match(AMOUNT) ?? []).every((a) => known.has(normAmount(a)));
}

const DURATION = /\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|weeks?|months?|years?)\b/gi;

/** Every number in a duration ("4 to 6 days") must appear in a duration in a tool result or the user's message. */
export function durationsAreGrounded(reply: string, sources: string[]): boolean {
  const known = new Set(
    sources.flatMap((s) => [...s.matchAll(DURATION)].flatMap((m) => [m[1], m[2]].filter((n): n is string => n !== undefined))),
  );
  for (const m of reply.matchAll(DURATION)) {
    for (const n of [m[1], m[2]]) if (n !== undefined && !known.has(n)) return false;
  }
  return true;
}

/**
 * If the reply uses a TheMealDB recipe, make sure the link and the credit are in it (code, not the model,
 * guarantees attribution and that they can open the full recipe).
 */
export function withRecipeCredit(reply: string, toolResults: { name: string; result: Record<string, unknown> }[]): string {
  type Meal = { title?: unknown; link?: unknown; credit?: unknown };
  const meals: Meal[] = [];
  for (const t of toolResults) {
    if (t.name !== "suggest_recipe") continue;
    if (t.result.source === "TheMealDB") meals.push(t.result as Meal);
    if (t.result.mealdb_idea) meals.push(t.result.mealdb_idea as Meal); // the extra idea next to a built-in recipe
  }
  const lower = reply.toLowerCase();
  // The MealDB recipe the reply talks about: by title, else the main MealDB result.
  const meal =
    meals.reverse().find((m) => typeof m.title === "string" && lower.includes(m.title.toLowerCase())) ??
    (toolResults.findLast?.((t) => t.name === "suggest_recipe")?.result.source === "TheMealDB" ? meals[0] : undefined);
  if (!meal) return reply;
  const extra: string[] = [];
  if (typeof meal.link === "string" && !reply.includes(meal.link)) extra.push(`Full recipe: ${meal.link}`);
  if (!/themealdb/i.test(reply) && meal.credit) extra.push(String(meal.credit));
  return extra.length ? `${reply}\n${extra.join("\n")}` : reply;
}

/** Intents answered by code, never by the model's wording. */
const FACT_QUESTIONS = new Set(["inventory", "balances", "waste"]);

/** "I sent your balance to your DMs", "I DM'd you": only true if a private message was actually queued. */
export function claimsPrivateSend(reply: string): boolean {
  return /\b(sent|send|texted|messaged)\b[^.!?\n]*\b(DMs?|privately|private message)\b|\bDM'?d (you|them)\b/i.test(reply);
}

/** Recent chat as plain text, so we never replay old model turns in an undocumented format. */
function renderHistory(history: HistoryTurn[], botName: string): string {
  if (history.length === 0) return "";
  const lines = history.map((h) => (h.role === "assistant" ? `${botName}: ${h.content}` : h.content));
  return `Recent conversation (oldest first, background only; act only on the new message below):\n${lines.join("\n")}\n\n`;
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const { ctx, text, botName } = input;
  const toolCalls: string[] = [];
  const toolResults: { name: string; result: Record<string, unknown> }[] = [];

  const fallback = async (note: string): Promise<AgentResult> => {
    // If a tool already ran this turn (e.g. an expense was saved), don't run the fallback too:
    // that would apply the action twice. Report the last result instead.
    const last = toolResults.at(-1);
    if (last) return { reply: describeToolResult(last.name, last.result) ?? SORRY, source: "tools", toolCalls, note };
    const reply = await runFallback(text, ctx, botName);
    return { reply, source: reply ? "fallback" : "none", toolCalls, note };
  };

  if (!input.client) return fallback("llm off");
  // Questions whose whole answer is a list of facts (what's in the fridge, balances, waste) are
  // answered by code directly: the model has made up items and "I DM'd you" for these before.
  const intent = parseIntent(text, botName);
  if (intent && FACT_QUESTIONS.has(intent.kind)) return fallback("fact question");

  // Names the sender actually used: the new message plus their own recent messages (not other people's).
  const own = input.history
    .filter((h) => h.role === "user" && (!ctx.isGroup || h.content.startsWith(`${ctx.member.name}: `)))
    .map((h) => h.content);
  const toolCtx: ToolContext = { ...ctx, mentionText: [text, ...own].join("\n") };

  const timeoutMs = input.timeoutMs ?? AGENT_TIMEOUT_MS;
  const started = performance.now();
  const context = turnContext({
    isGroup: ctx.isGroup,
    senderName: ctx.member.name,
    memberNames: ctx.members.map((m) => m.name),
    localDate: input.localDate,
  });
  const steps: Record<string, unknown>[] = [
    { type: "user_input", content: [{ type: "text", text: `${renderHistory(input.history, botName)}${context}\nNew message:\n${ctx.member.name}: ${text}` }] },
  ];
  const tools = toolDefinitions();

  try {
    for (let i = 0; i <= MAX_TOOL_ITERATIONS; i++) {
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining < 250) return fallback("timeout");

      // Enforce the turn deadline ourselves (abort + race), not only via the SDK timeout.
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve("timeout");
        }, remaining);
      });
      const interaction = await Promise.race([
        input.client.interactions.create(
          {
            model: input.model,
            store: false,
            system_instruction: systemPrompt(botName),
            input: steps,
            tools,
            // Measured: the default thinking took ~12 s per tool turn on Flash-Lite; "low" ~1.5 s.
            generation_config: { tool_choice: "auto", thinking_level: "low" },
            automatic_continuation: false,
          },
          { timeout_ms: Math.ceil(remaining), signal: abort.signal, maxRetries: 0 },
        ),
        deadline,
      ]).finally(() => clearTimeout(timer));
      if (interaction === "timeout") return fallback("timeout");
      if (interaction.status && !["completed", "requires_action"].includes(interaction.status)) {
        return fallback(`status ${interaction.status}`);
      }

      const calls = interaction.steps.filter((s) => s.type === "function_call");
      if (calls.length === 0) {
        const reply = (interaction.output_text ?? "").trim();
        if (!reply) return fallback("empty reply");
        const sources = [text, ...toolResults.map((t) => JSON.stringify(t.result))];
        if (!amountsAreGrounded(reply, sources)) return fallback("ungrounded amount");
        if (!durationsAreGrounded(reply, sources)) return fallback("ungrounded duration");
        if (claimsPrivateSend(reply) && ctx.drafts.length === 0) return fallback("claimed a DM that wasn't sent");
        return { reply: withRecipeCredit(reply, toolResults), source: "gemini", toolCalls };
      }

      if (i === MAX_TOOL_ITERATIONS) return fallback("too many tool calls");
      // Model steps go back exactly as received, then one function_result per call.
      steps.push(...interaction.steps);
      for (const call of calls) {
        toolCalls.push(String(call.name));
        let payload: Record<string, unknown>;
        let isError = false;
        try {
          payload = await runToolAsync(String(call.name), call.arguments ?? {}, toolCtx);
          toolResults.push({ name: String(call.name), result: payload });
        } catch (error) {
          payload = { error: (error as Error).message };
          isError = true;
        }
        steps.push({
          type: "function_result",
          name: call.name,
          call_id: call.id,
          result: [{ type: "text", text: JSON.stringify(payload) }],
          ...(isError ? { is_error: true } : {}),
        });
      }
    }
    return fallback("too many tool calls");
  } catch (error) {
    const status = (error as { status?: number }).status;
    return fallback(status ? `api ${status}` : (error as Error).name);
  }
}

/** Build the client, or null when the LLM is off or no key is set. */
export function makeClient(opts: { llm: boolean; apiKey?: string }): GeminiLike | null {
  if (!opts.llm || !opts.apiKey) return null;
  return new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as GeminiLike;
}
