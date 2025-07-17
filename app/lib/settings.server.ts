import db from "../db.server";

export async function getAppSettings(shop: string) {
  let settings = await db.appSettings.findUnique({
    where: { shop }
  });

  // If no settings exist, create default ones
  if (!settings) {
    settings = await db.appSettings.create({
      data: {
        shop,
        stockCoverageDays: 30,
        lowStockThreshold: 7,
        mediumStockThreshold: 14,
        reorderPoint: 0.1,
        emailNotifications: true
      }
    });
  }

  return settings;
}

export interface AppSettingsType {
  stockCoverageDays: number;
  lowStockThreshold: number;
  mediumStockThreshold: number;
  reorderPoint: number;
  emailNotifications: boolean;
}

export function getStockStatus(currentStock: number, salesVelocity: number, settings: AppSettingsType) {
  const daysOfStock = salesVelocity > 0 ? currentStock / salesVelocity : Infinity;
  
  if (daysOfStock < settings.lowStockThreshold) {
    return 'low';
  } else if (daysOfStock < settings.mediumStockThreshold) {
    return 'medium';
  } else {
    return 'good';
  }
}

export function calculateSuggestedQuantity(currentStock: number, salesVelocity: number, settings: AppSettingsType) {
  if (salesVelocity <= 0) return 0;
  
  const targetStock = Math.ceil(salesVelocity * settings.stockCoverageDays);
  const suggestedQuantity = Math.max(0, targetStock - currentStock);
  
  // Apply safety buffer
  return Math.ceil(suggestedQuantity * (1 + settings.reorderPoint));
} 