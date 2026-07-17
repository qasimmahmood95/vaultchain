-- One TravelRuleRecord per (transaction, direction): makes a concurrent
-- double-attach impossible at the DB layer (adversarial gate F3). The second
-- racing attach hits a unique violation (P2002) and is rejected 409.
CREATE UNIQUE INDEX "TravelRuleRecord_transactionId_direction_key" ON "TravelRuleRecord"("transactionId", "direction");
