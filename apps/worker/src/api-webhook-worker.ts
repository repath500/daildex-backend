import { closeDatabase, getDatabase } from "@daildex/db";
import { deliverDueWebhooks, queueWebhookEvents } from "@daildex/core/public-api/webhooks";

// Queue deliveries for records stored since the last run, then send everything that is due.
// Runs from a timer every few minutes; a record is announced once per webhook (unique key).
const database = getDatabase();
try {
  const queued = await queueWebhookEvents(database);
  let totals = { delivered: 0, retried: 0, dead: 0 };
  for (let round = 0; round < 10; round += 1) {
    const result = await deliverDueWebhooks({ batch: 50 }, database);
    totals = {
      delivered: totals.delivered + result.delivered,
      retried: totals.retried + result.retried,
      dead: totals.dead + result.dead,
    };
    if (result.delivered + result.retried + result.dead < 50) break;
  }
  console.log(JSON.stringify({ evt: "api_webhooks", queued, ...totals }));
} finally {
  await closeDatabase();
}
