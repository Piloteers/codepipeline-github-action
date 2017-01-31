import "babel-polyfill";
import * as aws from "aws-sdk";
import * as awslambda from "aws-lambda";
import * as https from "https";
import {CodePipelineEvent} from "./CodePipelineEvent";

const creds = new aws.EnvironmentCredentials("AWS");
const codepipeline = new aws.CodePipeline({
    apiVersion: "2015-07-09",
    credentials: creds
});
const kms = new aws.KMS({
    apiVersion: "2014-11-01",
    credentials: creds
});

//noinspection JSUnusedGlobalSymbols
export function handler(evt: CodePipelineEvent, ctx: awslambda.Context, callback: awslambda.Callback): void {
    console.log("event", JSON.stringify(evt, null, 2));
    handlerAsync(evt, ctx)
        .then(res => {
            callback(undefined, res);
        }, err => {
            console.error(JSON.stringify(err, null, 2));
            callback(err);
        });
}

async function handlerAsync(evt: CodePipelineEvent, ctx: awslambda.Context): Promise<any> {
    const jobId = evt["CodePipeline.job"].id;

    try {
        checkConfig();
    } catch (err) {
        console.error(err);
        await codepipeline.putJobFailureResult({
            jobId: jobId,
            failureDetails: {
                type: "ConfigurationError",
                message: err.message,
                externalExecutionId: ctx.awsRequestId
            }
        }).promise();
        return;
    }

    try {
        await pushGithub();
        console.log("job success");
        await codepipeline.putJobSuccessResult({
            jobId: jobId
        }).promise();
    } catch (err) {
        console.error(err);
        await codepipeline.putJobFailureResult({
            jobId: jobId,
            failureDetails: {
                type: "JobFailed",
                message: err.message,
                externalExecutionId: ctx.awsRequestId
            }
        }).promise();
    }
    return {};
}

async function pushGithub(): Promise<void> {
    const oauthToken = await getGithubOauthToken();

    const createPath = `/repos/${process.env["GITHUB_REPO_OWNER"]}/${process.env["GITHUB_REPO"]}/pulls`;
    const createBody = {
        title: "Automatic pull request by CI",
        head: process.env["GITHUB_SOURCE_BRANCH"],  // src
        base: process.env["GITHUB_DEST_BRANCH"]     // dest
    };
    console.log("create pull request", createPath, createBody);
    const createResp = await request(createPath, "POST", oauthToken, createBody);
    console.log("createResp", createResp);

    const mergePath = `/repos/${process.env["GITHUB_REPO_OWNER"]}/${process.env["GITHUB_REPO"]}/pulls/${createResp.number}/merge`;
    const mergeBody = {
        "commit_message": "Automatic merge by CI"
    };
    console.log("merge pull request", mergePath, mergeBody);
    const mergeResp = await request(mergePath, "PUT", oauthToken, mergeBody);
    console.log("mergeResp", mergeResp);
}

async function getGithubOauthToken(): Promise<string> {
    const response = await kms.decrypt({
        CiphertextBlob: new Buffer(process.env["GITHUB_OAUTH"], "base64")
    }).promise();
    return (response.Plaintext as Buffer).toString("ascii");
}

/**
 * All the libaries suck.  Make this github api reequest manually.
 */
function request(path: string, method: string, oauthToken: string, body?: Object): Promise<any> {
    const bodyJson = JSON.stringify(body);
    const options: https.RequestOptions = {
        hostname: "api.github.com",
        port: 443,
        path: path,
        method: method,
        headers: {
            "Authorization": `token ${oauthToken}`,
            "Accept": "application/json",
            "User-Agent": "Giftbit/lambda-github-pusher"
        }
    };

    if (body) {
        options.headers["Content-Length"] = bodyJson.length;
        options.headers["Content-Type"] = "application/json"
    }

    return new Promise((resolve, reject) => {
        const request = https.request(options, (response) => {
            console.log(`response.statusCode ${response.statusCode}`);
            console.log(`response.headers ${JSON.stringify(response.headers)}`);

            const responseBody: string[] = [];
            response.setEncoding("utf8");
            response.on("data", d => {
                responseBody.push(d as string);
            });
            response.on("end", () => {
                if (response.statusCode >= 400) {
                    console.log("response error", responseBody);
                    reject(new Error(responseBody.join("")));
                } else {
                    try {
                        const responseJson = JSON.parse(responseBody.join(""));
                        resolve(responseJson);
                    } catch (e) {
                        reject(e);
                    }
                }
            });
        });

        request.on("error", error => {
            console.log("request error", error);
            reject(error);
        });

        if (body) {
            request.write(bodyJson);
        }
        request.end();
    });
}

function checkConfig(): void {
    if (!process.env["GITHUB_REPO_OWNER"]) {
        throw new Error("Missing environment variable GITHUB_REPO_OWNER");
    }
    if (!process.env["GITHUB_REPO"]) {
        throw new Error("Missing environment variable GITHUB_REPO");
    }
    if (!process.env["GITHUB_SOURCE_BRANCH"]) {
        throw new Error("Missing environment variable GITHUB_SOURCE_BRANCH");
    }
    if (!process.env["GITHUB_DEST_BRANCH"]) {
        throw new Error("Missing environment variable GITHUB_DEST_BRANCH");
    }
}
