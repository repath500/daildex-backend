import { reconcileSentAlertItems } from "@daildex/core/alerts";
import { closeDatabase, getDatabase } from "@daildex/db";

try {
  await reconcileSentAlertItems(getDatabase());
  console.log(JSON.stringify({ event: "email.reconciliation.completed" }));
} finally {
  await closeDatabase();
}
