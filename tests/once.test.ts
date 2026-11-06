import { describe, expect, test } from "bun:test";
import { oneTimeJobs, runOnce } from "../src/db/once";
import { api, createShop } from "./helpers";

describe("one-time jobs", () => {
  test("a job runs once, however many times it is asked", async () => {
    let runs = 0;
    const job = async () => ++runs;
    expect(await runOnce("test-once", job)).toBe(true);
    expect(await runOnce("test-once", job)).toBe(false);
    expect(runs).toBe(1);
    expect(await oneTimeJobs.findOne({ _id: "test-once" })).toMatchObject({
      doneAt: expect.any(Date),
      result: "1",
    });
  });

  test("a failed job is released and runs again on the next try", async () => {
    let runs = 0;
    const flaky = async () => {
      runs++;
      if (runs === 1) throw new Error("db down");
      return "ok";
    };
    await expect(runOnce("test-flaky", flaky)).rejects.toThrow("db down");
    expect(await runOnce("test-flaky", flaky)).toBe(true);
    expect(runs).toBe(2);
  });

  test("a run that died is taken over only once it is stale", async () => {
    const now = new Date();
    await oneTimeJobs.insertOne({
      _id: "test-stuck",
      startedAt: new Date(now.getTime() - 60_000),
    });
    let runs = 0;
    const job = async () => ++runs;
    expect(await runOnce("test-stuck", job, now)).toBe(false);
    expect(
      await runOnce("test-stuck", job, new Date(now.getTime() + 20 * 60_000)),
    ).toBe(true);
    expect(runs).toBe(1);
  });

  test("the API fills the ledger once after a deploy", async () => {
    const { asOwner } = await createShop();
    expect((await api("GET", "/v1/tenant", asOwner)).status).toBe(200);
    expect(
      await oneTimeJobs.findOne({ _id: "ledger-backfill-2026-11" }),
    ).toMatchObject({ doneAt: expect.any(Date) });
  });
});
