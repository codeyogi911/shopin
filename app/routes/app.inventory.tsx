import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  DataTable,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  EmptyState,
  Banner,
  Select,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
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
    
    // Sort by sales velocity (highest first)
    combinedData.sort((a, b) => b.salesVelocity - a.salesVelocity);
    
    return json({
      inventory: combinedData,
      summary: {
        totalProducts: combinedData.length,
        totalStock: combinedData.reduce((sum, item) => sum + item.currentStock, 0),
        totalSales: combinedData.reduce((sum, item) => sum + item.salesLast90Days, 0),
        totalSalesValue: combinedData.reduce((sum, item) => sum + item.salesValue90Days, 0)
      },
      error: null
    });
    
  } catch (error) {
    console.error('Error fetching inventory data:', error);
    
    // Log more detailed error information
    if (error && typeof error === 'object' && 'graphQLErrors' in error) {
      console.error('GraphQL Errors:', error.graphQLErrors);
    }
    
    return json({
      inventory: [],
      summary: { totalProducts: 0, totalStock: 0, totalSales: 0, totalSalesValue: 0 },
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
    // Trigger a refresh by redirecting back to the same page
    return json({ success: true });
  }
  
  return json({ success: false });
};

export default function InventoryPage() {
  const { inventory, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState('all');
  
  const handleRefresh = () => {
    setIsRefreshing(true);
    fetcher.submit({ action: 'refresh' }, { method: 'post' });
    // Reload the page to get fresh data
    window.location.reload();
  };
  
  const getStockStatusBadge = (stock: number, velocity: number) => {
    const daysOfStock = velocity > 0 ? stock / velocity : Infinity;
    
    if (daysOfStock < 7) {
      return <Badge tone="critical">Low Stock</Badge>;
    } else if (daysOfStock < 14) {
      return <Badge tone="warning">Medium Stock</Badge>;
    } else {
      return <Badge tone="success">Good Stock</Badge>;
    }
  };
  
  // Get unique vendors for the filter dropdown
  const vendors = Array.from(new Set(inventory.map(item => item?.vendor || 'Unknown').filter(Boolean))).sort();
  const vendorOptions = [
    { label: 'All Vendors', value: 'all' },
    ...vendors.map(vendor => ({ label: vendor, value: vendor }))
  ];
  
  // Filter inventory based on selected vendor
  const filteredInventory = selectedVendor === 'all' 
    ? inventory 
    : inventory.filter(item => item?.vendor === selectedVendor);
  
  const tableRows = filteredInventory.map((item) => [
    item?.sku || '',
    item?.title || '',
    item?.vendor || '',
    item?.currentStock?.toString() || '0',
    item?.salesLast90Days?.toString() || '0',
    `$${(item?.salesValue90Days || 0).toFixed(2)}`,
    item?.salesVelocity?.toString() || '0',
    getStockStatusBadge(item?.currentStock || 0, item?.salesVelocity || 0),
    new Date(item?.lastStockCheck || new Date()).toLocaleDateString()
  ]);
  
  const tableHeaders = [
    'SKU',
    'Product Title',
    'Vendor',
    'Current Stock',
    'Sales Qty (90 Days)',
    'Sales Value (90 Days)',
    'Daily Velocity',
    'Status',
    'Last Updated'
  ];
  
  // Update summary for filtered data
  const filteredSummary = {
    totalProducts: filteredInventory.length,
    totalStock: filteredInventory.reduce((sum, item) => sum + (item?.currentStock || 0), 0),
    totalSales: filteredInventory.reduce((sum, item) => sum + (item?.salesLast90Days || 0), 0),
    totalSalesValue: filteredInventory.reduce((sum, item) => sum + (item?.salesValue90Days || 0), 0)
  };
  
  return (
    <Page>
      <TitleBar title="Inventory List">
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
        
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="400" align="space-between">
              <Text as="h2" variant="headingMd">
                Inventory Summary
              </Text>
              <div style={{ minWidth: '200px' }}>
                <Select
                  label="Filter by Vendor"
                  options={vendorOptions}
                  value={selectedVendor}
                  onChange={setSelectedVendor}
                />
              </div>
            </InlineStack>
            <InlineStack gap="600" align="space-evenly">
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Total Products
                </Text>
                <Text as="p" variant="headingLg">
                  {filteredSummary.totalProducts}
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Total Stock Units
                </Text>
                <Text as="p" variant="headingLg">
                  {filteredSummary.totalStock}
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Sales Qty (90 Days)
                </Text>
                <Text as="p" variant="headingLg">
                  {filteredSummary.totalSales}
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Sales Value (90 Days)
                </Text>
                <Text as="p" variant="headingLg">
                  ${filteredSummary.totalSalesValue.toFixed(2)}
                </Text>
              </div>
            </InlineStack>
          </BlockStack>
        </Card>
        
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Product Inventory & Sales
              {selectedVendor !== 'all' && (
                <Text as="span" variant="bodyMd" tone="subdued">
                  {' '}— Filtered by {selectedVendor}
                </Text>
              )}
            </Text>
            
            {filteredInventory.length === 0 ? (
              <EmptyState
                heading={selectedVendor === 'all' ? "No inventory data found" : `No products found for vendor: ${selectedVendor}`}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  {selectedVendor === 'all' 
                    ? "No products with inventory tracking were found. Make sure you have products with variants and inventory tracking enabled."
                    : `No products found for the selected vendor "${selectedVendor}". Try selecting a different vendor or "All Vendors".`
                  }
                </p>
              </EmptyState>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <DataTable
                  columnContentTypes={[
                    'text',
                    'text',
                    'text',
                    'numeric',
                    'numeric',
                    'numeric',
                    'numeric',
                    'text',
                    'text'
                  ]}
                  headings={tableHeaders}
                  rows={tableRows}
                  sortable={[false, true, true, true, true, true, true, false, true]}
                />
              </div>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
} 