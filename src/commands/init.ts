import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { configExists, writeConfig, readConfig } from "../utils/config.js";
import { normalizeRedactionPath } from "../utils/redaction.js";
import { writeReadme, writeGitkeep } from "../utils/git.js";
import { generateReadme } from "../output/readme.js";
import { runSync } from "./sync.js";
import { fetchUserRank, syncProfileToConvex } from "../utils/api.js";
import { renderBadge } from "../output/badge.js";
import { copyToClipboard } from "../utils/clipboard.js";
import { generateOutputData, toPublicOutputData } from "../output/generator.js";
import { promptAndInstallSchedule } from "./schedule.js";

function checkGhCli(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkGhAuth(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function runInit(): Promise<void> {
  console.log(chalk.bold("\nClog - Claude Code Stats\n"));

  // Check if already initialized
  if (configExists()) {
    const config = readConfig();
    console.log(
      chalk.yellow(
        `Already initialized for user ${chalk.bold(config?.username)}`
      )
    );
    console.log(chalk.dim(`Config: ~/.claude/clog.json`));
    console.log(chalk.dim(`Repo: ${config?.repoPath}`));

    const { reinit } = await inquirer.prompt<{ reinit: boolean }>([
      {
        type: "confirm",
        name: "reinit",
        message: "Do you want to reinitialize?",
        default: false,
      },
    ]);

    if (!reinit) {
      return;
    }
  }

  // Check gh CLI
  if (!checkGhCli()) {
    console.log(chalk.red("GitHub CLI (gh) is not installed."));
    console.log(chalk.dim("Install it from: https://cli.github.com/"));
    process.exit(1);
  }

  // Check gh auth
  if (!checkGhAuth()) {
    console.log(chalk.red("GitHub CLI is not authenticated."));
    console.log(chalk.dim("Run: gh auth login"));
    process.exit(1);
  }

  // Get username
  const { username } = await inquirer.prompt<{ username: string }>([
    {
      type: "input",
      name: "username",
      message: "GitHub username:",
      validate: (input: string) => {
        const trimmed = input.trim();
        if (trimmed.length === 0) return "Username is required";
        if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(trimmed))
          return "Invalid GitHub username (letters, numbers, and hyphens only)";
        return true;
      },
    },
  ]);

  // Get repo name
  const { repoName } = await inquirer.prompt<{ repoName: string }>([
    {
      type: "input",
      name: "repoName",
      message: "Repository name:",
      default: "clog",
      validate: (input: string) =>
        /^[a-zA-Z0-9._-]+$/.test(input.trim()) || "Invalid repository name",
    },
  ]);

  const defaultRepoPath = path.join(os.homedir(), ".clog", "repo");

  const { repoPath } = await inquirer.prompt<{ repoPath: string }>([
    {
      type: "input",
      name: "repoPath",
      message: "Local repo path:",
      default: defaultRepoPath,
    },
  ]);

  const { wantsRedaction } = await inquirer.prompt<{ wantsRedaction: boolean }>([
    {
      type: "confirm",
      name: "wantsRedaction",
      message: "Do you want to redact any project directories?",
      default: false,
    },
  ]);

  let redactedProjects: string[] = [];
  if (wantsRedaction) {
    const { redactionInput } = await inquirer.prompt<{ redactionInput: string }>([
      {
        type: "input",
        name: "redactionInput",
        message: "Enter directories to redact (comma-separated):",
      },
    ]);

    redactedProjects = redactionInput
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeRedactionPath(entry));
  }

  const fullRepoName = `${username}/${repoName}`;

  // Create repo
  const spinner = ora("Creating GitHub repository...").start();

  try {
    // Check if repo already exists
    try {
      execSync(`gh repo view ${fullRepoName}`, { stdio: "ignore" });
      spinner.info("Repository already exists");
    } catch {
      // Create new repo
      execSync(
        `gh repo create ${repoName} --public --description "My Claude Code stats"`,
        { stdio: "ignore" }
      );
      spinner.succeed("Created GitHub repository");
    }

    // Add topic
    spinner.start("Adding repository topic...");
    try {
      execSync(`gh repo edit ${fullRepoName} --add-topic clog-leaderboard`, {
        stdio: "ignore",
      });
      spinner.succeed("Added clog-leaderboard topic");
    } catch {
      spinner.warn("Could not add topic (may already exist)");
    }

    // Clone repo
    spinner.start("Cloning repository...");

    // Ensure parent directory exists
    const parentDir = path.dirname(repoPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Remove existing directory if it exists
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true });
    }

    execSync(`gh repo clone ${fullRepoName} "${repoPath}"`, {
      stdio: "ignore",
    });
    spinner.succeed("Cloned repository");

    // Create initial files
    spinner.start("Creating initial files...");
    const initialReadme = generateReadme(
      username,
      { totalSessions: 0, totalDurationMs: 0, totalTokens: 0, projectCount: 0 },
      [],
      []
    );
    writeReadme(repoPath, initialReadme);
    writeGitkeep(repoPath);
    spinner.succeed("Created initial files");

    // Initial commit
    spinner.start("Creating initial commit...");
    execSync('git add . && git commit -m "Initial commit" || true', {
      cwd: repoPath,
      stdio: "ignore",
    });
    execSync("git push || true", {
      cwd: repoPath,
      stdio: "ignore",
    });
    spinner.succeed("Pushed initial commit");

    // Save config
    writeConfig({
      username,
      repoName,
      repoPath,
      createdAt: new Date().toISOString(),
      redactedProjects,
    });

    console.log(chalk.green("\n✓ Initialization complete!"));
    console.log(chalk.dim(`  Config saved to ~/.claude/clog.json`));
    console.log(
      chalk.dim(`  Repository: https://github.com/${fullRepoName}\n`)
    );

    // Schedule prompt — offer automatic background syncing
    const savedConfig = readConfig();
    if (savedConfig && !savedConfig.schedule?.enabled) {
      const { wantsSchedule } = await inquirer.prompt<{ wantsSchedule: boolean }>([
        {
          type: "confirm",
          name: "wantsSchedule",
          message: "Would you like to automatically sync your stats in the background?",
          default: true,
        },
      ]);

      if (wantsSchedule) {
        const result = await promptAndInstallSchedule(savedConfig);
        if (!result) {
          console.log(
            chalk.yellow("Schedule setup failed — you can set it up later with: clog schedule\n")
          );
        }
      } else {
        console.log(chalk.dim("  Skipped. You can set up a schedule later with: clog schedule\n"));
      }
    } else if (savedConfig?.schedule?.enabled) {
      console.log(
        chalk.dim(`  Schedule already active (${savedConfig.schedule.frequency}). Skipping.\n`)
      );
    }

    // Run first sync (pushes data to GitHub)
    console.log(chalk.bold("Running first sync...\n"));
    await runSync();

    // Sync profile directly to Convex so it's immediately available
    const syncSpinner = ora("Syncing profile to leaderboard...").start();
    const data = generateOutputData(username, redactedProjects);
    const publicData = toPublicOutputData(data);

    // Calculate weekly stats
    const now = new Date();
    const day = now.getUTCDay();
    const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now);
    monday.setUTCDate(diff);
    const weekStart = monday.toISOString().split("T")[0];

    // Calculate weekly duration from activity data
    const startDate = new Date(weekStart + "T00:00:00Z");
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 7);

    let weeklyDurationMs = 0;
    let weeklySessionCount = 0;
    for (const [dateStr, dayData] of Object.entries(publicData.activity)) {
      const date = new Date(dateStr + "T00:00:00Z");
      if (date >= startDate && date < endDate) {
        weeklyDurationMs += dayData.durationMs;
        weeklySessionCount += dayData.sessions;
      }
    }

    // Calculate streak info from activity
    const activityDates = Object.keys(publicData.activity)
      .filter((d) => publicData.activity[d].sessions > 0)
      .sort();
    const lastActiveDate =
      activityDates.length > 0
        ? activityDates[activityDates.length - 1]
        : "";
    const currentStreak = data.currentStreak ?? 0;

    const avatarUrl = `https://github.com/${username}.png`;
    const repoUrl = `https://github.com/${fullRepoName}`;

    const synced = await syncProfileToConvex({
      username,
      avatarUrl,
      repoUrl,
      totalSessions: data.summary.totalSessions,
      totalDurationMs: data.summary.totalDurationMs,
      totalTokens: data.summary.totalTokens,
      projectCount: data.summary.projectCount,
      weeklyDurationMs,
      weeklySessionCount,
      weekStart,
      currentStreak,
      longestStreak: currentStreak,
      lastActiveDate,
      latestData: publicData,
    });

    if (synced) {
      syncSpinner.succeed("Profile synced to leaderboard");
    } else {
      syncSpinner.warn("Could not sync to leaderboard (will sync on next cron)");
    }

    // Brief wait for Convex mutation to commit before querying rank
    if (synced) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // Fetch leaderboard rank
    const rankData = await fetchUserRank(username);

    // Show celebration badge
    console.log("");
    console.log(
      renderBadge({
        username,
        rankData,
        localStats: {
          totalSessions: data.summary.totalSessions,
          totalDurationMs: data.summary.totalDurationMs,
          currentStreak,
        },
      })
    );

    // Offer to copy profile URL
    const profileUrl = `https://clog.sh/u/${username}?share=true`;
    const { copyUrl } = await inquirer.prompt<{ copyUrl: boolean }>([
      {
        type: "confirm",
        name: "copyUrl",
        message: "Copy profile URL to clipboard?",
        default: true,
      },
    ]);

    if (copyUrl) {
      const copied = copyToClipboard(profileUrl);
      if (copied) {
        console.log(chalk.green("✓ Copied to clipboard!"));
      } else {
        console.log(chalk.dim(`Share your profile: ${profileUrl}`));
      }
    }

    console.log("");
  } catch (error) {
    spinner.fail("Initialization failed");
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));
    process.exit(1);
  }
}
