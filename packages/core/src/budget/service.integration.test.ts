import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "@daildex/db";
import {
  budgetVoterKey,
  createBudgetUpdate,
  getBudgetLiveMemory,
  getBudgetPollResults,
  getBudgetPollResultsMany,
  listBudgetUpdatesForReview,
  listPublishedBudgetUpdates,
  recordBudgetPollVote,
  reviewBudgetUpdate,
} from "./service";

const url = process.env.BUDGET_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("Budget live updates and polls against a real database", () => {
  const database = postgres(url ?? "postgresql://unused", { max: 1, prepare: false, transform: { undefined: null } }) as unknown as Database;
  const budget = `test-${Date.now().toString(36)}`;
  const poll = `poll-${Date.now().toString(36)}`;
  process.env.TOKEN_HASH_PEPPER ??= "integration-test-pepper";

  const source = { url: "https://www.gov.ie/en/budget/example/", title: "Budget example", publisher: "Department of Finance" };
  const evidence = [{ url: source.url, quote: "The State pension will rise by €12 a week from January." }];

  afterAll(async () => {
    await database`DELETE FROM budget_live_updates WHERE budget = ${budget}`;
    await database`DELETE FROM budget_poll_votes WHERE poll = ${poll}`;
    await database.end({ timeout: 5 });
  });

  it("keeps worker drafts out of the feed until they are published", async () => {
    const id = await createBudgetUpdate({
      budget, kind: "measure", headline: "State pension to rise by €12 a week", body: "The contributory State pension rises by €12 a week from January.",
      sources: [source], evidence, origin: "worker", publish: false, model: "test-model",
    }, database);
    expect(id).toBeTruthy();
    expect(await listPublishedBudgetUpdates(budget, 10, database)).toEqual([]);

    const review = await listBudgetUpdatesForReview(budget, database);
    expect(review[0]).toMatchObject({ id, status: "pending", evidence, sources: [source], model: "test-model" });

    await reviewBudgetUpdate(id!, "publish", "editor@example.ie", database);
    const published = await listPublishedBudgetUpdates(budget, 10, database);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ id, headline: "State pension to rise by €12 a week", origin: "worker", pinned: false });
  });

  it("ignores a second update with the same headline in any word order", async () => {
    const duplicate = await createBudgetUpdate({
      budget, kind: "update", headline: "€12 a week rise to State pension", body: "Repeated update that should not be stored again.",
      sources: [source], evidence: [], origin: "worker", publish: true,
    }, database);
    expect(duplicate).toBeNull();
    const memory = await getBudgetLiveMemory(budget, database);
    expect(memory.headlines).toHaveLength(1);
    expect(memory.sourceUrls).toEqual([source.url]);
  });

  it("pins editor updates to the top and takes updates down", async () => {
    const editorId = await createBudgetUpdate({
      budget, kind: "update", headline: "Budget documents now published on gov.ie", body: "The Financial Statement and Expenditure Report are online.",
      sources: [source], evidence: [], origin: "editor", publish: true, actor: "editor@example.ie",
    }, database);
    const [first] = await listPublishedBudgetUpdates(budget, 10, database);
    expect(first.id).toBe(editorId);

    const pension = (await listPublishedBudgetUpdates(budget, 10, database)).find((update) => update.id !== editorId)!;
    await reviewBudgetUpdate(pension.id, "pin", "editor@example.ie", database);
    expect((await listPublishedBudgetUpdates(budget, 10, database))[0]).toMatchObject({ id: pension.id, pinned: true });

    await reviewBudgetUpdate(pension.id, "reject", "editor@example.ie", database);
    const remaining = await listPublishedBudgetUpdates(budget, 10, database);
    expect(remaining.map((update) => update.id)).toEqual([editorId]);
    await expect(reviewBudgetUpdate(pension.id, "pin", "editor@example.ie", database)).rejects.toThrow("not found");
  });

  it("counts one vote per browser and lets a reader change their answer", async () => {
    const first = budgetVoterKey("11111111-1111-4111-8111-111111111111");
    const second = budgetVoterKey("22222222-2222-4222-8222-222222222222");
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    await recordBudgetPollVote(poll, first, "housing", database);
    await recordBudgetPollVote(poll, second, "housing", database);
    await recordBudgetPollVote(poll, first, "health", database);

    expect(await getBudgetPollResults(poll, first, database)).toEqual({ counts: { housing: 1, health: 1 }, total: 2, mine: "health" });
    expect((await getBudgetPollResults(poll, null, database)).mine).toBeNull();
    expect(await getBudgetPollResultsMany([poll, `${poll}-empty`], second, database)).toEqual({
      [poll]: { counts: { housing: 1, health: 1 }, total: 2, mine: "housing" },
      [`${poll}-empty`]: { counts: {}, total: 0, mine: null },
    });
  });
});
