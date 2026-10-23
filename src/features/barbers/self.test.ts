import { expect, test } from "bun:test";
import { SLUG } from "../tenancy/schemas";
import { slugOf } from "./self";

test("a barber slug comes from the owner's name, accents and symbols out", () => {
  expect(slugOf("Dueña Demo")).toBe("duena-demo");
  expect(slugOf("  José  Ángel  O'Neil ")).toBe("jose-angel-o-neil");
  expect(slugOf("✂️")).toBe("barbero");
  for (const name of ["Dueña Demo", "x".repeat(200), "✂️"]) {
    expect(SLUG.test(slugOf(name))).toBe(true);
  }
});
