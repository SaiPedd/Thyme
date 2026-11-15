// How roommates get the agent's attention: its name (BOT_NAME) or an alias (BOT_ALIASES), anywhere
// in the message, any case, with or without "@" or "hey".

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Triggers {
  names: string[];
  /** True if the message mentions the agent by name or alias. */
  mentions(text: string): boolean;
  /** Remove a leading "hey Thyme," / "@thyme:" so rule parsing sees the actual request. */
  strip(text: string): string;
}

export function makeTriggers(botName: string, aliases: string[] = []): Triggers {
  const names = [...new Set([botName, ...aliases].map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return { names, mentions: () => false, strip: (t) => t.trim() };
  const alt = names.map(escape).join("|");
  const anywhere = new RegExp(`(?:^|[^a-z0-9])@?(?:${alt})(?![a-z0-9])`, "i");
  const leading = new RegExp(`^\\s*(?:(?:hey|hi|yo|ok|okay)[,!]?\\s+)?@?(?:${alt})(?![a-z0-9])[\\s,:!.-]*`, "i");
  return {
    names,
    mentions: (text) => anywhere.test(text),
    strip: (text) => text.replace(leading, "").trim(),
  };
}
