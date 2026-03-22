# RapidStart AI — Deployment Guide

Step-by-step instructions for configuring Dataverse, Azure AD, Microsoft Graph, and web resources to make the deployed Azure Functions operational.

**Prerequisites:**
- Azure Functions deployed to `func-rapidstart-ai-dev` (already done)
- Access to [make.powerapps.com](https://make.powerapps.com) as a system admin
- Access to [portal.azure.com](https://portal.azure.com) with contributor role
- Power Platform CLI (`pac`) installed
- .NET 8 SDK installed

---

## Step 1: Verify Azure Function App Settings

The Function App `func-rapidstart-ai-dev` should already have these environment variables configured. Verify each has a real value (not a placeholder):

| Setting | Example Value |
|---|---|
| `DATAVERSE_URL` | `https://yourorg.crm.dynamics.com` |
| `TENANT_ID` | `61f88e6b-...` |
| `CREDENTIAL_SOURCE` | `client-credentials` |
| `CLIENT_ID` | Azure AD App Registration client ID |
| `CLIENT_SECRET` | Azure AD App Registration secret |
| `OPENAI_ENDPOINT` | `https://oai-rapidstart-ai-dev.openai.azure.com` |
| `OPENAI_API_KEY` | Azure OpenAI key |
| `OPENAI_DEPLOYMENT` | `gpt-4o` |
| `OPENAI_KEY_SOURCE` | `environment` |
| `SIGNAL_QUEUE_CONNECTION` | Service Bus connection string |
| `SIGNAL_QUEUE_NAME` | `signals` |
| `RAPIDSSTART_TOOL_BASE_URL` | `https://yourorg.crm.dynamics.com/api/data/v9.2/` |
| `LICENSE_TIER` | `starter`, `pro`, or `private` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights connection string |

**To check/update:**

```bash
# View all settings
az functionapp config appsettings list \
  --name func-rapidstart-ai-dev \
  --resource-group rg-rapidstart-ai-dev \
  -o table

# Update a setting
az functionapp config appsettings set \
  --name func-rapidstart-ai-dev \
  --resource-group rg-rapidstart-ai-dev \
  --settings "SETTING_NAME=value"
```

---

## Step 2: Azure AD App Registration

If you haven't already created an App Registration for the signal processor:

1. Go to **Azure Portal → Azure Active Directory → App registrations → New registration**
2. Name: `RapidStart AI Signal Processor`
3. Supported account types: **Single tenant**
4. Click **Register**
5. Note the **Application (client) ID** — this is your `CLIENT_ID`
6. Go to **Certificates & secrets → New client secret**
   - Description: `signal-processor`
   - Expiry: 24 months
   - Copy the **Value** — this is your `CLIENT_SECRET`
7. Go to **API permissions → Add a permission**
   - **Dynamics CRM → Delegated → user_impersonation** (or Application → use `Access Common Data Service as organization`)
   - Click **Grant admin consent**

**Update the Function App:**

```bash
az functionapp config appsettings set \
  --name func-rapidstart-ai-dev \
  --resource-group rg-rapidstart-ai-dev \
  --settings "CLIENT_ID=<your-client-id>" "CLIENT_SECRET=<your-client-secret>"
```

---

## Step 3: Dataverse Application User

Create an Application User so the signal processor can authenticate to Dataverse.

1. Go to **[admin.powerplatform.microsoft.com](https://admin.powerplatform.microsoft.com)**
2. Select your environment → **Settings → Users + permissions → Application users**
3. Click **+ New app user**
4. Select the App Registration from Step 2
5. Select your **Business Unit** (root)
6. Assign **Security Role:** `System Administrator` (or a custom role with create/update on all AI tables)
7. Click **Create**

---

## Step 4: Create Dataverse Tables

In [make.powerapps.com](https://make.powerapps.com), open **Solutions → RapidStart AI** and create each table below.

### 4a. Signal Log (`fw_signallog`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Signal ID | fw_signalid | Text |
| Graph Resource ID | fw_graphresourceid | Text |
| Signal Type | fw_signaltype | Text |
| Status | fw_status | Text |
| Confidence | fw_confidence | Decimal |
| Account | fw_accountid | Text |
| Processing Duration | fw_processingdurationms | Integer |
| Error Message | fw_errormessage | Multiline Text |
| User Email | fw_useremail | Text |
| Signal Payload | fw_signalpayload | Multiline Text |

### 4b. Review Queue (`fw_reviewqueue`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Signal ID | fw_signalid | Text |
| Graph Resource ID | fw_graphresourceid | Text |
| Signal Payload | fw_signalpayload | Multiline Text |
| Entity Matches | fw_entitymatches | Multiline Text |
| Review Reason | fw_reviewreason | Text |
| Status | fw_status | Choice (1=pending, 2=approved, 3=dismissed) |
| Suggested Actions | fw_suggestedactions | Multiline Text |

### 4c. Usage Counter (`fw_usagecounter`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Tenant ID | fw_tenantid | Text |
| User ID | fw_userid | Text |
| Period | fw_period | Text |
| Count | fw_count | Integer |

### 4d. AI Audit (`fw_aiaudit`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Action | fw_action | Text |
| Entity Type | fw_entitytype | Text |
| Entity ID | fw_entityid | Text |
| Source | fw_source | Text |
| Confidence | fw_confidence | Decimal |
| Details | fw_details | Multiline Text |

### 4e. Stakeholder Occurrence (`fw_stakeholderoccurrences`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Email | fw_email | Text |
| Display Name | fw_displayname | Text |
| Domain | fw_domain | Text |
| Account | fw_accountid | Lookup (Account) |
| Account Name | fw_accountname | Text |
| Occurrence Count | fw_occurrencecount | Integer |

### 4f. Stakeholder Alert (`fw_stakeholderalerts`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Account | fw_accountid | Lookup (Account) |
| Alert Type | fw_alerttype | Choice (1=recurring-unknown, 2=org-change-signal) |
| Stakeholder Emails | fw_stakeholderemails | Multiline Text |
| Stakeholder Count | fw_stakeholdercount | Integer |
| Max Occurrences | fw_maxoccurrences | Integer |
| Message | fw_message | Multiline Text |
| Status | fw_status | Choice (1=open, 2=acknowledged, 3=dismissed) |

### 4g. AI Suggestion (`fw_aisuggestion`)

| Column | Schema Name | Type |
|---|---|---|
| Name | fw_name | Text (primary) |
| Opportunity | fw_opportunityid | Lookup (Opportunity) |
| Suggestion Type | fw_suggestiontype | Choice (1=follow-up-email, 2=schedule-meeting, 3=add-contact, 4=create-task, 5=update-stage, 6=escalate) |
| Title | fw_title | Text |
| Description | fw_description | Multiline Text |
| Suggested Content | fw_suggestedcontent | Multiline Text |
| Trigger Signal | fw_triggersignal | Text |
| Action Data | fw_actiondata | Multiline Text |
| Priority | fw_priority | Choice (1=high, 2=medium, 3=low) |
| Status | fw_status | Choice (1=pending, 2=accepted, 3=dismissed) |

---

## Step 5: Add Custom Fields to Opportunity

In **Solutions → RapidStart AI**, add these columns to the **Opportunity** table:

| Column | Schema Name | Type | Notes |
|---|---|---|---|
| AI Source | fw_aisource | Yes/No | Default: No |
| Confidence Score | fw_confidencescore | Decimal | Precision: 4 |
| Signal ID | fw_signalid | Single Line Text | Max: 100 |
| Graph Resource ID | fw_graphresourceid | Single Line Text | Max: 200 |
| Engagement Score | fw_engagementscore | Decimal | Precision: 4 |
| Engagement Trend | fw_engagementtrend | Choice | 1=increasing, 2=stable, 3=decreasing, 4=inactive |
| Last Signal Date | fw_lastsignaldate | Date and Time | |
| Signal Count | fw_signalcount | Whole Number | |
| Engagement Scored On | fw_engagementscoredon | Date and Time | |
| At Risk | fw_atrisk | Yes/No | Default: No |
| Risk Level | fw_risklevel | Choice | 1=low, 2=medium, 3=high, 4=critical |
| Risk Reason | fw_riskreason | Multiple Lines of Text | |
| Risk Factors | fw_riskfactors | Multiple Lines of Text | JSON |
| Risk Flagged On | fw_riskflaggedon | Date and Time | |
| Risk Source | fw_risksource | Single Line Text | |

Also add the same engagement fields to **Account**:
- `fw_engagementscore`, `fw_engagementtrend`, `fw_lastsignaldate`, `fw_signalcount`, `fw_engagementscoredon`

Also add to **Appointment** (Activity):
- `fw_aisource` (Yes/No)
- `fw_aisummary` (Multiple Lines of Text)
- `fw_sentiment` (Single Line Text)
- `fw_keydecisions` (Multiple Lines of Text)
- `fw_actionitems` (Multiple Lines of Text)
- `fw_nextsteps` (Multiple Lines of Text)
- `fw_confidencescore` (Decimal)
- `fw_signalid` (Single Line Text)
- `fw_graphresourceid` (Single Line Text)
- `fw_aicreated` (Yes/No)

Also add to **Task** (Activity):
- `fw_aisource` (Yes/No)
- `fw_aicreated` (Yes/No)
- `fw_signalid` (Single Line Text)

---

## Step 6: Register Custom APIs and Deploy Plugins

### 6a. Build the plugin assembly

```bash
cd "F:/projects/RS AI/services/crm-tool-layer/RapidStartAI.Plugins"
dotnet build -c Release
```

### 6b. Register the plugin assembly

```bash
# Connect pac to your environment
pac auth create --url https://yourorg.crm.dynamics.com

# Push the plugin assembly
pac plugin push \
  --assemblyPath bin/Release/net8.0/RapidStartAI.Plugins.dll
```

### 6c. Register Custom APIs

For each API below, go to **make.powerapps.com → Solutions → RapidStart AI → Add → Custom API**:

#### `fw_LogMeeting`
- **Unique Name:** `fw_LogMeeting`
- **Display Name:** Log Meeting
- **Binding Type:** Global
- **Is Function:** No
- **Request Parameters:**
  - `accountid` (String, Optional)
  - `meetingsubject` (String, Required)
  - `meetingstart` (String, Required)
  - `meetingend` (String, Optional)
  - `participantemails` (String, Required)
  - `confidencescore` (Decimal, Optional)
  - `signalid` (String, Optional)
  - `graphresourceid` (String, Optional)
- **Response Properties:**
  - `activityid` (String)
  - `success` (Boolean)
  - `message` (String)
- **Plugin Type:** `RapidStartAI.Plugins.LogMeetingPlugin`

#### `fw_CreateContact`
- **Unique Name:** `fw_CreateContact`
- **Display Name:** Create Contact
- **Binding Type:** Global
- **Is Function:** No
- **Request Parameters:**
  - `email` (String, Required)
  - `displayname` (String, Optional)
  - `accountid` (String, Optional)
- **Response Properties:**
  - `contactid` (String)
  - `success` (Boolean)
  - `message` (String)
  - `alreadyexisted` (Boolean)
- **Plugin Type:** `RapidStartAI.Plugins.CreateContactPlugin`

#### `fw_AddMeetingNotes`
- **Unique Name:** `fw_AddMeetingNotes`
- **Display Name:** Add Meeting Notes
- **Binding Type:** Global
- **Is Function:** No
- **Request Parameters:**
  - `activityid` (String, Required)
  - `summary` (String, Required)
  - `keydecisions` (String, Optional)
  - `actionitems` (String, Optional)
  - `nextsteps` (String, Optional)
  - `sentiment` (String, Optional)
  - `topics` (String, Optional)
  - `aigenerated` (Boolean, Optional)
- **Response Properties:**
  - `success` (Boolean)
  - `message` (String)
- **Plugin Type:** `RapidStartAI.Plugins.AddMeetingNotesPlugin`

#### `fw_FlagAtRisk`
- **Unique Name:** `fw_FlagAtRisk`
- **Display Name:** Flag At Risk
- **Binding Type:** Global
- **Is Function:** No
- **Request Parameters:**
  - `opportunityid` (String, Required)
  - `riskreason` (String, Required)
  - `risklevel` (String, Required)
  - `riskfactors` (String, Optional)
  - `signalsource` (String, Optional)
- **Response Properties:**
  - `success` (Boolean)
  - `message` (String)
- **Plugin Type:** `RapidStartAI.Plugins.FlagAtRiskPlugin`

#### `fw_SuggestFollowUp`
- **Unique Name:** `fw_SuggestFollowUp`
- **Display Name:** Suggest Follow Up
- **Binding Type:** Global
- **Is Function:** No
- **Request Parameters:**
  - `opportunityid` (String, Required)
  - `suggestiontype` (String, Required)
  - `title` (String, Required)
  - `description` (String, Required)
  - `suggestedcontent` (String, Optional)
  - `triggersignal` (String, Optional)
  - `actiondata` (String, Optional)
  - `priority` (String, Optional)
- **Response Properties:**
  - `suggestionid` (String)
  - `success` (Boolean)
  - `message` (String)
- **Plugin Type:** `RapidStartAI.Plugins.SuggestFollowUpPlugin`

---

## Step 7: Configure Microsoft Graph Webhooks

This enables real-time meeting and calendar event capture.

### 7a. Grant Graph permissions to the App Registration

1. Go to **Azure Portal → App registrations → RapidStart AI Signal Processor**
2. **API permissions → Add → Microsoft Graph → Application permissions**
3. Add:
   - `Calendars.Read`
   - `OnlineMeetings.Read.All`
   - `User.Read.All`
4. Click **Grant admin consent**

### 7b. Create the Graph subscription

The `subscription-renewal` timer function handles auto-renewal, but you need to create the initial subscription. You can do this via Graph Explorer or a one-time script:

```bash
# Using Azure CLI with Graph extension
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/subscriptions" \
  --headers "Content-Type=application/json" \
  --body '{
    "changeType": "created,updated",
    "notificationUrl": "https://func-rapidstart-ai-dev.azurewebsites.net/api/signal-router",
    "resource": "/users/{user-id-or-upn}/events",
    "expirationDateTime": "'$(date -u -d "+3 days" +%Y-%m-%dT%H:%M:%SZ)'",
    "clientState": "rapidstart-ai-webhook-secret"
  }'
```

**Note:** Replace `{user-id-or-upn}` with the user whose calendar events you want to capture. For organization-wide capture, use `/communications/callRecords` or set up subscriptions per user.

### 7c. Set the webhook secret

Store the `clientState` value so the signal router can validate incoming notifications:

```bash
az functionapp config appsettings set \
  --name func-rapidstart-ai-dev \
  --resource-group rg-rapidstart-ai-dev \
  --settings "GRAPH_WEBHOOK_SECRET=rapidstart-ai-webhook-secret"
```

---

## Step 8: Upload Web Resources to Dataverse

Upload each web resource HTML file to Dataverse.

1. Go to **make.powerapps.com → Solutions → RapidStart AI**
2. Click **Add → Web resource** for each:

| Display Name | Name | Type | Source File |
|---|---|---|---|
| AI Health Dashboard | `fw_aihealthdashboard` | Webpage (HTML) | `apps/webresources/ai-health-dashboard/index.html` |
| Pipeline Health | `fw_pipelinehealth` | Webpage (HTML) | `apps/webresources/pipeline-health/index.html` |
| Salesperson Cockpit | `fw_salespersoncockpit` | Webpage (HTML) | `apps/salesperson-cockpit/index.html` |

3. **Publish all customizations** after uploading

### Embedding in forms (optional)

To add a web resource to an Opportunity or Account form:
1. Open the form editor for the entity
2. Add a **Web Resource** component
3. Select the web resource (e.g., `fw_pipelinehealth`)
4. Set the height to 600px or desired size
5. Save and publish

---

## Step 9: Enable EasyAuth for Agent Endpoints (Optional)

If you want the agent HTTP endpoints secured by Azure AD (recommended for production):

1. Go to **Azure Portal → Function App → Authentication**
2. Click **Add identity provider → Microsoft**
3. Select the App Registration from Step 2
4. Set **Unauthenticated requests** to **Return HTTP 401**
5. Save

This will populate the `x-ms-token-aad-*` headers that the agent API endpoints use.

---

## Step 10: Publish the Dataverse Solution

After all tables, fields, Custom APIs, plugins, and web resources are configured:

1. Go to **make.powerapps.com → Solutions → RapidStart AI**
2. Click **Publish all customizations**
3. Export the solution for backup:

```bash
cd "F:/projects/RS AI"
bash scripts/export-solution.sh
```

---

## Verification Checklist

After completing all steps, verify:

- [ ] Function App is running — check **Azure Portal → Function App → Functions** shows all 11 functions
- [ ] Signal router responds — `POST /api/signal-router` returns 401 (auth required) not 404
- [ ] Agent endpoints respond — `POST /api/agents/account-intelligence` returns 401
- [ ] Plugin assembly is registered — check Plugin Registration Tool
- [ ] Custom APIs are registered — test via Dataverse API: `POST /api/data/v9.2/fw_LogMeeting`
- [ ] Dataverse tables exist — verify via `GET /api/data/v9.2/fw_signallogs?$top=1`
- [ ] Graph subscription is active — check via Graph Explorer: `GET /v1.0/subscriptions`
- [ ] Web resources are published — open each via its Dataverse URL
- [ ] Timer functions fire on schedule — check App Insights logs after 1 hour

```bash
# Quick health check
curl -s -w "%{http_code}" -X POST \
  "https://func-rapidstart-ai-dev.azurewebsites.net/api/signal-router" \
  -H "Content-Type: application/json" -d '{}'
# Expected: 401 (auth required)

curl -s -w "%{http_code}" -X POST \
  "https://func-rapidstart-ai-dev.azurewebsites.net/api/agents/account-intelligence" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"test","question":"test"}'
# Expected: 401 (no identity claims)
```

---

## Troubleshooting

| Problem | Check |
|---|---|
| Function App returns 500 | Check App Insights → Failures for stack traces |
| Dataverse 401/403 | Verify Application User exists and has correct security role |
| OpenAI 401 | Verify `OPENAI_API_KEY` is set and valid |
| Graph webhook not firing | Verify subscription is active, notificationUrl is correct |
| Timer functions not running | Check Function App → Functions → Monitor for invocation history |
| Plugin errors | Check Dataverse → Settings → Plugin Trace Logs |
