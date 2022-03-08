/*
Copyright 2022 David Baker

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as fs from "fs";

import { Octokit } from "@octokit/rest"
import { RestEndpointMethodTypes } from "@octokit/rest";
import * as yaml from "js-yaml";
import needle = require("needle");

interface BotConfig {
    githubToken: string;
    matrixRoomId: string;
}

interface AppConfig {
    matrixHsUrl: string;
    matrixAccessToken: string;
    accounts: Record<string, BotConfig>;
}

type GHNotification = RestEndpointMethodTypes["activity"]["listNotificationsForAuthenticatedUser"]["response"]["data"][number];

const API_PULL_URL_REGEX = /https:\/\/api.github.com\/repos\/(.+)\/(.+)\/pulls\/(\d+)/;
const API_ISSUE_URL_REGEX = /https:\/\/api.github.com\/repos\/(.+)\/(.+)\/issues\/(\d+)/;

function capFirst(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// "PullRequest" -> "Pull Request"
function camelSplit(s: string): string {
    let out = '';
    for (const c of s) {
        if (c === c.toUpperCase() && out.length > 0) {
            out += ' ';
        }
        out += c;
    }

    return out;
}

function fillAppCfgOrDie(item: "matrixHsUrl" | "matrixAccessToken", cfg: AppConfig): void {
    if (cfg[item] !== undefined) return;

    const fromEnv = process.env[item.toUpperCase()];
    if (fromEnv !== undefined) {
        cfg[item] = fromEnv;
        return;
    }

    console.log(`${item} not found`);
    process.exit(1);
}

function fillBotCfgOrDie(item: keyof BotConfig, account: string, cfg: BotConfig): void {
    if (cfg[item] !== undefined) return;

    const fromEnv = process.env[(account + '_' + item).toUpperCase()];
    if (fromEnv !== undefined) {
        cfg[item] = fromEnv;
        return;
    }

    console.log(`${item} not found for account ${account}`);
    process.exit(1);
}

async function main() {
    const appCfg = yaml.load(fs.readFileSync("config.yaml", "utf8")) as AppConfig;

    fillAppCfgOrDie('matrixHsUrl', appCfg);
    fillAppCfgOrDie('matrixAccessToken', appCfg);

    if (appCfg.accounts === undefined || Object.keys(appCfg.accounts).length === 0) {
        console.log("No accounts configured");
        process.exit(1);
    }

    let hsUrl = appCfg.matrixHsUrl;
    if (hsUrl.substring(hsUrl.length, hsUrl.length - 1) === '/') {
        hsUrl = hsUrl.substring(0, hsUrl.length - 1);
    }
    appCfg.matrixHsUrl = hsUrl;

    const whoamiResp = await needle(
        'get',
        `${appCfg.matrixHsUrl}/_matrix/client/v3/account/whoami`,
        {
            parse: true,
            headers: {
                authorization: "Bearer " + appCfg.matrixAccessToken,
            }
        }
    );

    const userId = whoamiResp.body.user_id;
    console.log("Operating as " + userId);

    const bots = [];

    for (const [account, botCfg] of Object.entries(appCfg.accounts)) {
        bots.push(makeBot(account, userId, appCfg, botCfg));
    }

    await Promise.all(bots.map(b => b.run()));
}

function makeBot(account: string, botMxid: string, appCfg: AppConfig, botCfg: BotConfig) {
    fillBotCfgOrDie('githubToken', account, botCfg);
    fillBotCfgOrDie('matrixRoomId', account, botCfg);    

    return new NotifBot(botMxid, appCfg, botCfg);
}

class NotifBot {
    private octo: Octokit;

    constructor(private botMxid: string, private appCfg: AppConfig, private botCfg: BotConfig) {
        this.octo = new Octokit({
            auth: botCfg.githubToken,
        });
    }

    async getLatestPostedNotifTs(): Promise<string | undefined> {
        const encodedRoomId = encodeURIComponent(this.botCfg.matrixRoomId);
        const resp = await needle(
            'get',
            `${this.appCfg.matrixHsUrl}/_matrix/client/v3/rooms/${encodedRoomId}/messages?dir=b`,
            {
                parse: true,
                headers: {
                    authorization: "Bearer " + this.appCfg.matrixAccessToken,
                }
            }
        );

        const messages = resp.body.chunk;

        for (const msg of messages) {
            if (msg.sender != this.botMxid) continue;
            if (msg.type != 'm.room.message') continue;

            const ghTs = msg.content?.gh_last_mod;

            if (ghTs) {
                console.log("Found last notification with ts " + ghTs);
                return ghTs;
            }
        }

        return undefined;
    }

    async getHtmlUrl(apiUrl: string): Promise<string> {
        // github gives the api urls for entities in the response for some reason,
        // but not the HTML URLs, and you can't directly translate between the two.
        // We pick out some special cases and then for the rest, fetch the API URL
        // and get it that way (although we won't be able to do this for private
        // repos if our access token doesn't have the right scope).

        const pullMatch = apiUrl.match(API_PULL_URL_REGEX)
        const issueMatch = apiUrl.match(API_ISSUE_URL_REGEX);

        if (pullMatch) {
            return `https://github.com/${pullMatch[1]}/${pullMatch[2]}/pull/${pullMatch[3]}`;
        } else if (issueMatch) {
            return `https://github.com/${issueMatch[1]}/${issueMatch[2]}/issues/${issueMatch[3]}`;
        }

        const resp = await this.octo.request(apiUrl);
        return resp.data.html_url;
    }

    async bodyForNotif(notif: GHNotification, html: boolean): Promise<string> {
        if (!notif.subject.url) {
            console.log("No url: ", notif);
        }

        let title = camelSplit(notif.subject.type);
        if (html) {
            const link = await this.getHtmlUrl(notif.subject.url);
            title = `<a href="${link}">${title}</a>`;
        }

        let formattedReason = capFirst(notif.reason.replace('_', ' '));

        const urlParts = notif.subject.url.split('/');
        const thingNumber = urlParts[urlParts.length - 1];

        let body = `${title} ${notif.repository.name} #${thingNumber}: ` +
            `${notif.subject.title} (${formattedReason})`;

        return body;
    }

    async processNotif(notif: GHNotification, lastMod: string): Promise<void> {
        const encodedRoomId = encodeURIComponent(this.botCfg.matrixRoomId);
        console.log(`Sending message for notif ID ${notif.id}`);
        const resp = await needle(
            'put',
            `${this.appCfg.matrixHsUrl}/_matrix/client/r0/rooms/` +
            `${encodedRoomId}/send/m.room.message/${notif.id}${Date.parse(notif.updated_at)}`,
            {
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                gh_last_mod: lastMod,
                body: await this.bodyForNotif(notif, false),
                formatted_body: await this.bodyForNotif(notif, true),
            },
            {
                headers: {
                    authorization: "Bearer " + this.appCfg.matrixAccessToken,
                },
                json: true,
            }
        );
        if (resp.statusCode / 100 != 2) {
            console.log(`Request failed with status ${resp.statusCode} ${resp.body}`);
        }
    }

    async run() {
        let lastModified = await this.getLatestPostedNotifTs();

        while (true) {
            try {
                const headers = {} as Record<string, string>;
                if (lastModified !== undefined) {
                    console.log(`Polling with if-modified-since: ${lastModified}`);
                    headers["If-Modified-Since"] = lastModified;
                }

                let respHeaders;
                try {
                    const resp = await this.octo.rest.activity.listNotificationsForAuthenticatedUser({
                        headers,
                    });

                    respHeaders = resp.headers;

                    if (lastModified == undefined) {
                        lastModified = resp.headers["last-modified"];
                        console.log(
                            `No previous notification: ignoring ${resp.data.length} notifs ` +
                            `and starting from ${lastModified}`
                        );
                    } else {
                        if (resp.data.length === 0) {
                            // shouldn't happen because we should get a 304 Not Modified
                            console.log("No notifs (this probably shouldn't happen)");
                        }

                        const lastModifiedDate = new Date(lastModified);

                        for (let i = resp.data.length - 1; i >= 0; i--) {
                            const notif = resp.data[i];
                            const updatedAtDate = new Date(notif.updated_at);

                            if (updatedAtDate > lastModifiedDate) {
                                console.log(
                                    `Processing notif ID ${notif.id}, ` +
                                    `updated at ${notif.updated_at}`,
                                );
                                await this.processNotif(notif, resp.headers["last-modified"]);
                            }
                        }
                        lastModified = resp.headers["last-modified"];
                    }
                } catch (e) {
                    if (e.status === 304) {
                        console.log("Not modified");
                        respHeaders = e.response.headers;
                    } else {
                        throw e;
                    }
                }

                const pollInterval = Math.max(respHeaders["x-poll-interval"] ?? 60, 60);
                //console.log(notifs);

                console.log("Polling again in " + pollInterval);
                await new Promise(resolve => {
                    setTimeout(resolve, pollInterval * 1000);
                });
            } catch (e) {
                console.log("Error whilst polling. Trying again in 60 secs", e);
                await new Promise(resolve => {
                    setTimeout(resolve, 60 * 1000);
                });
            }
        }
    }
}

main()
