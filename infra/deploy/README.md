# RapidStart AI — Deploy to Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fforceworks%2Frapidstart-ai-deploy%2Fmain%2Finfra%2Fdeploy%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fforceworks%2Frapidstart-ai-deploy%2Fmain%2Finfra%2Fdeploy%2FcreateUiDefinition.json)

One-click deployment of the RapidStart AI Azure backend for Dynamics 365 / Dataverse.

## Prerequisites

- An active Azure subscription
- A Dataverse / Dynamics 365 environment with the **RapidStart CRM** managed solution installed
- The **RapidStart AI** managed solution imported into Dataverse (provides the AI Settings entity, Custom APIs, and PCF controls)
- Permissions to create resources in the target Azure subscription (Contributor role or higher)

## What Gets Deployed

| Resource | Type | Purpose |
|----------|------|---------|
| **Function App** | Consumption plan (Linux, Node 20) | Signal processor — ingests, enriches, and routes CRM signals |
| **Azure OpenAI** | S0 account + GPT-4o deployment | AI summarization, entity extraction, and confidence scoring |
| **Service Bus** | Basic tier namespace + `signals` queue | Durable message queue for asynchronous signal processing |
| **Key Vault** | Standard tier | Secure storage for API keys and connection secrets |
| **Application Insights** | Web component | Monitoring, logging, and diagnostics for the Function App |

A Storage Account and App Service Plan (Dynamic/Y1) are created automatically as part of the Function App.

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `environment` | Yes | `dev` | Environment name — `dev`, `staging`, or `prod`. Affects resource naming and license tier. |
| `location` | Yes | Resource group location | Azure region for all resources. |
| `dataverseUrl` | Yes | — | Your Dataverse environment URL (e.g., `https://yourorg.crm.dynamics.com`). |
| `tenantId` | Yes | Current tenant | Azure AD tenant ID. Pre-filled automatically. |
| `aadClientId` | No | *(empty)* | Azure AD App Registration client ID. Leave blank to use system-assigned managed identity. |

## Post-Deployment Steps

1. **Grant Dataverse access** — In the Power Platform Admin Center, add the Function App's managed identity as an Application User with the **System Administrator** or a custom security role that covers the RapidStart AI tables.
2. **Open AI Settings** — In your Dynamics 365 app, navigate to **Settings > RapidStart AI > AI Settings**.
3. **Enter the Function App URL** — Paste the Function App URL from the deployment outputs into the Azure Function URL field.
4. **Configure OpenAI** — The endpoint and deployment name are auto-configured. Verify they appear in AI Settings.
5. **Set usage governance limits** — Configure monthly token budgets and per-call limits on the AI Settings page.
6. **Enable signal ingestion** — Toggle the signal processing switch to begin processing CRM signals.
7. **Test the connection** — Use the "Test Connection" button on the AI Settings page to verify end-to-end connectivity.

## Cost Estimate

All resources use consumption-based or low-tier SKUs:

- **Function App** — Consumption plan (Y1): free grant of 1M executions/month; pay only for usage beyond that.
- **Azure OpenAI** — Pay-per-token; GPT-4o at standard rates. Governed by usage limits set in AI Settings.
- **Service Bus** — Basic tier: low fixed cost, metered per operation.
- **Key Vault** — Standard tier: metered per operation (fractions of a cent).
- **Application Insights** — Free up to 5 GB/month ingestion.

At low-to-moderate signal volume (< 10,000 signals/month), expect costs well under $25/month excluding OpenAI token usage.

## Manual Deployment

If you prefer deploying via the Azure CLI instead of the portal button:

```bash
az group create --name rg-rapidstart-ai --location eastus

az deployment group create \
  --resource-group rg-rapidstart-ai \
  --template-file azuredeploy.json \
  --parameters environment=prod dataverseUrl=https://yourorg.crm.dynamics.com
```

## Support

For issues or questions, contact [ForceWorks](https://www.yourforceworks.com) or open an issue in the repository.
