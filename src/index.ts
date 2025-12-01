import * as core from '@actions/core';

async function run() {
    try {
        const name = core.getInput('name');
        core.info(`Hello, ${name}! Your TypeScript action is running.`);
    } catch (error: any) {
        core.setFailed(error.message);
    }
}

run();
