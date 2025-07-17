-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "price" TEXT,
    "inventoryItemId" TEXT,
    CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT,
    "currentStock" INTEGER NOT NULL DEFAULT 0,
    "shop" TEXT NOT NULL,
    "lastStockCheck" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InventoryItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "inventoryId" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "saleDate" DATETIME NOT NULL,
    "orderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    CONSTRAINT "SalesData_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "InventoryItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopifyId_key" ON "Product"("shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_shopifyId_key" ON "ProductVariant"("shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_shopifyId_key" ON "InventoryItem"("shopifyId");

-- CreateIndex
CREATE INDEX "SalesData_sku_saleDate_idx" ON "SalesData"("sku", "saleDate");

-- CreateIndex
CREATE INDEX "SalesData_shop_saleDate_idx" ON "SalesData"("shop", "saleDate");
