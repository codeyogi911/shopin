-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "stockCoverageDays" INTEGER NOT NULL DEFAULT 30,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 7,
    "mediumStockThreshold" INTEGER NOT NULL DEFAULT 14,
    "reorderPoint" REAL NOT NULL DEFAULT 0.1,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");

-- CreateIndex
CREATE INDEX "AppSettings_shop_idx" ON "AppSettings"("shop");
