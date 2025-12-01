// Copyright 2023 Google LLC
// Modified for Gitea support
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

const DEFAULT_CONFIG_FILE = 'release-please-config.json';
const DEFAULT_MANIFEST_FILE = '.release-please-manifest.json';

interface Proxy {
    host: string;
    port: number;
}

interface ActionInputs {
    token: string;
    repoUrl: string;
    releaseType?: string;
    path?: string;
    giteaApiUrl: string;
    configFile?: string;
    manifestFile?: string;
    proxyServer?: string;
    targetBranch: string;
    skipGiteaRelease?: boolean;
    skipGiteaPullRequest?: boolean;
    skipLabeling?: boolean;
    includeComponentInTag?: boolean;
    changelogHost: string;
    versioningStrategy?: string;
    releaseAs?: string;
    giteaOwner: string;
    giteaRepo: string;
}

interface Release {
    id?: number;
    tagName: string;
    name: string;
    body: string;
    draft?: boolean;
    prerelease?: boolean;
    path: string;
    version?: string;
    major?: number;
    minor?: number;
    patch?: number;
    sha?: string;
    url?: string;
    uploadUrl?: string;
}

interface PullRequest {
    number: number;
    title: string;
    body: string;
    headBranchName: string;
    baseBranchName: string;
    url: string;
    labels?: string[];
}

function parseInputs(): ActionInputs {
    const inputs: ActionInputs = {
        token: core.getInput('token', { required: true }),
        releaseType: getOptionalInput('release-type'),
        path: getOptionalInput('path'),
        repoUrl: core.getInput('repo-url') || '',
        targetBranch: getOptionalInput('target-branch') || 'main',
        configFile: core.getInput('config-file') || DEFAULT_CONFIG_FILE,
        manifestFile: core.getInput('manifest-file') || DEFAULT_MANIFEST_FILE,
        giteaApiUrl: core.getInput('gitea-api-url', { required: true }),
        proxyServer: getOptionalInput('proxy-server'),
        skipGiteaRelease: getOptionalBooleanInput('skip-gitea-release'),
        skipGiteaPullRequest: getOptionalBooleanInput('skip-gitea-pull-request'),
        skipLabeling: getOptionalBooleanInput('skip-labeling'),
        includeComponentInTag: getOptionalBooleanInput('include-component-in-tag'),
        changelogHost: core.getInput('changelog-host') || '',
        versioningStrategy: getOptionalInput('versioning-strategy'),
        releaseAs: getOptionalInput('release-as'),
        giteaOwner: core.getInput('gitea-owner', { required: true }),
        giteaRepo: core.getInput('gitea-repo', { required: true }),
    };
    return inputs;
}

function getOptionalInput(name: string): string | undefined {
    return core.getInput(name) || undefined;
}

function getOptionalBooleanInput(name: string): boolean | undefined {
    const val = core.getInput(name);
    if (val === '' || val === undefined) {
        return undefined;
    }
    return core.getBooleanInput(name);
}

class GiteaClient {
    private octokit: Octokit;
    private owner: string;
    private repo: string;
    private baseUrl: string;

    constructor(token: string, baseUrl: string, owner: string, repo: string) {
        this.owner = owner;
        this.repo = repo;
        this.baseUrl = baseUrl.replace(/\/api\/v1$/, '');

        // Gitea uses a GitHub-compatible API, so we can use Octokit
        this.octokit = new Octokit({
            auth: token,
            baseUrl: `${this.baseUrl}/api/v1`,
        });
    }

    async createRelease(release: Release): Promise<Release> {
        try {
            const response = await this.octokit.repos.createRelease({
                owner: this.owner,
                repo: this.repo,
                tag_name: release.tagName,
                name: release.name,
                body: release.body,
                draft: release.draft || false,
                prerelease: release.prerelease || false,
            });

            return {
                ...release,
                id: response.data.id,
                url: response.data.html_url,
                uploadUrl: response.data.upload_url,
            };
        } catch (error) {
            core.error(`Failed to create release: ${error}`);
            throw error;
        }
    }

    async createPullRequest(pr: PullRequest): Promise<PullRequest> {
        try {
            const response = await this.octokit.pulls.create({
                owner: this.owner,
                repo: this.repo,
                title: pr.title,
                body: pr.body,
                head: pr.headBranchName,
                base: pr.baseBranchName,
            });

            // Add labels if provided and labeling is not skipped
            if (pr.labels && pr.labels.length > 0) {
                await this.octokit.issues.addLabels({
                    owner: this.owner,
                    repo: this.repo,
                    issue_number: response.data.number,
                    labels: pr.labels,
                });
            }

            return {
                ...pr,
                number: response.data.number,
                url: response.data.html_url,
            };
        } catch (error) {
            core.error(`Failed to create pull request: ${error}`);
            throw error;
        }
    }

    async getLatestRelease(): Promise<{ tag_name: string } | null> {
        try {
            const response = await this.octokit.repos.getLatestRelease({
                owner: this.owner,
                repo: this.repo,
            });
            return { tag_name: response.data.tag_name };
        } catch (error) {
            // No releases found
            return null;
        }
    }

    async listCommits(sha: string | undefined, perPage: number = 100): Promise<any[]> {
        try {
            const params: any = {
                owner: this.owner,
                repo: this.repo,
                per_page: perPage,
            };
            if (sha !== undefined) {
                params.sha = sha;
            }
            const response = await this.octokit.repos.listCommits(params);
            return response.data;
        } catch (error) {
            core.error(`Failed to list commits: ${error}`);
            throw error;
        }
    }

    async getBranch(branch: string): Promise<any> {
        try {
            const response = await this.octokit.repos.getBranch({
                owner: this.owner,
                repo: this.repo,
                branch,
            });
            return response.data;
        } catch (error) {
            core.error(`Failed to get branch: ${error}`);
            throw error;
        }
    }

    async createOrUpdateFile(
        path: string,
        message: string,
        content: string,
        branch: string,
        sha: string | undefined
    ): Promise<void> {
        try {
            const params: any = {
                owner: this.owner,
                repo: this.repo,
                path,
                message,
                content: Buffer.from(content).toString('base64'),
                branch,
            };
            if (sha !== undefined) {
                params.sha = sha;
            }
            await this.octokit.repos.createOrUpdateFileContents(params);
        } catch (error) {
            core.error(`Failed to create or update file: ${error}`);
            throw error;
        }
    }

    async createRef(ref: string, sha: string): Promise<void> {
        try {
            await this.octokit.git.createRef({
                owner: this.owner,
                repo: this.repo,
                ref: `refs/heads/${ref}`,
                sha,
            });
        } catch (error) {
            core.error(`Failed to create ref: ${error}`);
            throw error;
        }
    }
}

async function determineNextVersion(
    client: GiteaClient,
    versioningStrategy?: string
): Promise<string> {
    const latestRelease = await client.getLatestRelease();

    if (!latestRelease) {
        return '1.0.0';
    }

    const currentVersion = latestRelease.tag_name.replace(/^v/, '');
    const versionParts = currentVersion.split('.').map(Number);
    const major = versionParts[0] || 0;
    const minor = versionParts[1] || 0;
    const patch = versionParts[2] || 0;

    switch (versioningStrategy) {
        case 'always-bump-major':
            return `${major + 1}.0.0`;
        case 'always-bump-minor':
            return `${major}.${minor + 1}.0`;
        case 'always-bump-patch':
        default:
            return `${major}.${minor}.${patch + 1}`;
    }
}

async function generateChangelog(
    client: GiteaClient,
    fromTag: string | null,
    toSha: string
): Promise<string> {
    const commits = await client.listCommits(toSha, 100);

    let changelog = '## Changes\n\n';

    for (const commit of commits) {
        if (fromTag && commit.sha === fromTag) {
            break;
        }

        const message = commit.commit.message.split('\n')[0];
        changelog += `* ${message} (${commit.sha.substring(0, 7)})\n`;
    }

    return changelog;
}

export async function main() {
    try {
        const inputs = parseInputs();
        const client = new GiteaClient(
            inputs.token,
            inputs.giteaApiUrl,
            inputs.giteaOwner,
            inputs.giteaRepo
        );

        core.info('Starting Gitea release-please process');

        if (!inputs.skipGiteaRelease) {
            core.info('Creating release');

            const nextVersion = inputs.releaseAs ||
                await determineNextVersion(client, inputs.versioningStrategy);

            const branch = await client.getBranch(inputs.targetBranch);
            const latestRelease = await client.getLatestRelease();

            const changelog = await generateChangelog(
                client,
                latestRelease?.tag_name || null,
                branch.commit.sha
            );

            const tagName = inputs.includeComponentInTag && inputs.path
                ? `${inputs.path}-v${nextVersion}`
                : `v${nextVersion}`;

            const release: Release = {
                tagName,
                name: `Release ${nextVersion}`,
                body: changelog,
                draft: false,
                prerelease: false,
                path: inputs.path || '.',
                version: nextVersion,
            };

            const createdRelease = await client.createRelease(release);
            outputReleases([createdRelease]);
        }

        if (!inputs.skipGiteaPullRequest) {
            core.info('Creating pull request');

            const nextVersion = inputs.releaseAs ||
                await determineNextVersion(client, inputs.versioningStrategy);

            const branch = await client.getBranch(inputs.targetBranch);
            const releaseBranchName = `release-please--${inputs.targetBranch}--${nextVersion}`;

            try {
                await client.createRef(releaseBranchName, branch.commit.sha);
            } catch (error) {
                core.warning(`Branch ${releaseBranchName} may already exist`);
            }

            const pr: PullRequest = {
                number: 0,
                title: `chore: release ${nextVersion}`,
                body: `Release ${nextVersion}\n\nThis PR was generated by release-please for Gitea.`,
                headBranchName: releaseBranchName,
                baseBranchName: inputs.targetBranch,
                url: '',
                labels: inputs.skipLabeling ? [] : ['autorelease: pending'],
            };

            const createdPR = await client.createPullRequest(pr);
            outputPRs([createdPR]);
        }

        core.info('Release-please process completed successfully');
    } catch (error) {
        core.setFailed(`release-please failed: ${error}`);
    }
}

function setPathOutput(path: string, key: string, value: string | boolean | number) {
    if (path === '.') {
        core.setOutput(key, value);
    } else {
        core.setOutput(`${path}--${key}`, value);
    }
}

function outputReleases(releases: (Release | undefined)[]) {
    releases = releases.filter(release => release !== undefined);
    const pathsReleased = [];
    core.setOutput('releases_created', releases.length > 0);

    if (releases.length) {
        for (const release of releases) {
            if (!release) {
                continue;
            }
            const path = release.path || '.';
            if (path) {
                pathsReleased.push(path);
                setPathOutput(path, 'release_created', true);
            }
            for (const [rawKey, value] of Object.entries(release)) {
                let key = rawKey;
                if (key === 'tagName') key = 'tag_name';
                if (key === 'uploadUrl') key = 'upload_url';
                if (key === 'body') key = 'body';
                if (key === 'url') key = 'html_url';
                if (value !== undefined) {
                    setPathOutput(path, key, value);
                }
            }
        }
    }

    core.setOutput('paths_released', JSON.stringify(pathsReleased));
}

function outputPRs(prs: (PullRequest | undefined)[]) {
    prs = prs.filter(pr => pr !== undefined);
    core.setOutput('prs_created', prs.length > 0);

    if (prs.length) {
        core.setOutput('pr', prs[0]);
        core.setOutput('prs', JSON.stringify(prs));
    }
}

if (require.main === module) {
    main().catch(err => {
        core.setFailed(`release-please failed: ${err.message}`)
    })
}