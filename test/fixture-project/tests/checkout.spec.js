import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

test.describe("Checkout", () => {
  test("adds item to cart", async () => {
    expect(1 + 1).toBe(2);
  });

  test("applies discount code", async ({}, testInfo) => {
    // Real bug: total is wrong. Attach a fake screenshot so upload is exercised.
    const shot = testInfo.outputPath("failure.png");
    writeFileSync(shot, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff1f0003030200ef9e2b6e0000000049454e44ae426082", "hex"));
    await testInfo.attach("screenshot", { path: shot, contentType: "image/png" });
    expect({ total: 90 + testInfo.retry }).toEqual({ total: 85 });
  });

  test("shows order confirmation", async ({}, testInfo) => {
    // Flaky: fails on the first attempt only.
    expect(testInfo.retry).toBeGreaterThan(0);
  });
});

test("loads product API", async () => {
  // Environment: nothing listens on this port in CI.
  await fetch("http://127.0.0.1:65530/api/products");
});
