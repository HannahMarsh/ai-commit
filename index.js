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
const MAX_DIFF_LENGTH = 10000; // Maximum characters for diff


console.log('Ai provider: ', AI_PROVIDER);

const ENDPOINT = args.ENDPOINT || process.env.ENDPOINT;
const language = args.language || process.env.AI_COMMIT_LANGUAGE || 'english';

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
    //console.log('prompting groq...\n' + input + "\n--------------------------------------\n");
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

    //console.log('prompting groq done!');
    const text = chatCompletion.choices[0]?.message?.content || "";
    //console.log('got response...\n' + text + "\n--------------------------------------\n");

    let responseText = text.trim();

    // Remove any unwanted prefixes from the response
    if (responseText.startsWith("Here ")) {
      const prefixToRemove = responseText.split("\n")[0];
      responseText = responseText.replace(prefixToRemove, "");
    }

    // Remove all double and single quotes and trim the response
    responseText = responseText.replaceAll(/["']/g, '').trim();
    responseText = responseText.replaceAll(/\*/g, '')

    let summary = responseText;
    let description = "";

    if(responseText.startsWith("Summary")){
      // Extract summary and description
      summary = responseText.split("Description: ")[0].replace("Summary:", '').trim();
      description = responseText.split("Description: ")[1]
    } else if(responseText.includes("\n\n")){
      summary = responseText.split("\n\n")[0].trim();
      description = responseText.split("\n\n")[1].trim();
    }


    // Return formatted summary and description
    return summary + "\n\n" + description;
}

const getPromptForSingleCommit = (diff) => {
  return (
    "Please act as the author of a git commit message. I will provide you with a git diff, and your task is to convert it into a detailed, informative commit message.\n"
    + "To help you understand the git diff output:\n\n"
    + "\t1. File Comparison Line: Shows the files being compared.\n"
    + "\t2. Index Line: Indicates the blob hashes before and after the change and the file mode.\n"
    + "\t3. File Change Markers: `---` shows the file before the change and `+++` shows the file after the change.\n"
    + "\t4. Hunk Header: Indicates the location and number of lines affected in the files.\n"
    + "\t   Example: `@@ -1,5 +1,7 @@` means the changes start at line 1 and cover 5 lines in the original file and start at line 1 and cover 7 lines in the new file.\n"
    + "\t5. Changes: Lines starting with `-` are removed lines. Lines starting with `+` are added lines. Some unchanged lines may be shown for context.\n\n"
    + "\tExample:\n"
    + "\t```diff\n"
    + "\tdiff --git a/file1.txt b/file1.txt\n"
    + "\tindex e69de29..d95f3ad 100644\n"
    + "\t--- a/file1.txt\n"
    + "\t+++ b/file1.txt\n"
    + "\t@@ -0,0 +1,2 @@\n"
    + "\t-This line was removed.\n"
    + "\t+This is a new line.\n"
    + "\t+Another new line.\n"
    + "\t```\n\n"
    + "Here's how you can structure your commit message:\n\n"
    + "Summary: <A concise, one-line sentence in the present tense that summarizes all changes (50 characters or less)>.\n"
    + "Description: <A detailed explanation of all changes in the past tense.> \n\n"
    + "Important:\n"
    + "\t1. The summary must be in the present tense, e.g., 'Fix login issue, edit variables,...'.\n"
    + "\t2. The description must be in the past tense, e.g., 'This change fixed a bug by...'.\n"
    + "\t3. Avoid prefacing your response with any additional text.\n"
    + "\t4. The summary and description should cover ALL changes and focus on the most important ones."
    + "Here is the git diff, which you are to convert into a commit message as described:\n\n"
    + diff
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

  let answer = await inquirer.prompt([
    {
      type: "list",
      name: "continue",
      message: "What do you want to do?",
      choices: ["   Continue", "   Regenerate", "   Abort"],
      default: 0,
    },
  ]);

  console.log("\r                                  \n                                     \n")

  if (answer.continue == "   Continue") {
    makeCommit(finalCommitMessage);
  } else if (answer.continue == "   Regenerate") {
    generateSingleCommit(diff)
  } else {
    console.log("Commit aborted by user 🙅‍♂️");
      process.exit(1);
  }
};

const filterDiff = (diff, ignorePatterns) => {
  const lines = diff.split('\n');
  const filteredLines = [];
  let skipBlock = false;

  lines.forEach(line => {
    if (ignorePatterns.some(pattern => {
      const regex = new RegExp(pattern.replace('*', '.*'));
      return regex.test(line);
    })) {
      skipBlock = true;
    }

    if (!skipBlock) {
      filteredLines.push(line);
    }

    if (line.startsWith('diff --git')) {
      skipBlock = false;
    }
  });

  return filteredLines.join('\n');
};

async function generateAICommit() {
  const isGitRepository = checkGitRepository();

  if (!isGitRepository) {
    console.error("This is not a git repository 🙅‍♂️");
    process.exit(1);
  }
  
  const diffObj = execSync("git diff --staged --ignore-space-change"); // Add the --ignore-space-change flag
  let diff = diffObj.toString();

  diff = diff.replace(/^\+[\s]*$/gm, '');
  diff = diff.replace(/\n[\s\n]*\n/gm, '\n');
diff = diff.replaceAll(/\*/gm, '')

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

  await generateSingleCommit(diff);
}

await generateAICommit();
