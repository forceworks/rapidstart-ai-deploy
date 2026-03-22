// ──────────────────────────────────────────────────────────────────────────────
// Azure Service Bus — signal processing queue
// ──────────────────────────────────────────────────────────────────────────────

@description('Service Bus namespace name')
param name string

@description('Azure region')
param location string

resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: name
  location: location
  sku: { name: 'Basic', tier: 'Basic' }
  properties: {}
}

resource signalsQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: namespace
  name: 'signals'
  properties: {
    maxDeliveryCount: 5
    lockDuration: 'PT5M'
    defaultMessageTimeToLive: 'P7D'
    deadLetteringOnMessageExpiration: true
    maxSizeInMegabytes: 1024
  }
}

// Auth rule for connection string
resource authRule 'Microsoft.ServiceBus/namespaces/authorizationRules@2022-10-01-preview' = {
  parent: namespace
  name: 'FunctionAppAccess'
  properties: {
    rights: ['Listen', 'Send']
  }
}

output namespaceName string = namespace.name

@description('Connection string for Function App config — marked secure')
output connectionString string = authRule.listKeys().primaryConnectionString
