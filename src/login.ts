import * as core from '@actions/core';
import * as path from 'path';
import * as fs from 'fs';
import { WebRequest, WebRequestOptions, WebResponse, sendRequest } from "./client";
import * as querystring from 'querystring';

interface AksContext {
    kubeconfig: string;
    resourceContext: AksResourceContext;
}

interface AksResourceContext {
    subscriptionId: string;
    resourceGroup: string;
    clusterName: string;
    sessionToken: string;
    managementUrl: string;
}

function getAzureAccessToken(servicePrincipalId, servicePrincipalKey, tenantId, authorityUrl, managementEndpointUrl : string): Promise<string> {

    if (!servicePrincipalId || !servicePrincipalKey || !tenantId || !authorityUrl) {
        throw new Error("Not all values are present in the creds object. Ensure appId, password and tenant are supplied");
    }
    return new Promise<string>((resolve, reject) => {
        let webRequest = new WebRequest();
        webRequest.method = "POST";
        webRequest.uri = `${authorityUrl}/${tenantId}/oauth2/token/`;
        webRequest.body = querystring.stringify({
            resource: managementEndpointUrl,
            client_id: servicePrincipalId,
            grant_type: "client_credentials",
            client_secret: servicePrincipalKey
        });
        webRequest.headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
        };

        let webRequestOptions: WebRequestOptions = {
            retriableStatusCodes: [400, 408, 409, 500, 502, 503, 504],
        };

        sendRequest(webRequest, webRequestOptions).then(
            (response: WebResponse) => {
                if (response.statusCode == 200) {
                    resolve(response.body.access_token);
                }
                else if ([400, 401, 403].indexOf(response.statusCode) != -1) {
                    reject('ExpiredServicePrincipal');
                }
                else {
                    reject('CouldNotFetchAccessTokenforAzureStatusCode');
                }
            },
            (error) => {
                reject(error)
            }
        );
    });
}

function getAKSKubeconfig(azureSessionToken: string, subscriptionId: string, managementEndpointUrl: string): Promise<string> {
    let resourceGroupName = core.getInput('resource-group', { required: true });
    let clusterName = core.getInput('cluster-name', { required: true });
    return new Promise<string>((resolve, reject) => {
        var webRequest = new WebRequest();
        webRequest.method = 'GET';
        webRequest.uri = `${managementEndpointUrl}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ContainerService/managedClusters/${clusterName}/accessProfiles/clusterAdmin?api-version=2017-08-31`;
        webRequest.headers = {
            'Authorization': 'Bearer ' + azureSessionToken,
            'Content-Type': 'application/json; charset=utf-8'
        }
        sendRequest(webRequest).then((response: WebResponse) => {
            let accessProfile = response.body;
            if (accessProfile.properties && accessProfile.properties.kubeConfig) {
                var kubeconfig = Buffer.from(accessProfile.properties.kubeConfig, 'base64');
                resolve(kubeconfig.toString());
            } else {
                reject(JSON.stringify(response.body));
            }
        }).catch(reject);
    });
}

async function getKubeconfig(): Promise<string> {
    let creds = core.getInput('creds', { required: true });
    let credsObject: { [key: string]: string; };
    try {
        credsObject = JSON.parse(creds);
    } catch (ex) {
        throw new Error('Credentials object is not a valid JSON');
    }

    let servicePrincipalId = credsObject["clientId"];
    let servicePrincipalKey = credsObject["clientSecret"];
    let tenantId = credsObject["tenantId"];
    let authorityUrl = credsObject["activeDirectoryEndpointUrl"] || "https://login.microsoftonline.com";
    let managementEndpointUrl = credsObject["resourceManagerEndpointUrl"] || "https://management.azure.com/";
    let subscriptionId = credsObject["subscriptionId"];
    let azureSessionToken = await getAzureAccessToken(servicePrincipalId, servicePrincipalKey, tenantId, authorityUrl, managementEndpointUrl);
    let kubeconfig = await getAKSKubeconfig(azureSessionToken, subscriptionId, managementEndpointUrl);
    return kubeconfig;
}

async function setAksResourceContext() {
    let creds = core.getInput('creds', { required: true });
    let credsObject: { [key: string]: string; };
    try {
        credsObject = JSON.parse(creds);
    } catch (ex) {
        throw new Error('Credentials object is not a valid JSON');
    }

    let servicePrincipalId = credsObject["clientId"];
    let servicePrincipalKey = credsObject["clientSecret"];
    let tenantId = credsObject["tenantId"];
    let authorityUrl = credsObject["activeDirectoryEndpointUrl"] || "https://login.microsoftonline.com";
    let resourceManagerEndpointUrl = credsObject["resourceManagerEndpointUrl"] || "https://management.azure.com/";
    let managementEndpointUrl = credsObject["managementEndpointUrl"] || "https://management.azure.com/";
    let subscriptionId = credsObject["subscriptionId"];
    let azureSessionToken = await getAzureAccessToken(servicePrincipalId, servicePrincipalKey, tenantId, authorityUrl, resourceManagerEndpointUrl);
    let resourceGroupName = core.getInput('resource-group', { required: true });
    let clusterName = core.getInput('cluster-name', { required: true });

    let aksResourceContext: AksResourceContext = {
        subscriptionId: subscriptionId,
        resourceGroup: resourceGroupName,
        clusterName: clusterName,
        sessionToken: azureSessionToken,
        managementUrl: managementEndpointUrl
    };
    
    const runnerTempDirectory = process.env['RUNNER_TEMP']; // Using process.env until the core libs are updated
    const aksResourceContextPath = path.join(runnerTempDirectory, `aks-resource-context.json`);
    console.log(`Writing AKS resource context contents to ${aksResourceContextPath}`);
    fs.writeFileSync(aksResourceContextPath, JSON.stringify(aksResourceContext));
    fs.chmodSync(aksResourceContextPath, '600');
    console.log('AKS resource context exported.');
    
}

async function run() {
    let kubeconfig = await getKubeconfig();
    const runnerTempDirectory = process.env['RUNNER_TEMP']; // Using process.env until the core libs are updated
    const kubeconfigPath = path.join(runnerTempDirectory, `kubeconfig_${Date.now()}`);
    core.debug(`Writing kubeconfig contents to ${kubeconfigPath}`);
    fs.writeFileSync(kubeconfigPath, kubeconfig);
    fs.chmodSync(kubeconfigPath, '600');
    core.exportVariable('KUBECONFIG', kubeconfigPath);
    console.log('KUBECONFIG environment variable is set');
    
    await setAksResourceContext();
}

run().catch(core.setFailed);