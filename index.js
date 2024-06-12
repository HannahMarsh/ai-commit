#!/usr/bin/env node
'use strict'

import { execSync } from "child_process";
import { ChatGPTAPI } from "chatgpt";
import Groq from "groq-sdk";
import inquirer from "inquirer";
import { getArgs, checkGitRepository } from "./helpers.js";
import { addGitmojiToCommitMessage } from './gitmoji.js';
import { filterApi } from "./filterApi.js";
import { AI_PROVIDER, MODEL, args } from "./config.js";
import fs from 'fs';
import path from 'path';

const REGENERATE_MSG = "♻️ Regenerate Commit Messages";
// const MAX_DIFF_SIZE = 50 * 1024 * 1024; // Set a reasonable size limit for diffs (e.g., 10MB)
const MAX_DIFF_LENGTH = 4000; // Maximum characters for diff


console.log('Ai provider: ', AI_PROVIDER);

const ENDPOINT = args.ENDPOINT || process.env.ENDPOINT;
const language = args.language || process.env.AI_COMMIT_LANGUAGE || 'english';

if (AI_PROVIDER == 'openai' && !(args.apiKey || process.env.OPENAI_API_KEY)) {
  console.error("Please set the OPENAI_API_KEY environment variable.");
  process.exit(1);
}

let template = args.template || process.env.AI_COMMIT_COMMIT_TEMPLATE;
const doAddEmoji = args.emoji || process.env.AI_COMMIT_ADD_EMOJI;
const commitType = args['commit-type'];

const processTemplate = ({ template, commitMessage }) => {
  if (!template.includes('COMMIT_MESSAGE')) {
    console.log(`Warning: template doesn't include {COMMIT_MESSAGE}`);
    return commitMessage;
  }

  let finalCommitMessage = template.replaceAll("{COMMIT_MESSAGE}", commitMessage);

  if (finalCommitMessage.includes('GIT_BRANCH')) {
    const currentBranch = execSync("git branch --show-current").toString().replaceAll("\n", "");
    console.log('Using currentBranch: ', currentBranch);
    finalCommitMessage = finalCommitMessage.replaceAll("{GIT_BRANCH}", currentBranch);
  }

  return finalCommitMessage;
}

const makeCommit = (input) => {
  try {
    console.log("Committing Message... 🚀 ");
    execSync(`git commit -F -`, { input });
    console.log("Commit Successful! 🎉");
  } catch (error) {
    console.error("Error during commit:");
    console.error(error.message);
    console.error("stdout:", error.stdout ? error.stdout.toString() : "N/A");
    console.error("stderr:", error.stderr ? error.stderr.toString() : "N/A");
    process.exit(1);
  }
};

const processEmoji = (msg, doAddEmoji) => {
  if (doAddEmoji) {
    return addGitmojiToCommitMessage(msg);
  }
  return msg;
}

/**
 * send prompt to ai.
 */
const sendMessage = async (input) => {
  if (AI_PROVIDER == 'ollama') {
    const model = MODEL || 'mistral';
    const url = 'http://localhost:11434/api/generate';
    const data = {
      model,
      prompt: input,
      stream: false
    };
    console.log('prompting ollama...', url, model);
    try {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(data),
        headers: {
          "Content-Type": "application/json",
        },
      });
      const responseJson = await response.json();
      const answer = responseJson.response;
      console.log('response: ', answer);
      console.log('prompting ai done!');
      return answer;
    } catch (err) {
      throw new Error('local model issues. details:' + err.message);
    }
  }

  if (AI_PROVIDER == 'groq') {
    console.log('prompting groq...');
    const groq = new Groq({ apiKey: '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' });
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: input,
        },
      ],
      model: "llama3-8b-8192",
    });

    console.log('prompting groq done!');
    const text = chatCompletion.choices[0]?.message?.content || "";
    console.log(text);

    let responseText = text;

    // Remove any unwanted prefixes from the response
    const prefixToRemove = "Here is a 10-word commit message summarizing the changes:";
    if (responseText.startsWith(prefixToRemove)) {
      responseText = responseText.replace(prefixToRemove, "").trim();
    }

    // Remove quotes from the start and end if present
    if (responseText.startsWith("\"") && responseText.endsWith("\"")) {
      responseText = responseText.substring(1).trim();
      responseText = responseText.slice(0, -1).trim();
    }

    return responseText;
  }

  if (AI_PROVIDER == 'openai') {
    console.log('prompting chat gpt...');
    const api = new ChatGPTAPI({ apiKey: args.apiKey || process.env.OPENAI_API_KEY });
    const { text } = await api.sendMessage(input);
    console.log('prompting ai done!');
    return text;
  }
}

const getPromptForSingleCommit = (diff) => {
  if (AI_PROVIDER == "openai" || AI_PROVIDER == "grok") {
    return (
      "I want you to act as the author of a commit message in git."
      + `I'll enter a git diff, and your job is to convert it into a useful commit message in ${language} language`
      + (commitType ? ` with commit type '${commitType}'. ` : ". ")
      + "Do not preface the commit with anything, use the present tense, return the full sentence, and use the conventional commits specification (<type in lowercase>: <subject>): "
      + diff
    );
  }
  return (
    "Summarize this git diff into a useful, 10 words commit message"
    + (commitType ? ` with commit type '${commitType}.'` : "")
    + ": " + diff
  );
};

const generateSingleCommit = async (diff) => {
  const prompt = getPromptForSingleCommit(diff);

  if (!await filterApi({ prompt, filterFee: args['filter-fee'] })) process.exit(1);

  const text = await sendMessage(prompt);
  let finalCommitMessage = processEmoji(text, args.emoji);

  if (args.template) {
    finalCommitMessage = processTemplate({
      template: args.template,
      commitMessage: finalCommitMessage,
    });

    console.log(
      `Proposed Commit With Template:\n------------------------------\n${finalCommitMessage}\n------------------------------`
    );
  } else {
    console.log(
      `Proposed Commit:\n------------------------------\n${finalCommitMessage}\n------------------------------`
    );
  }

  if (args.force) {
    makeCommit(finalCommitMessage);
    return;
  }

  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "continue",
      message: "Do you want to continue?",
      default: true,
    },
  ]);

  if (!answer.continue) {
    console.log("Commit aborted by user 🙅‍♂️");
    process.exit(1);
  }

  makeCommit(finalCommitMessage);
};

const generateListCommits = async (diff, numOptions = 5) => {
  const prompt =
    "I want you to act as the author of a commit message in git."
    + `I'll enter a git diff, and your job is to convert it into a useful commit message in ${language} language`
    + (commitType ? ` with commit type '${commitType}.', ` : ", ")
    + `and make ${numOptions} options that are separated by ";".`
    + "For each option, use the present tense, return the full sentence, and use the conventional commits specification (<type in lowercase>: <subject>):"
    + diff;

  if (!await filterApi({ prompt, filterFee: args['filter-fee'], numCompletion: numOptions })) process.exit(1);

  const text = await sendMessage(prompt);
  let msgs = text.split(";").map((msg) => msg.trim()).map(msg => processEmoji(msg, args.emoji));

  if (args.template) {
    msgs = msgs.map(msg => processTemplate({
      template: args.template,
      commitMessage: msg,
    }));
  }

  msgs.push(REGENERATE_MSG);

  const answer = await inquirer.prompt([
    {
      type: "list",
      name: "commit",
      message: "Select a commit message",
      choices: msgs,
    },
  ]);

  if (answer.commit === REGENERATE_MSG) {
    await generateListCommits(diff);
    return;
  }

  makeCommit(answer.commit);
};

const filterDiff = (diff, ignorePatterns) => {
  const lines = diff.split('\n');
  const filteredLines = lines.filter(line => {
    for (const pattern of ignorePatterns) {
      const regex = new RegExp(pattern.replace('*', '.*'));
      if (regex.test(line)) {
        return false;
      }
    }
    return true;
  });
  return filteredLines.join('\n');
};

async function generateAICommit() {
  const isGitRepository = checkGitRepository();

  if (!isGitRepository) {
    console.error("This is not a git repository 🙅‍♂️");
    process.exit(1);
  }

  // Increase the buffer size to handle large diffs
  let diff = execSync("git diff --staged").toString(); //execSync("git diff --staged", { maxBuffer: MAX_DIFF_SIZE }).toString();

  // Truncate the diff if it's too large
  if (diff.length > MAX_DIFF_LENGTH) {
    diff = diff.substring(0, MAX_DIFF_LENGTH) + '\n... [diff truncated]';
  }

  if (!diff) {
    console.log("No changes to commit 🙅");
    console.log(
      "May be you forgot to add the files? Try git add . and then run this script again."
    );
    process.exit(1);
  }

  // Read and parse the .ai-commit.json configuration file
  const configPath = path.resolve(process.cwd(), '.ai-commit.json');
  let ignorePatterns = [];
  if (fs.existsSync(configPath)) {
    const configFile = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configFile);
    ignorePatterns = config.ignore || [];
  }

  // Filter the diff
  const filteredDiff = filterDiff(diff, ignorePatterns).trim();

  // Handle empty diff after filtering
  if (!filteredDiff) {
    console.log("No relevant changes to commit after applying ignore patterns 🙅");
  } else {
    diff = filteredDiff
  }

  args.list
    ? await generateListCommits(diff)
    : await generateSingleCommit(diff);
}

await generateAICommit();
