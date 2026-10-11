import { expect, test } from "bun:test";
import { isValidClabe } from "./clabe";

test("accepts a CLABE with a correct check digit and rejects anything else", () => {

  expect(isValidClabe("002010077777777771")).toBe(true);
  expect(isValidClabe("032180000118359719")).toBe(true);
  expect(isValidClabe("002010077777777772")).toBe(false);
  expect(isValidClabe("00201007777777777")).toBe(false);
  expect(isValidClabe("00201007777777777a")).toBe(false);
  expect(isValidClabe("0020100777777777710")).toBe(false);
});
