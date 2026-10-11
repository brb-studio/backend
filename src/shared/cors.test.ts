import { expect, test } from "bun:test";
import { corsOrigin } from "./cors";

const allowed = {
  origins: "https://admin.example.com, https://shop.custom.mx",
  frontendUrl: "https://app.example.com/path",
  platformDomain: "example.com",
};

test("corsOrigin allows listed, frontend and tenant origins only", () => {
  expect(corsOrigin("https://shop.custom.mx", allowed)).toBe(
    "https://shop.custom.mx",
  );
  expect(corsOrigin("https://app.example.com", allowed)).toBe(
    "https://app.example.com",
  );
  expect(corsOrigin("https://magicstudio.example.com", allowed)).toBe(
    "https://magicstudio.example.com",
  );
  expect(corsOrigin("http://magicstudio.example.com", allowed)).toBe("");
  expect(corsOrigin("https://evilexample.com", allowed)).toBe("");
  expect(corsOrigin("https://example.com.evil.io", allowed)).toBe("");
  expect(corsOrigin("null", allowed)).toBe("");
  expect(
    corsOrigin("http://x.localhost:3000", {
      ...allowed,
      platformDomain: "localhost",
    }),
  ).toBe("http://x.localhost:3000");
});
