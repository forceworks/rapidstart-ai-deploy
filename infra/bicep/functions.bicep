// ──────────────────────────────────────────────────────────────────────────────
// Azure Functions — Linux Consumption plan for signal processing
// ──────────────────────────────────────────────────────────────────────────────

@description('Function App name')
param name string

@description('Azure region')
param location string

@description('Environment (dev/staging/prod)')
param environment string

@description('Dataverse environment URL')
param dataverseUrl string

@description('Service Bus connection string')
@secure()
param serviceBusConnectionString string

@description('Key Vault URI')
param keyVaultUri string

@description('Azure OpenAI endpoint')
param openaiEndpoint string

@description('Azure OpenAI deployment name')
param openaiDeployment string

@description('Azure AD client ID')
param aadClientId string

// ── Storage account (required by Functions) ──────────────────────────────────
var storageName = replace(take('st${replace(name, '-', '')}', 24), '-', '')

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
}

// ── App Insights ─────────────────────────────────────────────────────────────
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'ai-${name}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    RetentionInDays: 90
  }
}

// ── Linux Consumption Plan ───────────────────────────────────────────────────
resource hostingPlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: 'plan-${name}'
  location: location
  kind: 'linux'
  sku: { name: 'Y1', tier: 'Dynamic' }
  properties: { reserved: true }
}

// ── Function App ─────────────────────────────────────────────────────────────
resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: name
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        // RapidStart AI configuration
        { name: 'DATAVERSE_URL', value: dataverseUrl }
        { name: 'DATAVERSE_TOOL_BASE_URL', value: '${dataverseUrl}/api/data/v9.2/' }
        { name: 'CREDENTIAL_SOURCE', value: 'managed-identity' }
        { name: 'AZURE_CLIENT_ID', value: aadClientId }
        { name: 'SERVICEBUS_CONNECTION', value: serviceBusConnectionString }
        { name: 'SERVICEBUS_QUEUE_NAME', value: 'signals' }
        { name: 'OPENAI_ENDPOINT', value: openaiEndpoint }
        { name: 'OPENAI_DEPLOYMENT', value: openaiDeployment }
        { name: 'OPENAI_KEY_SOURCE', value: 'managed-identity' }
        { name: 'KEY_VAULT_URI', value: keyVaultUri }
        { name: 'LICENSE_TIER', value: environment == 'prod' ? 'pro' : 'starter' }
        { name: 'ENVIRONMENT', value: environment }
      ]
    }
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output principalId string = functionApp.identity.principalId
