-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAtSimMs" TEXT NOT NULL DEFAULT '0',
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_WebhookDelivery" ("attempts", "createdAt", "deliveredAt", "event", "id", "payload", "signature", "status", "subscriptionId") SELECT "attempts", "createdAt", "deliveredAt", "event", "id", "payload", "signature", "status", "subscriptionId" FROM "WebhookDelivery";
DROP TABLE "WebhookDelivery";
ALTER TABLE "new_WebhookDelivery" RENAME TO "WebhookDelivery";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
