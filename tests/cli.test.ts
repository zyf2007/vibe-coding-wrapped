import { describe, expect, it } from "vitest";
import { parseBindAddress } from "../src/cli/main.js";

describe("serve bind address", () => {
  it("parses IPv4, hostnames, and bracketed IPv6", () => {
    expect(parseBindAddress("0.0.0.0:5173")).toEqual({ host: "0.0.0.0", port: 5173 });
    expect(parseBindAddress(" localhost:4173 ")).toEqual({ host: "localhost", port: 4173 });
    expect(parseBindAddress("[::]:5173")).toEqual({ host: "::", port: 5173 });
  });

  it("rejects missing and out-of-range ports", () => {
    expect(() => parseBindAddress("0.0.0.0")).toThrow(/HOST:PORT/);
    expect(() => parseBindAddress("0.0.0.0:70000")).toThrow(/65535/);
  });
});
