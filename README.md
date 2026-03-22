# RapidStart AI — Azure Deployment

Azure Functions signal processor and infrastructure templates for **RapidStart AI**, an AI-powered sales intelligence solution for Microsoft Dataverse.

## What's Included

| Component | Description |
|---|---|
| `infra/bicep/` | Bicep templates for Azure Functions, OpenAI, Service Bus, Key Vault |
| `services/signal-processor/` | Node.js/TypeScript Azure Functions app (Signal Processor) |
| `docs/deployment-guide.md` | Step-by-step deployment and configuration guide |

## Prerequisites

- Azure subscription with Contributor access
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- [Node.js 20+](https://nodejs.org/) and npm
- [Azure Functions Core Tools v4](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local)
- A Microsoft Dataverse environment with the **RapidStart AI** solution installed

## Quick Deploy

### 1. Deploy Azure Infrastructure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fforceworks%2Frapidstart-ai-deploy%2Fmain%2Finfra%2Fbicep%2Fmain.json)

Or deploy via CLI:

```bash
az deployment group create \
  --resource-group rg-rapidstart-ai \
  --template-file infra/bicep/main.bicep \
  --parameters environmentName=dev
```

### 2. Deploy the Signal Processor

```bash
cd services/signal-processor
npm install
npm run build

# Deploy to your Function App
func azure functionapp publish <your-function-app-name>
```

### 3. Configure in Dataverse

After deploying, open the **RapidStart AI Settings** page in your Dataverse environment (Settings area) to complete setup:

1. Enter the Signal Processor endpoint URL
2. Set your license tier and token cap
3. Configure the monitoring user for Graph signals

See [`docs/deployment-guide.md`](docs/deployment-guide.md) for detailed instructions.

## Architecture

```
Microsoft Graph ──webhook──> Signal Router ──queue──> Signal Processor
                                                          │
                                          ┌───────────────┼───────────────┐
                                          │               │               │
                                    Entity Matcher   AI Summarizer   Confidence Scorer
                                          │               │               │
                                          └───────────────┼───────────────┘
                                                          │
                                                    Dataverse CRM
                                                    (via Custom APIs)
```

The Signal Processor is an Azure Functions app that:
- **Ingests signals** from Microsoft Graph (calendar events, emails)
- **Matches entities** to Accounts, Contacts, and Opportunities in Dataverse
- **Summarizes meetings** using Azure OpenAI (GPT-4o)
- **Scores engagement** and detects at-risk opportunities
- **Generates suggestions** for follow-ups and next steps
- **Runs AI agents** for account intelligence, opportunity coaching, and sales execution

## Bicep Resources

The `main.bicep` template deploys:

| Resource | Description |
|---|---|
| Azure Functions (Linux Consumption) | Signal Processor runtime |
| Azure OpenAI | GPT-4o deployment for AI features |
| Service Bus (Basic) | Signal queue for async processing |
| Key Vault | Secure storage for secrets |

## Configuration

After deployment, configure these Function App settings (see [deployment guide](docs/deployment-guide.md) for details):

| Setting | Description |
|---|---|
| `DATAVERSE_URL` | Your Dataverse environment URL |
| `TENANT_ID` | Azure AD tenant ID |
| `CLIENT_ID` | App Registration client ID |
| `CLIENT_SECRET` | App Registration client secret |
| `OPENAI_ENDPOINT` | Azure OpenAI endpoint |
| `OPENAI_API_KEY` | Azure OpenAI key |
| `SIGNAL_QUEUE_CONNECTION` | Service Bus connection string |

## License

Copyright (c) ForceWorks. All rights reserved.
