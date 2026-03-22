// ──────────────────────────────────────────────────────────────────────────────
// Azure OpenAI — GPT-4o deployment for AI summarization and agents
// ──────────────────────────────────────────────────────────────────────────────

@description('Azure OpenAI account name')
param name string

@description('Azure region')
param location string

resource openai 'Microsoft.CognitiveServices/accounts@2023-10-01-preview' = {
  name: name
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: name
    publicNetworkAccess: 'Enabled'
  }
}

resource gpt4oDeployment 'Microsoft.CognitiveServices/accounts/deployments@2023-10-01-preview' = {
  parent: openai
  name: 'gpt-4o'
  sku: {
    name: 'Standard'
    capacity: 30 // 30K TPM
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4o'
      version: '2024-08-06'
    }
  }
}

output endpoint string = openai.properties.endpoint
output deploymentName string = gpt4oDeployment.name
output openaiId string = openai.id
