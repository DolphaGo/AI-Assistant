import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVersion } from "../src/index.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

describe("getVersion", () => {
  it("harness package.json 의 version 을 그대로 읽는다", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirname, "..", "package.json"), "utf-8"));
    expect(getVersion()).toBe(pkg.version);
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
