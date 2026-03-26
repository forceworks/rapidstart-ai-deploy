#Requires -Version 5.1
<#
.SYNOPSIS
    RapidStart AI — Post-AppSource-install setup wizard for Dynamics 365.

.DESCRIPTION
    Automates the 7-step setup that follows AppSource installation of RapidStart AI.
    Deploys Azure resources, creates the app registration, provisions the Dataverse
    application user, configures the Function App, and creates Graph subscriptions.

    Each step is idempotent (checks before creating) and state is saved to
    .rapidstart-ai-setup.json so that the script can be resumed after interruption.

.PARAMETER Step
    Run a single step (1-8) instead of the full wizard.

.PARAMETER ResourceGroupName
    Azure resource group to create or reuse. Default: rg-rapidstart-ai

.PARAMETER Location
    Azure region. Default: eastus

.PARAMETER DataverseUrl
    Your Dataverse environment URL (e.g. https://org1234.crm.dynamics.com).

.PARAMETER Environment
    Deployment ring — dev, staging, or prod. Default: dev

.EXAMPLE
    .\Setup-RapidStartAI.ps1 -DataverseUrl https://myorg.crm.dynamics.com

.EXAMPLE
    .\Setup-RapidStartAI.ps1 -Step 4 -WhatIf

.NOTES
    Requires: Az PowerShell module, Microsoft.Graph PowerShell module, pac CLI.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(1, 8)]
    [int]$Step,

    [string]$ResourceGroupName = "rg-rapidstart-ai",

    [string]$Location = "eastus",

    [string]$DataverseUrl,

    [ValidateSet("dev", "staging", "prod")]
    [string]$Environment = "dev"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────

$ScriptRoot  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptRoot
$BicepFile   = Join-Path $ProjectRoot "infra\bicep\main.bicep"
$StateFile   = Join-Path (Get-Location) ".rapidstart-ai-setup.json"

# ── State helpers ─────────────────────────────────────────────────────────────

function Load-State {
    if (Test-Path $StateFile) {
        return Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable
    }
    return @{}
}

function Save-State {
    param([hashtable]$State)
    $State | ConvertTo-Json -Depth 10 | Set-Content $StateFile -Encoding UTF8
}

# ── Output helpers ────────────────────────────────────────────────────────────

function Write-StepHeader {
    param([int]$Number, [string]$Title)
    Write-Host ""
    Write-Host ("=" * 72) -ForegroundColor DarkGray
    Write-Host "  Step $Number : $Title" -ForegroundColor Cyan
    Write-Host ("=" * 72) -ForegroundColor DarkGray
}

function Write-Success  { param([string]$Msg) Write-Host "  [OK]      $Msg" -ForegroundColor Green   }
function Write-Warn     { param([string]$Msg) Write-Host "  [WARN]    $Msg" -ForegroundColor Yellow  }
function Write-Err      { param([string]$Msg) Write-Host "  [ERROR]   $Msg" -ForegroundColor Red     }
function Write-Info     { param([string]$Msg) Write-Host "  [INFO]    $Msg" -ForegroundColor White   }
function Write-Skipping { param([string]$Msg) Write-Host "  [SKIP]    $Msg" -ForegroundColor DarkYellow }

# ── Banner ────────────────────────────────────────────────────────────────────

function Show-Banner {
    $banner = @"

    =====================================================================
     ____             _     _ ____  _             _        _    ___
    |  _ \ __ _ _ __ (_) __| / ___|| |_ __ _ _ __| |_     / \  |_ _|
    | |_) / _` | '_ \| |/ _` \___ \| __/ _` | '__| __|   / _ \  | |
    |  _ < (_| | |_) | | (_| |___) | || (_| | |  | |_   / ___ \ | |
    |_| \_\__,_| .__/|_|\__,_|____/ \__\__,_|_|   \__| /_/   \_\___|
               |_|
    =====================================================================
     Post-AppSource Setup Wizard                       Environment: $Environment
    =====================================================================

"@
    Write-Host $banner -ForegroundColor Cyan
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 1 — Check Prerequisites
# ──────────────────────────────────────────────────────────────────────────────

function Step1-CheckPrerequisites {
    Write-StepHeader 1 "Check Prerequisites"

    $allGood = $true

    # Az module
    if (Get-Module -ListAvailable -Name Az.Accounts) {
        Write-Success "Az PowerShell module is installed."
    }
    else {
        Write-Err "Az PowerShell module not found. Install with:  Install-Module Az -Scope CurrentUser"
        $allGood = $false
    }

    # Microsoft.Graph module
    if (Get-Module -ListAvailable -Name Microsoft.Graph.Applications) {
        Write-Success "Microsoft.Graph PowerShell module is installed."
    }
    else {
        Write-Err "Microsoft.Graph module not found. Install with:  Install-Module Microsoft.Graph -Scope CurrentUser"
        $allGood = $false
    }

    # pac CLI
    $pacPath = Get-Command pac -ErrorAction SilentlyContinue
    if ($pacPath) {
        Write-Success "pac CLI found at $($pacPath.Source)"
    }
    else {
        Write-Warn "pac CLI not found in PATH. Step 5 (Dataverse app user) will fall back to manual instructions."
    }

    # Bicep template
    if (Test-Path $BicepFile) {
        Write-Success "Bicep template found at $BicepFile"
    }
    else {
        Write-Err "Bicep template not found at $BicepFile — cannot deploy Azure resources."
        $allGood = $false
    }

    if (-not $allGood) {
        Write-Err "One or more prerequisites are missing. Please install them and re-run."
        return $false
    }

    Write-Success "All prerequisites satisfied."
    return $true
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 2 — Authenticate
# ──────────────────────────────────────────────────────────────────────────────

function Step2-Authenticate {
    Write-StepHeader 2 "Authenticate to Azure and Microsoft Graph"

    # Azure
    $azCtx = Get-AzContext -ErrorAction SilentlyContinue
    if ($azCtx) {
        Write-Skipping "Already signed in to Azure as $($azCtx.Account.Id) (tenant $($azCtx.Tenant.Id))."
    }
    else {
        Write-Info "Opening Azure sign-in..."
        if ($PSCmdlet.ShouldProcess("Azure", "Connect-AzAccount")) {
            Connect-AzAccount | Out-Null
            $azCtx = Get-AzContext
            Write-Success "Signed in as $($azCtx.Account.Id)"
        }
    }

    # Microsoft Graph
    try {
        $graphCtx = Get-MgContext -ErrorAction Stop
        if ($graphCtx) {
            Write-Skipping "Already connected to Microsoft Graph as $($graphCtx.Account)."
        }
        else {
            throw "no context"
        }
    }
    catch {
        $scopes = @(
            "Application.ReadWrite.All",
            "AppRoleAssignment.ReadWrite.All",
            "Directory.ReadWrite.All"
        )
        Write-Info "Opening Microsoft Graph sign-in (scopes: $($scopes -join ', '))..."
        if ($PSCmdlet.ShouldProcess("Microsoft Graph", "Connect-MgGraph")) {
            Connect-MgGraph -Scopes $scopes -NoWelcome | Out-Null
            $graphCtx = Get-MgContext
            Write-Success "Connected to Graph as $($graphCtx.Account)"
        }
    }

    # Persist tenant ID in state
    $state = Load-State
    $azCtx = Get-AzContext
    if ($azCtx) {
        $state["TenantId"] = $azCtx.Tenant.Id
    }
    Save-State $state
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 3 — Deploy Azure Resources
# ──────────────────────────────────────────────────────────────────────────────

function Step3-DeployAzureResources {
    Write-StepHeader 3 "Deploy Azure Resources (Bicep)"

    $state = Load-State

    # Prompt for Dataverse URL if not supplied
    if (-not $DataverseUrl) {
        if ($state.ContainsKey("DataverseUrl")) {
            $DataverseUrl = $state["DataverseUrl"]
            Write-Info "Using saved Dataverse URL: $DataverseUrl"
        }
        else {
            $DataverseUrl = Read-Host "  Enter your Dataverse environment URL (e.g. https://org1234.crm.dynamics.com)"
            if (-not $DataverseUrl) {
                Write-Err "Dataverse URL is required."
                return $false
            }
        }
    }
    $state["DataverseUrl"] = $DataverseUrl

    # Prompt for resource group name and location if defaults
    if (-not $PSBoundParameters.ContainsKey("ResourceGroupName")) {
        $input = Read-Host "  Resource group name [$ResourceGroupName]"
        if ($input) { $ResourceGroupName = $input }
    }
    if (-not $PSBoundParameters.ContainsKey("Location")) {
        $input = Read-Host "  Azure region [$Location]"
        if ($input) { $Location = $input }
    }

    $state["ResourceGroupName"] = $ResourceGroupName
    $state["Location"] = $Location

    # Create resource group if needed
    $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
    if ($rg) {
        Write-Skipping "Resource group '$ResourceGroupName' already exists in $($rg.Location)."
    }
    else {
        if ($PSCmdlet.ShouldProcess($ResourceGroupName, "New-AzResourceGroup")) {
            New-AzResourceGroup -Name $ResourceGroupName -Location $Location | Out-Null
            Write-Success "Created resource group '$ResourceGroupName' in $Location."
        }
    }

    # Deploy Bicep
    Write-Info "Deploying Bicep template — this may take several minutes..."
    $deployParams = @{
        ResourceGroupName = $ResourceGroupName
        TemplateFile      = $BicepFile
        environment       = $Environment
        dataverseUrl      = $DataverseUrl
    }

    if ($PSCmdlet.ShouldProcess($ResourceGroupName, "New-AzResourceGroupDeployment (main.bicep)")) {
        $deployment = New-AzResourceGroupDeployment @deployParams -Name "rsai-setup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

        if ($deployment.ProvisioningState -ne "Succeeded") {
            Write-Err "Deployment failed with state: $($deployment.ProvisioningState)"
            return $false
        }

        # Capture outputs
        $state["FunctionAppName"]      = $deployment.Outputs["functionAppName"].Value
        $state["FunctionAppUrl"]       = $deployment.Outputs["functionAppUrl"].Value
        $state["ServiceBusNamespace"]  = $deployment.Outputs["serviceBusNamespace"].Value
        $state["KeyVaultName"]         = $deployment.Outputs["keyVaultName"].Value
        $state["OpenAIEndpoint"]       = $deployment.Outputs["openaiEndpoint"].Value

        Write-Success "Deployment succeeded."
        Write-Info "Function App:    $($state['FunctionAppUrl'])"
        Write-Info "Service Bus:     $($state['ServiceBusNamespace'])"
        Write-Info "Key Vault:       $($state['KeyVaultName'])"
        Write-Info "OpenAI Endpoint: $($state['OpenAIEndpoint'])"
    }

    Save-State $state
    return $true
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 4 — Create App Registration
# ──────────────────────────────────────────────────────────────────────────────

function Step4-CreateAppRegistration {
    Write-StepHeader 4 "Create Azure AD App Registration"

    $state    = Load-State
    $appName  = "RapidStart AI Signal Processor"

    # Check if app already exists
    $existing = Get-MgApplication -Filter "displayName eq '$appName'" -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($existing) {
        Write-Skipping "App registration '$appName' already exists (AppId: $($existing.AppId))."
        $state["ClientId"]      = $existing.AppId
        $state["ObjectId"]      = $existing.Id
        Save-State $state
    }
    else {
        # Define required API permissions
        $dynamicsCrmAppId = "00000007-0000-0000-c000-000000000000"
        $graphAppId       = "00000003-0000-0000-c000-000000000000"

        # Look up Dynamics CRM service principal for permission IDs
        $crmSp = Get-MgServicePrincipal -Filter "appId eq '$dynamicsCrmAppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
        $userImpersonationId = ($crmSp.Oauth2PermissionScopes | Where-Object { $_.Value -eq "user_impersonation" }).Id

        # Look up Graph service principal for app role IDs
        $graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
        $calendarsReadId       = ($graphSp.AppRoles | Where-Object { $_.Value -eq "Calendars.Read"            }).Id
        $onlineMeetingsReadId  = ($graphSp.AppRoles | Where-Object { $_.Value -eq "OnlineMeetings.Read.All"   }).Id
        $usersReadAllId        = ($graphSp.AppRoles | Where-Object { $_.Value -eq "User.Read.All"             }).Id

        $requiredAccess = @(
            @{
                ResourceAppId  = $dynamicsCrmAppId
                ResourceAccess = @(
                    @{ Id = $userImpersonationId; Type = "Scope" }
                )
            },
            @{
                ResourceAppId  = $graphAppId
                ResourceAccess = @(
                    @{ Id = $calendarsReadId;      Type = "Role" },
                    @{ Id = $onlineMeetingsReadId; Type = "Role" },
                    @{ Id = $usersReadAllId;       Type = "Role" }
                )
            }
        )

        if ($PSCmdlet.ShouldProcess($appName, "New-MgApplication")) {
            $app = New-MgApplication -DisplayName $appName `
                -SignInAudience "AzureADMyOrg" `
                -RequiredResourceAccess $requiredAccess

            Write-Success "Created app registration '$appName' (AppId: $($app.AppId))."

            $state["ClientId"] = $app.AppId
            $state["ObjectId"] = $app.Id
        }
    }

    # Create client secret (always check if one is already saved)
    if ($state.ContainsKey("ClientSecret") -and $state["ClientSecret"]) {
        Write-Skipping "Client secret already recorded in state file."
    }
    else {
        if ($PSCmdlet.ShouldProcess($appName, "Add-MgApplicationPassword")) {
            $secret = Add-MgApplicationPassword -ApplicationId $state["ObjectId"] -PasswordCredential @{
                DisplayName = "RapidStart AI Setup $(Get-Date -Format 'yyyy-MM-dd')"
                EndDateTime = (Get-Date).AddYears(1)
            }
            $state["ClientSecret"]       = $secret.SecretText
            $state["SecretExpiry"]        = $secret.EndDateTime.ToString("yyyy-MM-dd")
            Write-Success "Created client secret (expires $($state['SecretExpiry']))."
            Write-Warn "Save this secret — it cannot be retrieved later."
        }
    }

    # Ensure service principal exists
    $sp = Get-MgServicePrincipal -Filter "appId eq '$($state['ClientId'])'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sp) {
        Write-Skipping "Service principal already exists."
        $state["ServicePrincipalId"] = $sp.Id
    }
    else {
        if ($PSCmdlet.ShouldProcess($appName, "New-MgServicePrincipal")) {
            $sp = New-MgServicePrincipal -AppId $state["ClientId"]
            $state["ServicePrincipalId"] = $sp.Id
            Write-Success "Created service principal."
        }
    }

    # Grant admin consent for application permissions (Graph app roles)
    if ($sp) {
        $graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
        $appRoleNames = @("Calendars.Read", "OnlineMeetings.Read.All", "User.Read.All")

        foreach ($roleName in $appRoleNames) {
            $roleId = ($graphSp.AppRoles | Where-Object { $_.Value -eq $roleName }).Id

            $existingAssignment = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -ErrorAction SilentlyContinue |
                Where-Object { $_.AppRoleId -eq $roleId -and $_.ResourceId -eq $graphSp.Id }

            if ($existingAssignment) {
                Write-Skipping "Admin consent already granted for $roleName."
            }
            else {
                if ($PSCmdlet.ShouldProcess($roleName, "Grant admin consent")) {
                    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -Body @{
                        PrincipalId = $sp.Id
                        ResourceId  = $graphSp.Id
                        AppRoleId   = $roleId
                    } | Out-Null
                    Write-Success "Granted admin consent for $roleName."
                }
            }
        }
    }

    Save-State $state
    return $true
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 5 — Create Dataverse Application User
# ──────────────────────────────────────────────────────────────────────────────

function Step5-CreateDataverseAppUser {
    Write-StepHeader 5 "Create Dataverse Application User"

    $state    = Load-State
    $clientId = $state["ClientId"]

    if (-not $clientId) {
        Write-Err "No Client ID found in state. Run Step 4 first."
        return $false
    }

    $pacPath = Get-Command pac -ErrorAction SilentlyContinue

    if (-not $pacPath) {
        Write-Warn "pac CLI not found. Please create the application user manually:"
        Write-Host ""
        Write-Host "    1. Go to https://admin.powerplatform.microsoft.com" -ForegroundColor White
        Write-Host "    2. Select your environment -> Settings -> Users + Permissions -> Application users" -ForegroundColor White
        Write-Host "    3. Click '+ New app user' and enter Application ID: $clientId" -ForegroundColor Yellow
        Write-Host "    4. Assign the 'System Administrator' security role" -ForegroundColor White
        Write-Host ""
        return $true
    }

    # Get the environment ID from the Dataverse URL
    $dataverseUrl = $state["DataverseUrl"]
    if (-not $dataverseUrl) {
        $dataverseUrl = Read-Host "  Enter your Dataverse environment URL"
        $state["DataverseUrl"] = $dataverseUrl
        Save-State $state
    }

    Write-Info "Listing Power Platform environments to find matching environment..."
    try {
        $envList = pac admin list --output json 2>$null | ConvertFrom-Json
        $envUrl  = $dataverseUrl.TrimEnd('/')
        $match   = $envList | Where-Object { $_.Url.TrimEnd('/') -eq $envUrl -or $_.EnvironmentUrl.TrimEnd('/') -eq $envUrl } | Select-Object -First 1

        if (-not $match) {
            Write-Warn "Could not automatically find environment ID for $dataverseUrl."
            $envId = Read-Host "  Enter the Power Platform environment ID manually"
        }
        else {
            $envId = $match.EnvironmentId
            Write-Info "Found environment: $($match.DisplayName) ($envId)"
        }
    }
    catch {
        $envId = Read-Host "  Could not list environments. Enter the Power Platform environment ID"
    }

    if ($PSCmdlet.ShouldProcess("Environment $envId", "pac admin create-service-principal")) {
        Write-Info "Creating application user for AppId $clientId..."
        try {
            pac admin create-service-principal --environment-id $envId --application-id $clientId
            Write-Success "Dataverse application user created."
            $state["DataverseAppUserCreated"] = $true
            Save-State $state
        }
        catch {
            Write-Err "pac command failed: $_"
            Write-Warn "Create the application user manually in the Power Platform admin center."
            Write-Host "    Application ID: $clientId" -ForegroundColor Yellow
        }
    }

    return $true
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 6 — Configure Function App Settings
# ──────────────────────────────────────────────────────────────────────────────

function Step6-ConfigureFunctionApp {
    Write-StepHeader 6 "Configure Function App Settings"

    $state = Load-State

    $functionAppName  = $state["FunctionAppName"]
    $resourceGroup    = $state["ResourceGroupName"]
    $clientId         = $state["ClientId"]
    $clientSecret     = $state["ClientSecret"]
    $dataverseUrl     = $state["DataverseUrl"]
    $tenantId         = $state["TenantId"]

    if (-not $functionAppName) {
        Write-Err "No Function App name in state. Run Step 3 first."
        return $false
    }
    if (-not $clientId -or -not $clientSecret) {
        Write-Err "No Client ID / Secret in state. Run Step 4 first."
        return $false
    }

    $settings = @{
        CLIENT_ID      = $clientId
        CLIENT_SECRET  = $clientSecret
        DATAVERSE_URL  = $dataverseUrl
        TENANT_ID      = $tenantId
    }

    Write-Info "Injecting app settings into $functionAppName..."

    if ($PSCmdlet.ShouldProcess($functionAppName, "Set Function App configuration")) {
        $webapp = Get-AzWebApp -ResourceGroupName $resourceGroup -Name $functionAppName
        $existingSettings = $webapp.SiteConfig.AppSettings

        # Merge — preserve existing settings, add/overwrite ours
        $merged = @{}
        foreach ($s in $existingSettings) {
            $merged[$s.Name] = $s.Value
        }
        foreach ($key in $settings.Keys) {
            $merged[$key] = $settings[$key]
        }

        $appSettingsList = $merged.GetEnumerator() | ForEach-Object {
            @{ Name = $_.Key; Value = $_.Value }
        }

        Set-AzWebApp -ResourceGroupName $resourceGroup -Name $functionAppName -AppSettings $merged | Out-Null

        Write-Success "Function App settings updated."
        foreach ($key in $settings.Keys) {
            $display = if ($key -eq "CLIENT_SECRET") { "********" } else { $settings[$key] }
            Write-Info "  $key = $display"
        }
    }

    return $true
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 7 — Create Graph Subscriptions
# ──────────────────────────────────────────────────────────────────────────────

function Step7-CreateGraphSubscriptions {
    Write-StepHeader 7 "Create Microsoft Graph Subscriptions"

    $state          = Load-State
    $functionAppUrl = $state["FunctionAppUrl"]

    if (-not $functionAppUrl) {
        Write-Err "No Function App URL in state. Run Step 3 first."
        return $false
    }

    $notificationUrl = "$($functionAppUrl.TrimEnd('/'))/api/graph-webhook"
    $expiration      = (Get-Date).AddDays(3).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")

    Write-Info "Notification URL: $notificationUrl"
    Write-Info "Subscription expiry: $expiration"
    Write-Host ""

    $emailInput = Read-Host "  Enter email address(es) to monitor (comma-separated)"
    if (-not $emailInput) {
        Write-Warn "No emails provided — skipping subscription creation."
        return $true
    }

    $emails = $emailInput -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }

    if (-not $state.ContainsKey("GraphSubscriptions")) {
        $state["GraphSubscriptions"] = @()
    }

    foreach ($email in $emails) {
        Write-Info "Creating calendar subscription for $email..."

        $body = @{
            changeType         = "created,updated,deleted"
            notificationUrl    = $notificationUrl
            resource           = "users/$email/events"
            expirationDateTime = $expiration
            clientState        = "rapidstart-ai-$Environment"
        }

        if ($PSCmdlet.ShouldProcess("users/$email/events", "Create Graph subscription")) {
            try {
                $sub = Invoke-MgGraphRequest -Method POST `
                    -Uri "https://graph.microsoft.com/v1.0/subscriptions" `
                    -Body ($body | ConvertTo-Json) `
                    -ContentType "application/json"

                Write-Success "Subscription created: $($sub.id) (expires $($sub.expirationDateTime))"

                $state["GraphSubscriptions"] += @{
                    Email          = $email
                    SubscriptionId = $sub.id
                    Expiration     = $sub.expirationDateTime
                }
            }
            catch {
                Write-Err "Failed to create subscription for ${email}: $_"
                Write-Warn "Ensure the Function App is deployed and reachable at $notificationUrl"
            }
        }
    }

    Save-State $state
    return $true
}

# ──────────────────────────────────────────────────────────────────────────────
# Step 8 — Output Summary
# ──────────────────────────────────────────────────────────────────────────────

function Step8-OutputSummary {
    Write-StepHeader 8 "Setup Summary"

    $state = Load-State

    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────────────────────────────────┐" -ForegroundColor Cyan
    Write-Host "  │                  RapidStart AI — Setup Complete                  │" -ForegroundColor Cyan
    Write-Host "  └──────────────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
    Write-Host ""

    $fields = [ordered]@{
        "Environment"          = $state["Location"]
        "Resource Group"       = $state["ResourceGroupName"]
        "Dataverse URL"        = $state["DataverseUrl"]
        "Function App"         = $state["FunctionAppUrl"]
        "Function App Name"    = $state["FunctionAppName"]
        "Service Bus"          = $state["ServiceBusNamespace"]
        "Key Vault"            = $state["KeyVaultName"]
        "OpenAI Endpoint"      = $state["OpenAIEndpoint"]
        "App Registration"     = $state["ClientId"]
        "Client Secret Expiry" = $state["SecretExpiry"]
        "Tenant ID"            = $state["TenantId"]
    }

    foreach ($entry in $fields.GetEnumerator()) {
        $val = if ($entry.Value) { $entry.Value } else { "(not set)" }
        Write-Host ("  {0,-22} {1}" -f "$($entry.Key):", $val) -ForegroundColor White
    }

    # Graph subscriptions
    if ($state.ContainsKey("GraphSubscriptions") -and $state["GraphSubscriptions"].Count -gt 0) {
        Write-Host ""
        Write-Host "  Graph Subscriptions:" -ForegroundColor Cyan
        foreach ($sub in $state["GraphSubscriptions"]) {
            Write-Host ("    - {0}  (ID: {1}, expires {2})" -f $sub.Email, $sub.SubscriptionId, $sub.Expiration) -ForegroundColor White
        }
    }

    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────────────────────────────────┐" -ForegroundColor Green
    Write-Host "  │  Next Steps                                                      │" -ForegroundColor Green
    Write-Host "  └──────────────────────────────────────────────────────────────────┘" -ForegroundColor Green
    Write-Host ""
    Write-Host "  1. Open Dynamics 365 and navigate to RapidStart AI > AI Settings"   -ForegroundColor White
    Write-Host "  2. Click 'Validate Connection' to confirm the Function App link"    -ForegroundColor White
    Write-Host "  3. Enable the signals you want to process (calendar, email, etc.)"  -ForegroundColor White
    Write-Host "  4. Graph subscriptions expire after 3 days — a background process"  -ForegroundColor White
    Write-Host "     in the Function App renews them automatically once running."      -ForegroundColor White
    Write-Host ""
    Write-Host "  State file saved to: $StateFile" -ForegroundColor DarkGray
    Write-Host ""
}

# ──────────────────────────────────────────────────────────────────────────────
# Main orchestrator
# ──────────────────────────────────────────────────────────────────────────────

function Invoke-Setup {
    Show-Banner

    $steps = @(
        @{ Number = 1; Name = "Check Prerequisites";          Fn = { Step1-CheckPrerequisites } },
        @{ Number = 2; Name = "Authenticate";                 Fn = { Step2-Authenticate } },
        @{ Number = 3; Name = "Deploy Azure Resources";       Fn = { Step3-DeployAzureResources } },
        @{ Number = 4; Name = "Create App Registration";      Fn = { Step4-CreateAppRegistration } },
        @{ Number = 5; Name = "Create Dataverse App User";    Fn = { Step5-CreateDataverseAppUser } },
        @{ Number = 6; Name = "Configure Function App";       Fn = { Step6-ConfigureFunctionApp } },
        @{ Number = 7; Name = "Create Graph Subscriptions";   Fn = { Step7-CreateGraphSubscriptions } },
        @{ Number = 8; Name = "Output Summary";               Fn = { Step8-OutputSummary } }
    )

    if ($Step) {
        # Run single step
        $target = $steps | Where-Object { $_.Number -eq $Step }
        if (-not $target) {
            Write-Err "Invalid step number: $Step"
            return
        }
        Write-Info "Running step $Step only: $($target.Name)"
        $result = & $target.Fn
        if ($result -eq $false) {
            Write-Err "Step $Step failed."
        }
    }
    else {
        # Run all steps sequentially
        foreach ($s in $steps) {
            $result = & $s.Fn
            if ($result -eq $false) {
                Write-Err "Step $($s.Number) failed. Fix the issue and re-run, or use -Step $($s.Number) to retry."
                Write-Info "Progress saved to $StateFile"
                return
            }
        }
    }
}

# Entry point
Invoke-Setup
