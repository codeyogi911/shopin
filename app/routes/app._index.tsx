import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
  Icon,
  Box,
  List,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { AlertCircleIcon, CheckCircleIcon, AlertTriangleIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

// Types for our data
interface InventoryData {
  id: string;
  sku: string;
  title: string;
  vendor: string;
  currentStock: number;
  salesLast90Days: number;
  salesValue90Days: number;
  salesVelocity: number;
  lastStockCheck: string;
}

interface DashboardSummary {
  totalProducts: number;
  totalStock: number;
  totalSales: number;
  totalSalesValue: number;
  lowStockItems: InventoryData[];
  topSellingItems: InventoryData[];
  storeHealth: 'excellent' | 'good' | 'warning' | 'critical';
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  try {
    // Fetch products with variants - using only basic, reliable fields
    const productsResponse = await admin.graphql(`
      query GetProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              vendor
              variants(first: 10) {
                edges {
                  node {
                    id
                    sku
                    price
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `, {
      variables: { first: 50 }
    });

    const productsData = await productsResponse.json();

    // Check for GraphQL errors
    if (productsData && 'errors' in productsData && productsData.errors) {
      console.error('Products GraphQL errors:', productsData.errors);
      throw new Error('Failed to fetch products');
    }
    
    // Process and combine data
    const inventoryMap = new Map();
    const salesMap = new Map();
    const salesValueMap = new Map();
    
    // Process products and inventory levels
    const allSkus: string[] = [];
    productsData.data?.products?.edges?.forEach((productEdge: any) => {
      const product = productEdge.node;
      
      product.variants?.edges?.forEach((variantEdge: any) => {
        const variant = variantEdge.node;
        
        if (variant?.sku) {
          // Use inventoryQuantity from the variant (legacy field but reliable)
          const available = variant.inventoryQuantity || 0;
          
          inventoryMap.set(variant.sku, {
            available,
            title: product.title || 'Unknown Product',
            vendor: product.vendor || 'Unknown Vendor',
            variantId: variant.id,
            productId: product.id
          });
          
          // Collect SKUs for sales query
          allSkus.push(variant.sku);
        }
      });
    });
    
    // Fetch sales data for past 3 months using SKU-based query
    if (allSkus.length > 0) {
      try {
        // Build query string with all SKUs using OR operator
        const skuQuery = allSkus.map(sku => `line_items.sku:${sku}`).join(' OR ');
        
        // Calculate date 3 months ago
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        
        const ordersResponse = await admin.graphql(`
          query GetSalesForMultipleSkus($first: Int!, $query: String!) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  name
                  createdAt
                  lineItems(first: 50) {
                    edges {
                      node {
                        sku
                        quantity
                        discountedTotalSet {
                          shopMoney {
                            amount
                            currencyCode
                          }
                        }
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `, {
          variables: { 
            first: 100,
            query: skuQuery
          }
        });

        const ordersData = await ordersResponse.json();
        
        // Check for GraphQL errors
        if (ordersData && 'errors' in ordersData && ordersData.errors) {
          console.error('Orders GraphQL errors:', ordersData.errors);
          // Continue without sales data if orders fail
        } else {
          // Process sales data (last 90 days)
          ordersData.data?.orders?.edges?.forEach((edge: any) => {
            const order = edge.node;
            const orderDate = new Date(order.createdAt);
            
            if (orderDate >= threeMonthsAgo) {
              order.lineItems?.edges?.forEach((lineItemEdge: any) => {
                const lineItem = lineItemEdge.node;
                const sku = lineItem.sku;
                
                if (sku && allSkus.includes(sku)) {
                  // Aggregate quantity
                  salesMap.set(sku, (salesMap.get(sku) || 0) + lineItem.quantity);
                  
                  // Aggregate sales value
                  const amount = parseFloat(lineItem.discountedTotalSet?.shopMoney?.amount || '0');
                  salesValueMap.set(sku, (salesValueMap.get(sku) || 0) + amount);
                }
              });
            }
          });
        }
      } catch (error) {
        console.error('Error fetching sales data:', error);
        // Continue without sales data
      }
    }
    
    // Combine data into final format
    const combinedData: InventoryData[] = [];
    
    inventoryMap.forEach((inventoryInfo, sku) => {
      const salesLast90Days = salesMap.get(sku) || 0;
      const salesValue90Days = salesValueMap.get(sku) || 0;
      const salesVelocity = salesLast90Days / 90; // daily average
      
      combinedData.push({
        id: sku,
        sku: sku || 'N/A',
        title: inventoryInfo.title,
        vendor: inventoryInfo.vendor,
        currentStock: inventoryInfo.available,
        salesLast90Days,
        salesValue90Days,
        salesVelocity: Math.round(salesVelocity * 100) / 100,
        lastStockCheck: new Date().toISOString()
      });
    });
    
    // Calculate dashboard analytics
    const lowStockItems = combinedData.filter(item => {
      const daysOfStock = item.salesVelocity > 0 ? item.currentStock / item.salesVelocity : Infinity;
      return daysOfStock < 14; // Less than 14 days of stock
    }).sort((a, b) => {
      const aDays = a.salesVelocity > 0 ? a.currentStock / a.salesVelocity : Infinity;
      const bDays = b.salesVelocity > 0 ? b.currentStock / b.salesVelocity : Infinity;
      return aDays - bDays;
    });
    
    const topSellingItems = combinedData
      .filter(item => item.salesLast90Days > 0)
      .sort((a, b) => b.salesLast90Days - a.salesLast90Days)
      .slice(0, 5);
    
    // Calculate store health
    const criticalItems = combinedData.filter(item => {
      const daysOfStock = item.salesVelocity > 0 ? item.currentStock / item.salesVelocity : Infinity;
      return daysOfStock < 7;
    }).length;
    
    const warningItems = combinedData.filter(item => {
      const daysOfStock = item.salesVelocity > 0 ? item.currentStock / item.salesVelocity : Infinity;
      return daysOfStock >= 7 && daysOfStock < 14;
    }).length;
    
    let storeHealth: 'excellent' | 'good' | 'warning' | 'critical' = 'excellent';
    if (criticalItems > 0) {
      storeHealth = 'critical';
    } else if (warningItems > 3) {
      storeHealth = 'warning';
    } else if (warningItems > 0) {
      storeHealth = 'good';
    }
    
    const summary: DashboardSummary = {
      totalProducts: combinedData.length,
      totalStock: combinedData.reduce((sum, item) => sum + item.currentStock, 0),
      totalSales: combinedData.reduce((sum, item) => sum + item.salesLast90Days, 0),
      totalSalesValue: combinedData.reduce((sum, item) => sum + item.salesValue90Days, 0),
      lowStockItems,
      topSellingItems,
      storeHealth
    };
    
    return json({
      inventory: combinedData,
      summary,
      error: null
    });
    
  } catch (error) {
    console.error('Error fetching inventory data:', error);
    
    return json({
      inventory: [],
      summary: {
        totalProducts: 0,
        totalStock: 0,
        totalSales: 0,
        totalSalesValue: 0,
        lowStockItems: [],
        topSellingItems: [],
        storeHealth: 'critical' as const
      },
      error: `Failed to load inventory data: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  
  // Handle refresh action
  const formData = await request.formData();
  const action = formData.get('action');
  
  if (action === 'refresh') {
    return json({ success: true });
  }
  
  return json({ success: false });
};

export default function Dashboard() {
  const { summary, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const handleRefresh = () => {
    setIsRefreshing(true);
    fetcher.submit({ action: 'refresh' }, { method: 'post' });
    window.location.reload();
  };
  
  const getStoreHealthIcon = () => {
    switch (summary.storeHealth) {
      case 'excellent':
        return <Icon source={CheckCircleIcon} tone="success" />;
      case 'good':
        return <Icon source={CheckCircleIcon} tone="primary" />;
      case 'warning':
        return <Icon source={AlertTriangleIcon} tone="warning" />;
      case 'critical':
        return <Icon source={AlertCircleIcon} tone="critical" />;
    }
  };
  
  const getStoreHealthMessage = () => {
    switch (summary.storeHealth) {
      case 'excellent':
        return { title: "Store Health: Excellent", message: "All inventory levels are healthy. No immediate action needed." };
      case 'good':
        return { title: "Store Health: Good", message: "Most inventory is healthy with a few items to monitor." };
      case 'warning':
        return { title: "Store Health: Needs Attention", message: "Several items need replenishment soon. Review low stock alerts." };
      case 'critical':
        return { title: "Store Health: Critical", message: "Immediate action required! Multiple items are critically low on stock." };
    }
  };

  const healthInfo = getStoreHealthMessage();
  
  return (
    <Page>
      <TitleBar title="Store Dashboard">
        <Button 
          variant="primary" 
          onClick={handleRefresh}
          loading={isRefreshing}
        >
          Refresh Data
        </Button>
      </TitleBar>
      
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Error">
            {error}
          </Banner>
        )}
        
        {/* Store Health Status */}
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="300" align="start">
              {getStoreHealthIcon()}
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {healthInfo.title}
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {healthInfo.message}
                </Text>
              </BlockStack>
            </InlineStack>
            
            {summary.storeHealth !== 'excellent' && (
              <Box background="bg-surface-secondary" padding="400" borderRadius="200">
                <Text as="p" variant="bodyMd">
                  <strong>Quick Actions:</strong> 
                  {summary.storeHealth === 'critical' && " Contact suppliers immediately for critical items."}
                  {summary.storeHealth === 'warning' && " Review reorder points and plan restocking."}
                  {summary.storeHealth === 'good' && " Monitor trending items for early restocking."}
                </Text>
              </Box>
            )}
          </BlockStack>
        </Card>
        
        {/* Key Performance Indicators */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Key Performance Indicators (90 Days)
            </Text>
            <InlineStack gap="600" align="space-evenly">
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Total Products
                </Text>
                <Text as="p" variant="headingLg">
                  {summary.totalProducts}
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Total Stock Units
                </Text>
                <Text as="p" variant="headingLg">
                  {summary.totalStock.toLocaleString()}
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Units Sold
                </Text>
                <Text as="p" variant="headingLg">
                  {summary.totalSales.toLocaleString()}
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Sales Revenue
                </Text>
                <Text as="p" variant="headingLg">
                  ${summary.totalSalesValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </div>
            </InlineStack>
          </BlockStack>
        </Card>
        
        {/* Low Stock Alerts */}
        {summary.lowStockItems.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" align="start">
                <Icon source={AlertTriangleIcon} tone="warning" />
                <Text as="h2" variant="headingMd">
                  Replenishment Alerts ({summary.lowStockItems.length})
                </Text>
              </InlineStack>
              
                             <Banner 
                 tone={summary.lowStockItems.some(item => {
                   if (!item) return false;
                   const daysOfStock = item.salesVelocity > 0 ? item.currentStock / item.salesVelocity : Infinity;
                   return daysOfStock < 7;
                 }) ? "critical" : "warning"}
                 title="Items need replenishment"
               >
                These products are running low and may need restocking soon.
              </Banner>
              
                             <List type="bullet">
                 {summary.lowStockItems.slice(0, 10).map((item) => {
                   if (!item) return null;
                   
                   const daysOfStock = item.salesVelocity > 0 ? item.currentStock / item.salesVelocity : Infinity;
                   const isUrgent = daysOfStock < 7;
                   
                   return (
                     <List.Item key={item.id}>
                       <InlineStack gap="300" align="space-between">
                         <BlockStack gap="100">
                           <InlineStack gap="200">
                             <Text as="span" variant="bodyMd" fontWeight="semibold">
                               {item.title}
                             </Text>
                             {isUrgent && <Badge tone="critical">Urgent</Badge>}
                             {!isUrgent && <Badge tone="warning">Low</Badge>}
                           </InlineStack>
                           <Text as="span" variant="bodySm" tone="subdued">
                             SKU: {item.sku} | Current Stock: {item.currentStock} | 
                             {daysOfStock === Infinity ? ' No recent sales' : ` ~${Math.ceil(daysOfStock)} days remaining`}
                           </Text>
                         </BlockStack>
                         <div style={{ minWidth: '100px' }}>
                           <ProgressBar 
                             progress={Math.min((daysOfStock / 30) * 100, 100)} 
                             size="small"
                           />
                         </div>
                       </InlineStack>
                     </List.Item>
                   );
                 })}
              </List>
              
              {summary.lowStockItems.length > 10 && (
                <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                  ... and {summary.lowStockItems.length - 10} more items need attention
                </Text>
              )}
            </BlockStack>
          </Card>
        )}
        
        {/* No Alerts */}
        {summary.lowStockItems.length === 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" align="start">
                <Icon source={CheckCircleIcon} tone="success" />
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    All Stock Levels Healthy
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No products require immediate replenishment. All inventory levels are sufficient based on current sales velocity.
                  </Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
        
        {/* Top Selling Products */}
        {summary.topSellingItems.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Top Selling Products (90 Days)
              </Text>
                             <List type="bullet">
                 {summary.topSellingItems.map((item, index) => {
                   if (!item) return null;
                   
                   return (
                     <List.Item key={item.id}>
                       <InlineStack gap="300" align="space-between">
                         <BlockStack gap="100">
                           <InlineStack gap="200">
                             <Badge tone="success">{`#${index + 1}`}</Badge>
                             <Text as="span" variant="bodyMd" fontWeight="semibold">
                               {item.title}
                             </Text>
                           </InlineStack>
                           <Text as="span" variant="bodySm" tone="subdued">
                             SKU: {item.sku} | {item.salesLast90Days} units sold | 
                             ${item.salesValue90Days.toFixed(2)} revenue
                           </Text>
                         </BlockStack>
                         <Text as="span" variant="bodyMd" alignment="end">
                           Stock: {item.currentStock}
                         </Text>
                       </InlineStack>
                     </List.Item>
                   );
                 })}
              </List>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
