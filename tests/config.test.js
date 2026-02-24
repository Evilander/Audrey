import { describe, it, expect } from "vitest";
import { resolveEmbeddingProvider } from "../mcp-server/config.js";

describe("resolveEmbeddingProvider", () => {
  it("returns local when no keys present", () => {
    const result = resolveEmbeddingProvider({});
    expect(result.provider).toBe("local");
    expect(result.dimensions).toBe(384);
  });

  it("returns gemini when GOOGLE_API_KEY present", () => {
    const result = resolveEmbeddingProvider({ GOOGLE_API_KEY: "test-key" });
    expect(result.provider).toBe("gemini");
    expect(result.apiKey).toBe("test-key");
    expect(result.dimensions).toBe(768);
  });

  it("never auto-selects openai even if OPENAI_API_KEY present", () => {
    const result = resolveEmbeddingProvider({ OPENAI_API_KEY: "test-key" });
    expect(result.provider).not.toBe("openai");
  });

  it("returns openai when explicitly configured", () => {
    const result = resolveEmbeddingProvider({ OPENAI_API_KEY: "test-key" }, "openai");
    expect(result.provider).toBe("openai");
    expect(result.dimensions).toBe(1536);
  });

  it("returns local when explicitly configured", () => {
    const result = resolveEmbeddingProvider({}, "local");
    expect(result.provider).toBe("local");
    expect(result.dimensions).toBe(384);
  });
});
