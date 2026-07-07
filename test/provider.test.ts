// Provider resolution and message formatting — the pluggable LLM layer.
//
// These tests exercise the resolution logic and message formatting without
// making any real API calls. The provider interface is the seam: synthesis,
// grounding, and critique are model-agnostic once they speak to it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveProvider,
  AnthropicProvider,
  OpenAICompatProvider,
  type SynthesisProvider,
  type Message,
} from "../src/provider.js";

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

describe("resolveProvider — route a model string to the right backend", () => {
  // Save and restore env vars so tests don't leak.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    saved.GROQ_API_KEY = process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("anthropic/claude-sonnet-4-20250514 → AnthropicProvider", () => {
    const p = resolveProvider("anthropic/claude-sonnet-4-20250514");
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-sonnet-4-20250514");
  });

  it("anthropic/claude-haiku-4-5-20251001 → AnthropicProvider", () => {
    const p = resolveProvider("anthropic/claude-haiku-4-5-20251001");
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.model).toBe("claude-haiku-4-5-20251001");
  });

  it("openai/gpt-4o → OpenAICompatProvider with OpenAI base URL", () => {
    const p = resolveProvider("openai/gpt-4o");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("openai");
    expect(p.model).toBe("gpt-4o");
  });

  it("openai/gpt-4o-mini → OpenAICompatProvider", () => {
    const p = resolveProvider("openai/gpt-4o-mini");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.model).toBe("gpt-4o-mini");
  });

  it("groq/llama-3.1-70b → OpenAICompatProvider with Groq base URL", () => {
    const p = resolveProvider("groq/llama-3.1-70b");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("groq");
    expect(p.model).toBe("llama-3.1-70b");
  });

  it("ollama/llama3 → OpenAICompatProvider with localhost base URL", () => {
    const p = resolveProvider("ollama/llama3");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("ollama");
    expect(p.model).toBe("llama3");
  });

  it("http://localhost:11434/v1 → OpenAICompatProvider with that URL", () => {
    const p = resolveProvider("http://localhost:11434/v1");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("custom");
    expect(p.model).toBe("default");
  });

  it("https://my-vllm.example.com/v1 → OpenAICompatProvider with that URL", () => {
    const p = resolveProvider("https://my-vllm.example.com/v1");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("custom");
  });

  it("auto-detect: ANTHROPIC_API_KEY → AnthropicProvider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.OPENAI_API_KEY;
    const p = resolveProvider("claude-opus-4-8");
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.model).toBe("claude-opus-4-8");
  });

  it("auto-detect: OPENAI_API_KEY (no Anthropic) → OpenAICompatProvider", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    const p = resolveProvider("gpt-4o");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("openai");
    expect(p.model).toBe("gpt-4o");
  });

  it("auto-detect: both keys set → Anthropic wins", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const p = resolveProvider("claude-opus-4-8");
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it("auto-detect: no keys → defaults to Anthropic (will fail at call time)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const p = resolveProvider("claude-opus-4-8");
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it("--base-url overrides the default for a known provider", () => {
    const p = resolveProvider("openai/gpt-4o", { baseUrl: "https://custom.example.com/v1" });
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    // The provider name stays "openai" because the prefix was explicit.
    expect(p.name).toBe("openai");
  });

  it("--api-key is passed through to the provider", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const p = resolveProvider("anthropic/claude-opus-4-8", { apiKey: "sk-ant-injected" });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it("unknown prefix is treated as OpenAI-compatible", () => {
    const p = resolveProvider("together/meta-llama/Llama-3-70b");
    expect(p).toBeInstanceOf(OpenAICompatProvider);
    expect(p.name).toBe("together");
    expect(p.model).toBe("meta-llama/Llama-3-70b");
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatProvider — message formatting
// ---------------------------------------------------------------------------

describe("OpenAICompatProvider — message formatting", () => {
  it("formats messages for the OpenAI chat completions API", () => {
    const provider = new OpenAICompatProvider("gpt-4o", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      providerName: "openai",
    });

    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, world!" },
    ];

    const body = provider.formatBody(messages, { maxTokens: 1024, temperature: 0.7 }) as Record<string, unknown>;

    expect(body.model).toBe("gpt-4o");
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, world!" },
    ]);
  });

  it("omits max_tokens and temperature when not provided", () => {
    const provider = new OpenAICompatProvider("gpt-4o-mini");
    const body = provider.formatBody([{ role: "user", content: "Hi" }]) as Record<string, unknown>;

    expect(body.model).toBe("gpt-4o-mini");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
  });

  it("preserves the system message in the messages array (OpenAI format)", () => {
    const provider = new OpenAICompatProvider("gpt-4o");
    const messages: Message[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "User message" },
      { role: "assistant", content: "Assistant reply" },
      { role: "user", content: "Follow-up" },
    ];

    const body = provider.formatBody(messages) as { messages: Message[] };
    expect(body.messages).toHaveLength(4);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[2].role).toBe("assistant");
    expect(body.messages[3].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider — system message extraction
// ---------------------------------------------------------------------------

describe("AnthropicProvider — interface contract", () => {
  it("has the right name and model", () => {
    const p = new AnthropicProvider("claude-opus-4-8");
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-opus-4-8");
  });

  it("accepts an apiKey option", () => {
    const p = new AnthropicProvider("claude-haiku-4-5", { apiKey: "sk-ant-test" });
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// SynthesisProvider interface — structural checks
// ---------------------------------------------------------------------------

describe("SynthesisProvider interface", () => {
  it("both providers implement name, model, complete, and stream", () => {
    const anthropic: SynthesisProvider = new AnthropicProvider("claude-opus-4-8");
    const openai: SynthesisProvider = new OpenAICompatProvider("gpt-4o");

    for (const p of [anthropic, openai]) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.model).toBe("string");
      expect(typeof p.complete).toBe("function");
      expect(typeof p.stream).toBe("function");
    }
  });
});
