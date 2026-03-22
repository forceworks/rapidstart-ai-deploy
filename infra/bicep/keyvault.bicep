// ──────────────────────────────────────────────────────────────────────────────
// Azure Key Vault — secrets for Graph webhook validation, API keys
// ──────────────────────────────────────────────────────────────────────────────

@description('Key Vault name')
param name string

@description('Azure region')
param location string

@description('Azure AD tenant ID')
param tenantId string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enabledForTemplateDeployment: true
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
