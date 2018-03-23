"use strict";

import * as fsExtra from "fs-extra";
import * as path from "path";
import { clearInterval, setInterval } from "timers";
import { commands, window } from "vscode";
import { TelemetryWrapper } from "vscode-extension-telemetry-wrapper";
import * as nls from "vscode-nls";
import { AzureAccount, AzureSession, AzureSubscription } from "./azure-account.api";
import {
    Errors, getStorageAccountKey, getUserSettings,
    provisionConsole, resetConsole, runInTerminal,
} from "./cloudConsoleLauncher";
import { terraformChannel } from "./terraformChannel";
import { isNodeVersionValid } from "./utils/nodeUtils";
import { DialogOption, openUrlHint } from "./utils/uiUtils";

const localize = nls.loadMessageBundle();

export interface IOS {
    id: string;
    shellName: string;
    otherOS: IOS;
}

export const OSes: Record<string, IOS> = {
    Linux: {
        id: "linux",
        shellName: localize("azure-account.bash", "Bash"),
        get otherOS() { return OSes.Windows; },
    },
    Windows: {
        id: "windows",
        shellName: localize("azure-account.powershell", "PowerShell"),
        get otherOS() { return OSes.Linux; },
    },
};

export async function openCloudConsole(api: AzureAccount, subscription: AzureSubscription, os: IOS, tempFile: string): Promise<any[]> {
    await fsExtra.remove(tempFile);
    const progress = delayedInterval(() => terraformChannel.append(".."), 500);
    return (async function retry(): Promise<any> {
        terraformChannel.show();
        terraformChannel.appendLine("Attempting to open CloudConsole - Connecting to cloudshell");

        const isWindows = process.platform === "win32";
        if (isWindows && !await isNodeVersionValid()) {
            progress.cancel();
            openUrlHint("Opening a Cloud Shell currently requires Node.js 6 or later being installed.", "https://nodejs.org");
            TelemetryWrapper.error("nodeNotValid");
            return;
        }

        // Loging in to Azure using the azure account extension
        if (!(await api.waitForLogin())) {
            progress.cancel();
            await commands.executeCommand("azure-account.askForLogin");
            if (!(await api.waitForLogin())) {
                TelemetryWrapper.error("notLoginIn");
                return;
            }
        }

        // Getting the tokens for the session
        const tokens = await Promise.all(api.sessions.map((session) => acquireToken(session)));
        const result = await findUserSettings(tokens);
        if (!result) {
            progress.cancel();
            openUrlHint("First launch of Cloud Shell requires setup in the Azure portal.", "https://portal.azure.com");
            TelemetryWrapper.error("needSetupCloudShell");
            return;
        }

        terraformChannel.appendLine("Usersettings obtained from Tokens - proceeding");

        // Finding the storage account
        const storageProfile = result.userSettings.storageProfile;
        const storageAccountSettings =
            storageProfile.storageAccountResourceId.substr(1,
                storageProfile.storageAccountResourceId.length).split("/");
        const storageAccount = {
            subscriptionId: storageAccountSettings[1],
            resourceGroup: storageAccountSettings[3],
            provider: storageAccountSettings[5],
            storageAccountName: storageAccountSettings[7],
        };

        const fileShareName = result.userSettings.storageProfile.fileShareName;

        // Getting the storage account key
        let storageAccountKey: string;
        await getStorageAccountKey(
            storageAccount.resourceGroup,
            storageAccount.subscriptionId,
            result.token.accessToken,
            storageAccount.storageAccountName).then((keys) => {
                terraformChannel.appendLine("Storage key obtained ");
                storageAccountKey = keys.body.keys[0].value;
            });

        // Getting the console URI
        let consoleUri: string;
        const armEndpoint = result.token.session.environment.resourceManagerEndpointUrl;
        try {
            consoleUri = await provisionConsole(result.token.accessToken, armEndpoint, result.userSettings, "linux");
        } catch (err) {
            progress.cancel();
            if (err && err.message === Errors.DeploymentOsTypeConflict) {
                return deploymentConflict(retry, result.token.accessToken, armEndpoint);
            }
            TelemetryWrapper.error(err);
            throw err;
        }

        let shellPath = path.join(__dirname, `../bin/node.${isWindows ? "bat" : "sh"}`);
        let modulePath = path.join(__dirname, "cloudConsoleLauncher");
        if (isWindows) {
            modulePath = modulePath.replace(/\\/g, "\\\\");
        }
        const shellArgs = [
            process.argv0,
            "-e",
            `require("${modulePath}").main()`,
        ];

        if (isWindows) {
            // Work around https://github.com/electron/electron/issues/4218 https://github.com/nodejs/node/issues/11656
            shellPath = "node.exe";
            shellArgs.shift();
        }

        const response = await runInTerminal(result.token.accessToken, consoleUri, "");

        const terminal = window.createTerminal({
            name: "Terraform in CloudShell",
            shellPath,
            shellArgs,
            env: {
                CLOUD_CONSOLE_ACCESS_TOKEN: result.token.accessToken,
                CLOUD_CONSOLE_URI: consoleUri,
                CLOUDSHELL_TEMP_FILE: tempFile,
                // to workaround tls error: https://github.com/VSChina/vscode-ansible/pull/44
                NODE_TLS_REJECT_UNAUTHORIZED: "0",
            },
        });

        terminal.show();
        progress.cancel();
        return [terminal, response, storageAccount.storageAccountName, storageAccountKey, fileShareName, storageAccount.resourceGroup];

    })().catch((err) => {
        terraformChannel.appendLine("Connecting to CloudShell failed with error: " + err);
        terraformChannel.show();
        progress.cancel();
        TelemetryWrapper.error(err);
        throw err;
    });
}

async function deploymentConflict(retry: () => Promise<void>, accessToken: string, armEndpoint: string) {
    const message = "Starting a linux session will terminate all active sessions. Any running processes in active sessions will be terminated.";
    const response = await window.showWarningMessage(message, DialogOption.ok, DialogOption.cancel);
    if (response === DialogOption.ok) {
        await resetConsole(accessToken, armEndpoint);
        return retry();
    }
}

interface IToken {
    session: AzureSession;
    accessToken: string;
    refreshToken: string;
}

async function acquireToken(session: AzureSession) {
    return new Promise<IToken>((resolve, reject) => {
        const credentials: any = session.credentials;
        const environment: any = session.environment;
        credentials.context.acquireToken(environment.activeDirectoryResourceId,
            credentials.username, credentials.clientId, (err: any, result: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        session,
                        accessToken: result.accessToken,
                        refreshToken: result.refreshToken,
                    });
                }
            });
    });
}

async function findUserSettings(tokens: IToken[]) {
    for (const token of tokens) {
        const userSettings =
            await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
        if (userSettings && userSettings.storageProfile) {
            return { userSettings, token };
        }
    }
}

function delayedInterval(func: () => void, interval: number) {
    const handle = setInterval(func, interval);
    return {
        cancel: () => clearInterval(handle),
    };
}
