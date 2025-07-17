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
  Modal,
  TextField,
  Checkbox,
  Toast,
  Frame,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAppSettings, getStockStatus, calculateSuggestedQuantity } from "../lib/settings.server";

// Types for our data
interface ProductData {
  id: string;
  sku: string;
  title: string;
  vendor: string;
  currentStock: number;
  salesVelocity: number;
  suggestedQuantity: number;
  selected: boolean;
  orderQuantity: number;
  stockStatus: 'low' | 'medium' | 'good';
}

interface PurchaseOrder {
  id: string;
  vendor: string;
  status: 'draft' | 'sent' | 'received' | 'cancelled';
  totalItems: number;
  totalValue: number;
  createdAt: string;
  expectedDelivery?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  
  try {
    // Get app settings
    const settings = await getAppSettings(session.shop);
    
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
    
    // Process products and inventory levels
    const allSkus: string[] = [];
    productsData.data?.products?.edges?.forEach((productEdge: any) => {
      const product = productEdge.node;
      
      product.variants?.edges?.forEach((variantEdge: any) => {
        const variant = variantEdge.node;
        
        if (variant?.sku) {
          const available = variant.inventoryQuantity || 0;
          const price = parseFloat(variant.price || '0');
          
          inventoryMap.set(variant.sku, {
            available,
            price,
            title: product.title || 'Unknown Product',
            vendor: product.vendor || 'Unknown Vendor',
            variantId: variant.id,
            productId: product.id
          });
          
          allSkus.push(variant.sku);
        }
      });
    });
    
    // Fetch sales data for calculating suggested quantities
    if (allSkus.length > 0) {
      try {
        const skuQuery = allSkus.map(sku => `line_items.sku:${sku}`).join(' OR ');
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        
        const ordersResponse = await admin.graphql(`
          query GetSalesForMultipleSkus($first: Int!, $query: String!) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  createdAt
                  lineItems(first: 50) {
                    edges {
                      node {
                        sku
                        quantity
                      }
                    }
                  }
                }
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
        
        if (ordersData && !('errors' in ordersData)) {
          ordersData.data?.orders?.edges?.forEach((edge: any) => {
            const order = edge.node;
            const orderDate = new Date(order.createdAt);
            
            if (orderDate >= threeMonthsAgo) {
              order.lineItems?.edges?.forEach((lineItemEdge: any) => {
                const lineItem = lineItemEdge.node;
                const sku = lineItem.sku;
                
                if (sku && allSkus.includes(sku)) {
                  salesMap.set(sku, (salesMap.get(sku) || 0) + lineItem.quantity);
                }
              });
            }
          });
        }
      } catch (error) {
        console.error('Error fetching sales data:', error);
      }
    }
    
    // Combine data into final format
    const productsForPurchase: ProductData[] = [];
    
    inventoryMap.forEach((inventoryInfo, sku) => {
      const salesLast90Days = salesMap.get(sku) || 0;
      const salesVelocity = salesLast90Days / 90;
      
      // Calculate suggested quantity using configurable settings
      const suggestedQuantity = calculateSuggestedQuantity(inventoryInfo.available, salesVelocity, settings);
      
      // Get stock status using configurable thresholds
      const stockStatus = getStockStatus(inventoryInfo.available, salesVelocity, settings);
      
      productsForPurchase.push({
        id: sku,
        sku: sku || 'N/A',
        title: inventoryInfo.title,
        vendor: inventoryInfo.vendor,
        currentStock: inventoryInfo.available,
        salesVelocity: Math.round(salesVelocity * 100) / 100,
        suggestedQuantity,
        selected: false,
        orderQuantity: suggestedQuantity,
        stockStatus
      });
    });
    
    // Sort by vendor, then by suggested quantity (highest first)
    productsForPurchase.sort((a, b) => {
      if (a.vendor !== b.vendor) {
        return a.vendor.localeCompare(b.vendor);
      }
      return b.suggestedQuantity - a.suggestedQuantity;
    });
    
    // Fetch purchase orders from database
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: {
        shop: session.shop
      },
      include: {
        items: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    return json({
      products: productsForPurchase,
      purchaseOrders: purchaseOrders.map((po: any) => ({
        id: po.id,
        vendor: po.vendor,
        status: po.status as 'draft' | 'sent' | 'received' | 'cancelled',
        totalItems: po.totalItems,
        totalValue: po.totalValue,
        createdAt: po.createdAt.toISOString(),
        expectedDelivery: po.expectedDelivery?.toISOString()
      })),
      settings: {
        stockCoverageDays: settings.stockCoverageDays,
        lowStockThreshold: settings.lowStockThreshold,
        mediumStockThreshold: settings.mediumStockThreshold
      },
      error: null
    });
    
  } catch (error) {
    console.error('Error fetching purchase order data:', error);
    
    return json({
      products: [],
      purchaseOrders: [],
      settings: {
        stockCoverageDays: 30,
        lowStockThreshold: 7,
        mediumStockThreshold: 14
      },
      error: `Failed to load purchase order data: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  
  const formData = await request.formData();
  const action = formData.get('action');
  
  if (action === 'create_purchase_order') {
    const vendor = (formData.get('vendor') || '') as string;
    const productsString = (formData.get('products') || '[]') as string;
    const products = JSON.parse(productsString);
    
    try {
      // Calculate totals
      const totalItems = products.reduce((sum: number, p: any) => sum + p.quantity, 0);
      
      // Create purchase order in database
      const purchaseOrder = await prisma.purchaseOrder.create({
        data: {
          shop: session.shop,
          vendor,
          totalItems,
          totalValue: 0, // Will be calculated when we have product prices
          items: {
            create: products.map((p: any) => ({
              productId: p.sku, // Using SKU as productId for now
              sku: p.sku,
              title: p.title,
              quantity: p.quantity,
              unitPrice: 0, // Will be filled when we have pricing
              totalPrice: 0
            }))
          }
        },
        include: {
          items: true
        }
      });
      
      return json({ 
        success: true, 
        message: `Purchase order created for ${vendor} with ${products.length} items`,
        purchaseOrderId: purchaseOrder.id
      });
    } catch (error) {
      console.error('Error creating purchase order:', error);
      return json({ 
        success: false, 
        error: 'Failed to create purchase order'
      });
    }
  }
  
  return json({ success: false });
};

export default function PurchaseOrdersPage() {
  const { products, purchaseOrders, settings, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  
  const [selectedVendor, setSelectedVendor] = useState('all');
  const [selectedProducts, setSelectedProducts] = useState<ProductData[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  
  // Get unique vendors for the filter dropdown
  const vendors = Array.from(new Set(products.map(item => item?.vendor).filter(Boolean))).sort() as string[];
  const vendorOptions = [
    { label: 'All Vendors', value: 'all' },
    ...vendors.map(vendor => ({ label: vendor, value: vendor }))
  ];
  
  // Filter products based on selected vendor
  const filteredProducts = selectedVendor === 'all' 
    ? products 
    : products.filter(item => item?.vendor === selectedVendor);
  
  // Only show products that have suggested quantities > 0 or are low/medium stock
  const productsNeedingReorder = filteredProducts.filter(item => {
    if (!item) return false;
    return item.suggestedQuantity > 0 || item.stockStatus !== 'good';
  });
  
  const handleProductSelect = (product: ProductData, isSelected: boolean) => {
    if (isSelected) {
      setSelectedProducts(prev => [...prev, { ...product, selected: true }]);
    } else {
      setSelectedProducts(prev => prev.filter(p => p.id !== product.id));
    }
  };
  
  const handleQuantityChange = (productId: string, quantity: number) => {
    setSelectedProducts(prev => 
      prev.map(p => p.id === productId ? { ...p, orderQuantity: quantity } : p)
    );
  };
  
  const handleCreatePurchaseOrder = () => {
    if (selectedProducts.length === 0) {
      setToastMessage('Please select at least one product');
      setShowToast(true);
      return;
    }
    
    const vendor = selectedProducts[0].vendor;
    const allSameVendor = selectedProducts.every(p => p.vendor === vendor);
    
    if (!allSameVendor) {
      setToastMessage('All selected products must be from the same vendor');
      setShowToast(true);
      return;
    }
    
    fetcher.submit(
      { 
        action: 'create_purchase_order',
        vendor,
        products: JSON.stringify(selectedProducts.map(p => ({
          sku: p.sku,
          title: p.title,
          quantity: p.orderQuantity
        })))
      },
      { method: 'post' }
    );
    
    setIsCreateModalOpen(false);
    setSelectedProducts([]);
    setToastMessage('Purchase order created successfully!');
    setShowToast(true);
  };
  
  const getPriorityBadge = (product: ProductData) => {
    switch (product.stockStatus) {
      case 'low':
        return <Badge tone="critical">Urgent</Badge>;
      case 'medium':
        return <Badge tone="warning">Low Stock</Badge>;
      default:
        return <Badge tone="info">Reorder</Badge>;
    }
  };
  
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft':
        return <Badge tone="info">Draft</Badge>;
      case 'sent':
        return <Badge tone="warning">Sent</Badge>;
      case 'received':
        return <Badge tone="success">Received</Badge>;
      case 'cancelled':
        return <Badge tone="critical">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };
  
  const purchaseOrderRows = purchaseOrders.map((po: any) => {
    if (!po) return ['', '', '', '', '', '', ''];
    
    return [
      po.id,
      po.vendor,
      getStatusBadge(po.status),
      po.totalItems.toString(),
      `$${po.totalValue.toFixed(2)}`,
      new Date(po.createdAt).toLocaleDateString(),
      po.expectedDelivery ? new Date(po.expectedDelivery).toLocaleDateString() : 'N/A'
    ];
  });
  
  const purchaseOrderHeaders = [
    'PO Number',
    'Vendor',
    'Status',
    'Total Items',
    'Total Value',
    'Created',
    'Expected Delivery'
  ];
  
  const toast = showToast ? (
    <Toast content={toastMessage} onDismiss={() => setShowToast(false)} />
  ) : null;
  
  return (
    <Frame>
      <Page>
        <TitleBar title="Purchase Orders">
          <Button 
            variant="primary" 
            onClick={() => setIsCreateModalOpen(true)}
            disabled={productsNeedingReorder.length === 0}
          >
            Create Purchase Order
          </Button>
        </TitleBar>
        
        <BlockStack gap="500">
          {error && (
            <Banner tone="critical" title="Error">
              {error}
            </Banner>
          )}
          
          {/* Settings Information */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Current Settings
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Stock coverage target: {settings.stockCoverageDays} days | 
                Low stock threshold: {settings.lowStockThreshold} days | 
                Medium stock threshold: {settings.mediumStockThreshold} days
              </Text>
            </BlockStack>
          </Card>
          
          {/* Existing Purchase Orders */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Recent Purchase Orders
              </Text>
              
              {purchaseOrders.length === 0 ? (
                <EmptyState
                  heading="No purchase orders found"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>You haven't created any purchase orders yet.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    'text',
                    'text',
                    'text',
                    'numeric',
                    'numeric',
                    'text',
                    'text'
                  ]}
                  headings={purchaseOrderHeaders}
                  rows={purchaseOrderRows}
                  sortable={[true, true, false, true, true, true, true]}
                />
              )}
            </BlockStack>
          </Card>
          
          {/* Products Needing Reorder */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400" align="space-between">
                <Text as="h2" variant="headingMd">
                  Products Needing Reorder ({productsNeedingReorder.length})
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
              
              {productsNeedingReorder.length === 0 ? (
                <EmptyState
                  heading="No products need reordering"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>All products have sufficient stock levels based on your configured settings.</p>
                </EmptyState>
              ) : (
                <BlockStack gap="300">
                  {productsNeedingReorder.map((product) => {
                    if (!product) return null;
                    
                    return (
                      <Card key={product.id} padding="400">
                        <InlineStack gap="400" align="space-between">
                          <BlockStack gap="200">
                            <InlineStack gap="200" align="start">
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                {product.title}
                              </Text>
                              {getPriorityBadge(product)}
                            </InlineStack>
                            <Text as="span" variant="bodySm" tone="subdued">
                              SKU: {product.sku} | Vendor: {product.vendor} | 
                              Current Stock: {product.currentStock} | 
                              Suggested: {product.suggestedQuantity}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="200">
                            <Text as="span" variant="bodyMd">
                              Qty: {product.suggestedQuantity}
                            </Text>
                            <Button
                              onClick={() => {
                                setSelectedProducts([{ ...product, selected: true }]);
                                setIsCreateModalOpen(true);
                              }}
                            >
                              Add to PO
                            </Button>
                          </InlineStack>
                        </InlineStack>
                      </Card>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </BlockStack>
        
        {/* Create Purchase Order Modal */}
        <Modal
          open={isCreateModalOpen}
          onClose={() => {
            setIsCreateModalOpen(false);
            setSelectedProducts([]);
          }}
          title="Create Purchase Order"
          primaryAction={{
            content: 'Create Purchase Order',
            onAction: handleCreatePurchaseOrder,
            loading: fetcher.state === 'submitting'
          }}
          secondaryActions={[
            {
              content: 'Cancel',
              onAction: () => {
                setIsCreateModalOpen(false);
                setSelectedProducts([]);
              }
            }
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">
                Select Products for Purchase Order
              </Text>
              
              <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                <BlockStack gap="300">
                  {productsNeedingReorder.map((product) => {
                    if (!product) return null;
                    
                    const isSelected = selectedProducts.some(p => p.id === product.id);
                    const selectedProduct = selectedProducts.find(p => p.id === product.id);
                    
                    return (
                      <Card key={product.id} padding="400">
                        <BlockStack gap="300">
                          <InlineStack gap="300" align="start">
                            <Checkbox
                              label=""
                              checked={isSelected}
                              onChange={(checked) => handleProductSelect(product, checked)}
                            />
                            <BlockStack gap="100">
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                {product.title}
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                SKU: {product.sku} | Vendor: {product.vendor} | Stock: {product.currentStock}
                              </Text>
                            </BlockStack>
                          </InlineStack>
                          
                          {isSelected && (
                            <div style={{ width: '120px' }}>
                              <TextField
                                label="Quantity"
                                type="number"
                                value={selectedProduct?.orderQuantity?.toString() || '0'}
                                onChange={(value) => handleQuantityChange(product.id, parseInt(value) || 0)}
                                min="1"
                                labelHidden
                                autoComplete="off"
                              />
                            </div>
                          )}
                        </BlockStack>
                      </Card>
                    );
                  })}
                </BlockStack>
              </div>
              
              {selectedProducts.length > 0 && (
                <Card padding="400" background="bg-surface-secondary">
                  <BlockStack gap="200">
                    <Text as="h4" variant="headingMd">
                      Purchase Order Summary
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Vendor: {selectedProducts[0]?.vendor}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Total Items: {selectedProducts.reduce((sum, p) => sum + p.orderQuantity, 0)}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Products: {selectedProducts.length}
                    </Text>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
        
        {toast}
      </Page>
    </Frame>
  );
} 