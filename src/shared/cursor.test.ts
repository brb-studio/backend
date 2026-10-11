import { expect, test } from "bun:test";
import { collect, mapBy } from "./cursor";

type Doc = { id: string; n: number; big: string };

async function* docs(): AsyncGenerator<Doc> {
  yield { id: "a", n: 1, big: "x".repeat(10) };
  yield { id: "b", n: 2, big: "y".repeat(10) };
}

test("without pick the documents keep their type", async () => {
  const all: Doc[] = await collect(docs());
  expect(all.map((d) => d.id)).toEqual(["a", "b"]);
  const byId: Map<string, Doc> = await mapBy(docs(), (d) => d.id);
  expect(byId.get("b")?.big).toBe("y".repeat(10));
});

test("with pick only what is picked is kept, with the inferred type", async () => {
  const numbers: number[] = await collect(docs(), (d) => d.n);
  expect(numbers).toEqual([1, 2]);
  const slim: Map<string, { n: number }> = await mapBy(
    docs(),
    (d) => d.id,
    (d) => ({ n: d.n }),
  );
  expect(slim.get("a")).toEqual({ n: 1 });
  expect(slim.size).toBe(2);
});
