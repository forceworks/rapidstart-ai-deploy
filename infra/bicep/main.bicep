// ──────────────────────────────────────────────────────────────────────────────
// RapidStart AI — Main Bicep template
// Deploys: Function App, Service Bus, Key Vault, OpenAI, App Insights
// ──────────────────────────────────────────────────────────────────────────────

targetScope = 'resourceGroup'

@description('Environment name (dev, staging, prod)')
@allowed(['dev', 'staging', 'prod'])
param environment string = 'dev'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Unique suffix for globally unique names')
param uniqueSuffix string = uniqueString(resourceGroup().id)

@description('Dataverse environment URL')
param dataverseUrl string

@description('Azure AD tenant ID')
param tenantId string = subscription().tenantId

@description('Azure AD client ID for managed identity')
param aadClientId string = ''

// ── Naming ───────────────────────────────────────────────────────────────────
var prefix = 'rsai'
var envSuffix = '${prefix}-${environment}-${uniqueSuffix}'

// ── Modules ──────────────────────────────────────────────────────────────────

module keyVault 'keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: 'kv-${envSuffix}'
    location: location
    tenantId: tenantId
  }
}

module serviceBus 'servicebus.bicep' = {
  name: 'servicebus'
  params: {
    name: 'sb-${envSuffix}'
    location: location
  }
}

module openai 'openai.bicep' = {
  name: 'openai'
  params: {
    name: 'oai-${envSuffix}'
    location: location
  }
}

module functions 'functions.bicep' = {
  name: 'functions'
  params: {
    name: 'func-${envSuffix}'
    location: location
    environment: environment
    dataverseUrl: dataverseUrl
    serviceBusConnectionString: serviceBus.outputs.connectionString
    keyVaultUri: keyVault.outputs.vaultUri
    openaiEndpoint: openai.outputs.endpoint
    openaiDeployment: openai.outputs.deploymentName
    aadClientId: aadClientId
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────

output functionAppName string = functions.outputs.functionAppName
output functionAppUrl string = functions.outputs.functionAppUrl
output serviceBusNamespace string = serviceBus.outputs.namespaceName
output keyVaultName string = keyVault.outputs.vaultName
output openaiEndpoint string = openai.outputs.endpoint
