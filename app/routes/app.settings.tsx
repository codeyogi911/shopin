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
  Banner,
  TextField,
  Checkbox,
  Toast,
  Frame,
  FormLayout,
  Divider,
  Badge,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Types for our data
interface AppSettings {
  stockCoverageDays: number;
  lowStockThreshold: number;
  mediumStockThreshold: number;
  reorderPoint: number;
  emailNotifications: boolean;
}

interface AppInfo {
  version: string;
  buildDate: string;
  features: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  
  try {
    // Get or create app settings for this shop
    let settings = await db.appSettings.findUnique({
      where: { shop: session.shop }
    });
    
    // If no settings exist, create default ones
    if (!settings) {
      settings = await db.appSettings.create({
        data: {
          shop: session.shop,
          stockCoverageDays: 30,
          lowStockThreshold: 7,
          mediumStockThreshold: 14,
          reorderPoint: 0.1,
          emailNotifications: true
        }
      });
    }
    
    // App information
    const appInfo: AppInfo = {
      version: "1.0.0",
      buildDate: new Date().toISOString().split('T')[0],
      features: [
        "Inventory Management",
        "Sales Analytics",
        "Purchase Orders",
        "Stock Alerts",
        "Vendor Management",
        "Real-time Dashboard"
      ]
    };
    
    return json({
      settings: {
        stockCoverageDays: settings.stockCoverageDays,
        lowStockThreshold: settings.lowStockThreshold,
        mediumStockThreshold: settings.mediumStockThreshold,
        reorderPoint: settings.reorderPoint,
        emailNotifications: settings.emailNotifications
      },
      appInfo,
      error: null
    });
    
  } catch (error) {
    console.error('Error loading settings:', error);
    
    return json({
      settings: {
        stockCoverageDays: 30,
        lowStockThreshold: 7,
        mediumStockThreshold: 14,
        reorderPoint: 0.1,
        emailNotifications: true
      },
      appInfo: {
        version: "1.0.0",
        buildDate: new Date().toISOString().split('T')[0],
        features: []
      },
      error: `Failed to load settings: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  
  const formData = await request.formData();
  const action = formData.get('action');
  
  if (action === 'update_settings') {
    try {
      const stockCoverageDays = parseInt((formData.get('stockCoverageDays') || '30') as string);
      const lowStockThreshold = parseInt((formData.get('lowStockThreshold') || '7') as string);
      const mediumStockThreshold = parseInt((formData.get('mediumStockThreshold') || '14') as string);
      const reorderPoint = parseFloat((formData.get('reorderPoint') || '0.1') as string);
      const emailNotifications = formData.get('emailNotifications') === 'true';
      
      // Validate inputs
      if (stockCoverageDays < 1 || stockCoverageDays > 365) {
        return json({ 
          success: false, 
          error: 'Stock coverage days must be between 1 and 365' 
        });
      }
      
      if (lowStockThreshold >= mediumStockThreshold) {
        return json({ 
          success: false, 
          error: 'Low stock threshold must be less than medium stock threshold' 
        });
      }
      
      // Update settings in database
      await db.appSettings.upsert({
        where: { shop: session.shop },
        update: {
          stockCoverageDays,
          lowStockThreshold,
          mediumStockThreshold,
          reorderPoint,
          emailNotifications
        },
        create: {
          shop: session.shop,
          stockCoverageDays,
          lowStockThreshold,
          mediumStockThreshold,
          reorderPoint,
          emailNotifications
        }
      });
      
      return json({ 
        success: true, 
        message: 'Settings updated successfully!' 
      });
      
    } catch (error) {
      console.error('Error updating settings:', error);
      return json({ 
        success: false, 
        error: 'Failed to update settings' 
      });
    }
  }
  
  return json({ success: false });
};

export default function SettingsPage() {
  const { settings, appInfo, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  
  const [formData, setFormData] = useState<AppSettings>({
    stockCoverageDays: settings.stockCoverageDays,
    lowStockThreshold: settings.lowStockThreshold,
    mediumStockThreshold: settings.mediumStockThreshold,
    reorderPoint: settings.reorderPoint,
    emailNotifications: settings.emailNotifications
  });
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastError, setToastError] = useState(false);
  
  const handleInputChange = (field: keyof AppSettings, value: string | number | boolean) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };
  
  const handleSubmit = () => {
    if (fetcher.state === 'submitting') return;
    
    fetcher.submit(
      { 
        action: 'update_settings',
        stockCoverageDays: formData.stockCoverageDays.toString(),
        lowStockThreshold: formData.lowStockThreshold.toString(),
        mediumStockThreshold: formData.mediumStockThreshold.toString(),
        reorderPoint: formData.reorderPoint.toString(),
        emailNotifications: formData.emailNotifications.toString()
      },
      { method: 'post' }
    );
  };
  
  // Handle form submission response
  if (fetcher.data && fetcher.state === 'idle') {
    const data = fetcher.data as any;
    if (data.success && !showToast) {
      setToastMessage(data.message || 'Settings updated successfully!');
      setToastError(false);
      setShowToast(true);
    } else if (!data.success && !showToast) {
      setToastMessage(data.error || 'Failed to update settings');
      setToastError(true);
      setShowToast(true);
    }
  }
  
  const toast = showToast ? (
    <Toast 
      content={toastMessage} 
      onDismiss={() => setShowToast(false)}
      error={toastError}
    />
  ) : null;
  
  return (
    <Frame>
      <Page>
        <TitleBar title="Settings" />
        
        <BlockStack gap="500">
          {error && (
            <Banner tone="critical" title="Error">
              {error}
            </Banner>
          )}
          
          {/* App Information */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                App Information
              </Text>
              
              <InlineStack gap="600" align="space-between">
                <BlockStack gap="300">
                  <Box>
                    <Text as="p" variant="bodyMd">
                      <strong>Version:</strong> {appInfo.version}
                    </Text>
                  </Box>
                  <Box>
                    <Text as="p" variant="bodyMd">
                      <strong>Build Date:</strong> {appInfo.buildDate}
                    </Text>
                  </Box>
                  <Box>
                    <Text as="p" variant="bodyMd">
                      <strong>Status:</strong> <Badge tone="success">Active</Badge>
                    </Text>
                  </Box>
                </BlockStack>
                
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Features
                  </Text>
                  <BlockStack gap="100">
                    {appInfo.features.map((feature, index) => (
                      <InlineStack key={index} gap="200">
                        <Badge tone="info">{feature}</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
          
          <Divider />
          
          {/* Inventory Settings */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Inventory Settings
              </Text>
              
              <Text as="p" variant="bodyMd" tone="subdued">
                Configure how the app calculates stock levels and reorder suggestions.
              </Text>
              
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Stock Coverage Days"
                    type="number"
                    value={formData.stockCoverageDays.toString()}
                    onChange={(value) => handleInputChange('stockCoverageDays', parseInt(value) || 30)}
                    helpText="Number of days of inventory to maintain (used for reorder calculations)"
                    min="1"
                    max="365"
                    autoComplete="off"
                  />
                  
                  <TextField
                    label="Low Stock Threshold (Days)"
                    type="number"
                    value={formData.lowStockThreshold.toString()}
                    onChange={(value) => handleInputChange('lowStockThreshold', parseInt(value) || 7)}
                    helpText="Products with less than this many days of stock will be marked as 'Low Stock'"
                    min="1"
                    max="30"
                    autoComplete="off"
                  />
                </FormLayout.Group>
                
                <FormLayout.Group>
                  <TextField
                    label="Medium Stock Threshold (Days)"
                    type="number"
                    value={formData.mediumStockThreshold.toString()}
                    onChange={(value) => handleInputChange('mediumStockThreshold', parseInt(value) || 14)}
                    helpText="Products with less than this many days of stock will be marked as 'Medium Stock'"
                    min="1"
                    max="60"
                    autoComplete="off"
                  />
                  
                  <TextField
                    label="Reorder Point Multiplier"
                    type="number"
                    value={formData.reorderPoint.toString()}
                    onChange={(value) => handleInputChange('reorderPoint', parseFloat(value) || 0.1)}
                    helpText="Safety factor for reorder calculations (0.1 = 10% buffer)"
                    min="0"
                    max="1"
                    step="0.1"
                    autoComplete="off"
                  />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>
          </Card>
          
          {/* Notification Settings */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Notification Settings
              </Text>
              
              <Checkbox
                label="Email Notifications"
                checked={formData.emailNotifications}
                onChange={(checked) => handleInputChange('emailNotifications', checked)}
                helpText="Receive email alerts for low stock and other important events"
              />
            </BlockStack>
          </Card>
          
          {/* Settings Summary */}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Current Configuration Summary
              </Text>
              
              <Box background="bg-surface-secondary" padding="400" borderRadius="200">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    • Products will be suggested for reorder when stock falls below <strong>{formData.stockCoverageDays}</strong> days of coverage
                  </Text>
                  <Text as="p" variant="bodyMd">
                    • Items with less than <strong>{formData.lowStockThreshold}</strong> days of stock will be marked as <Badge tone="critical">Low Stock</Badge>
                  </Text>
                  <Text as="p" variant="bodyMd">
                    • Items with less than <strong>{formData.mediumStockThreshold}</strong> days of stock will be marked as <Badge tone="warning">Medium Stock</Badge>
                  </Text>
                  <Text as="p" variant="bodyMd">
                    • Reorder quantities include a <strong>{(formData.reorderPoint * 100).toFixed(0)}%</strong> safety buffer
                  </Text>
                  <Text as="p" variant="bodyMd">
                    • Email notifications are <strong>{formData.emailNotifications ? 'enabled' : 'disabled'}</strong>
                  </Text>
                </BlockStack>
              </Box>
            </BlockStack>
          </Card>
          
          {/* Save Button */}
          <InlineStack gap="300">
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={fetcher.state === 'submitting'}
            >
              Save Settings
            </Button>
            
            <Button
              onClick={() => setFormData({
                stockCoverageDays: settings.stockCoverageDays,
                lowStockThreshold: settings.lowStockThreshold,
                mediumStockThreshold: settings.mediumStockThreshold,
                reorderPoint: settings.reorderPoint,
                emailNotifications: settings.emailNotifications
              })}
              disabled={fetcher.state === 'submitting'}
            >
              Reset to Default
            </Button>
          </InlineStack>
        </BlockStack>
        
        {toast}
      </Page>
    </Frame>
  );
} 