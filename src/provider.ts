// Multi-model synthesis — pluggable LLM layer.
//
// The agent's deterministic planner decides *what* to load; the provider layer
// decides *how* to call the model that answers the task. Every provider
// implements the same interface — complete() for batch, stream() for CLI —
// so the synthesis, grounding, and critique layers are model-agnostic.
//
// Two built-in providers:
//   AnthropicProvider  — wraps @anthropic-ai/sdk (optional dependency, same as before)
//   OpenAICompatProvider — raw fetch against any OpenAI-compatible endpoint (zero npm deps)
//
// Provider resolution: `provider/model-id` prefix routes to the right backend.

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface SynthesisProvider {
  /** The provider name for display. */
  name: string;
  /** The resolved model id (without the provider prefix). */
  model: string;
  /** Generate a completion from messages. */
  complete(messages: Message[], options?: CompletionOptions): Promise<string>;
  /** Stream a completion (for CLI output). */
  stream(messages: Message[], options?: CompletionOptions): AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// Anthropic provider — wraps the existing @anthropic-ai/sdk usage
// ---------------------------------------------------------------------------

/** Resolve the Claude SDK — an optional dependency — under Node or Deno. */
async function loadAnthropicSdkInternal(): Promise<typeof import("@anthropic-ai/sdk").default> {
  try {
    return (await import("@anthropic-ai/sdk")).default;
  } catch {
    try {
      return ((await import(
        // @ts-expect-error npm: specifier — resolvable by Deno, not by tsc
        "npm:@anthropic-ai/sdk@^0.68.0"
      )) as typeof import("@anthropic-ai/sdk")).default;
    } catch {
      throw new Error(
        "The Anthropic provider needs the Claude SDK. Install it:  npm install @anthropic-ai/sdk\n" +
          "and set ANTHROPIC_API_KEY (or run `ant auth login`)."
      );
    }
  }
}

export class AnthropicProvider implements SynthesisProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey?: string;

  constructor(model: string, options?: { apiKey?: string }) {
    this.model = model;
    this.apiKey = options?.apiKey;
  }

  async complete(messages: Message[], options?: CompletionOptions): Promise<string> {
    const Anthropic = await loadAnthropicSdkInternal();
    const client = new Anthropic(this.apiKey ? { apiKey: this.apiKey } : undefined);

    // Anthropic API uses a separate `system` parameter — extract system messages.
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const apiMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const message = await client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(system ? { system } : {}),
      messages: apiMessages,
    });

    return message.content
      .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  async *stream(messages: Message[], options?: CompletionOptions): AsyncIterable<string> {
    const Anthropic = await loadAnthropicSdkInternal();
    const client = new Anthropic(this.apiKey ? { apiKey: this.apiKey } : undefined);

    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const apiMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const stream = await client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(system ? { system } : {}),
      messages: apiMessages,
      stream: true,
    });

    for await (const event of stream as AsyncIterable<{ type: string; delta?: { type?: string; text?: string } }>) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        yield event.delta.text;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider — raw fetch, zero npm dependencies
// ---------------------------------------------------------------------------

/** Known base URLs for provider prefixes. */
const KNOWN_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
};

export class OpenAICompatProvider implements SynthesisProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(model: string, options?: { baseUrl?: string; apiKey?: string; providerName?: string }) {
    this.model = model;
    this.baseUrl = (options?.baseUrl ?? KNOWN_BASES.openai).replace(/\/+$/, "");
    this.apiKey = options?.apiKey;
    this.name = options?.providerName ?? "openai-compat";
  }

  /** Format messages into the OpenAI chat completions request body. */
  formatBody(messages: Message[], options?: CompletionOptions): object {
    return {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    };
  }

  async complete(messages: Message[], options?: CompletionOptions): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = this.formatBody(messages, options);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.name} API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json() as {
      choices?: { message?: { content?: string } }[];
    };

    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }

  async *stream(messages: Message[], options?: CompletionOptions): AsyncIterable<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = { ...this.formatBody(messages, options), stream: true };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.name} API error ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.body) {
      throw new Error(`${this.name} streaming response has no body`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
            };
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Non-JSON SSE lines (comments, keep-alives) — skip.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** Override the base URL for OpenAI-compatible providers. */
  baseUrl?: string;
  /** Override the API key (alternative to env vars). */
  apiKey?: string;
}

/**
 * Resolve a model string to a SynthesisProvider.
 *
 * Format: `provider/model-id`
 *   - `anthropic/claude-sonnet-4-20250514` -> AnthropicProvider
 *   - `openai/gpt-4o`                     -> OpenAICompatProvider (api.openai.com)
 *   - `groq/llama-3.1-70b`                -> OpenAICompatProvider (api.groq.com)
 *   - `ollama/llama3`                      -> OpenAICompatProvider (localhost:11434)
 *   - `http://...` or `https://...`        -> OpenAICompatProvider with that base URL
 *   - bare model id (no prefix)            -> auto-detect from env vars
 */
export function resolveProvider(model: string, options: ResolveOptions = {}): SynthesisProvider {
  // URL-based: the entire string is a base URL — model must come from elsewhere.
  // In practice this is used as `--base-url`, but we also accept it as a model
  // string for ergonomics (model defaults to "default").
  if (/^https?:\/\//i.test(model)) {
    const url = model;
    return new OpenAICompatProvider("default", {
      baseUrl: url,
      apiKey: options.apiKey ?? envKey("OPENAI_API_KEY"),
      providerName: "custom",
    });
  }

  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx).toLowerCase();
    const modelId = model.slice(slashIdx + 1);

    if (prefix === "anthropic") {
      return new AnthropicProvider(modelId, { apiKey: options.apiKey });
    }

    const knownBase = KNOWN_BASES[prefix];
    if (knownBase) {
      const envVar = prefix === "openai" ? "OPENAI_API_KEY" : `${prefix.toUpperCase()}_API_KEY`;
      return new OpenAICompatProvider(modelId, {
        baseUrl: options.baseUrl ?? knownBase,
        apiKey: options.apiKey ?? envKey(envVar) ?? envKey("OPENAI_API_KEY"),
        providerName: prefix,
      });
    }

    // Unknown prefix — treat as OpenAI-compatible with the prefix as provider name.
    return new OpenAICompatProvider(modelId, {
      baseUrl: options.baseUrl ?? KNOWN_BASES.openai,
      apiKey: options.apiKey ?? envKey("OPENAI_API_KEY"),
      providerName: prefix,
    });
  }

  // No prefix — auto-detect from environment.
  return autoDetect(model, options);
}

/** Auto-detect: try Anthropic if ANTHROPIC_API_KEY is set, else OpenAI if OPENAI_API_KEY is set. */
function autoDetect(model: string, options: ResolveOptions): SynthesisProvider {
  if (options.apiKey) {
    // An explicit key with no prefix — guess from the model name.
    if (model.startsWith("claude") || model.startsWith("claude-")) {
      return new AnthropicProvider(model, { apiKey: options.apiKey });
    }
    return new OpenAICompatProvider(model, {
      baseUrl: options.baseUrl ?? KNOWN_BASES.openai,
      apiKey: options.apiKey,
      providerName: "openai",
    });
  }

  if (envKey("ANTHROPIC_API_KEY")) {
    return new AnthropicProvider(model);
  }
  if (envKey("OPENAI_API_KEY")) {
    return new OpenAICompatProvider(model, {
      baseUrl: options.baseUrl ?? KNOWN_BASES.openai,
      apiKey: envKey("OPENAI_API_KEY"),
      providerName: "openai",
    });
  }

  // No keys found — default to Anthropic (will fail at call time with a clear message).
  return new AnthropicProvider(model);
}

/** Read an env var (returns undefined if empty or unset). */
function envKey(name: string): string | undefined {
  const v = typeof process !== "undefined" ? process.env[name] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}
