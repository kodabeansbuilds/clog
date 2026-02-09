import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import {
  configExists,
  readConfig,
  writeConfig,
  getClaudeDir,
} from "../utils/config.js";
import type { Config, ScheduleConfig } from "../types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const PLIST_LABEL = "sh.clog.sync";
const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`
);
const CRON_MARKER = "# clog-sync";
const LOCK_FILE = path.join(getClaudeDir(), "clog-sync.lock");
const DEFAULT_LOG_PATH = "~/.claude/clog-sync.log";
const STALE_LOCK_MS = 10 * 60 * 1000; // 10 minutes

/** Map of frequency label → times per day */
const FREQUENCY_MAP: Record<string, number> = {
  "1x": 1,
  "2x": 2,
  "3x": 3,
  "4x": 4,
  "6x": 6,
  "12x": 12,
};

/** Generate a cron expression that spaces syncs evenly across waking hours (8–22) */
function frequencyToCron(freq: string): string {
  const times = FREQUENCY_MAP[freq];
  if (!times) return freq; // treat as raw cron expression
  const interval = Math.floor(14 / times); // spread across 14 waking hours
  const hours: number[] = [];
  for (let i = 0; i < times; i++) {
    hours.push(8 + i * interval);
  }
  return `0 ${hours.join(",")} * * *`;
}

/** Resolve the absolute path to the `clog` binary */
function resolveBinPath(): string {
  try {
    const resolved = execSync("which clog", { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch {
    // fall through
  }
  // Fallback: use the node binary + this package's entry
  try {
    const npmGlobal = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const candidate = path.join(npmGlobal, "@jaobrown", "clog", "dist", "index.js");
    if (fs.existsSync(candidate)) {
      const nodeBin = process.execPath;
      return `${nodeBin} ${candidate}`;
    }
  } catch {
    // fall through
  }
  // Last resort: use npx (less reliable for cron)
  return "npx @jaobrown/clog";
}

/** Expand ~ to the home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Calculate the next sync time from a cron expression (simple heuristic) */
function getNextSyncTime(cronExpr: string): Date | null {
  // Parse minute and hour fields from a simple cron expression
  const parts = cronExpr.split(/\s+/);
  if (parts.length < 5) return null;

  const minute = parseInt(parts[0], 10);
  const hourField = parts[1];
  const hours = hourField.split(",").map((h) => parseInt(h, 10));

  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Find the next hour that's in the future
  for (const h of hours) {
    if (h > currentHour || (h === currentHour && minute > currentMinute)) {
      const next = new Date(now);
      next.setHours(h, minute, 0, 0);
      return next;
    }
  }

  // All times today have passed — next is tomorrow's first slot
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hours[0], minute, 0, 0);
  return tomorrow;
}

/** Format a Date to a human-friendly local string */
function formatTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Platform helpers ───────────────────────────────────────────────────────────

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

// ── macOS launchd ──────────────────────────────────────────────────────────────

function buildPlist(binPath: string, logPath: string, cronExpr: string): string {
  // Convert cron hours to launchd calendar intervals
  const parts = cronExpr.split(/\s+/);
  const minute = parseInt(parts[0], 10);
  const hours = parts[1].split(",").map((h) => parseInt(h, 10));

  const calendarEntries = hours
    .map(
      (h) =>
        `      <dict>
        <key>Hour</key>
        <integer>${h}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
      </dict>`
    )
    .join("\n");

  // Handle multi-word binPath (e.g. "node /path/to/index.js")
  const binParts = binPath.split(/\s+/);
  const programArgs = binParts
    .map((p) => `      <string>${p}</string>`)
    .concat("      <string>sync</string>")
    .join("\n");

  // Capture the current PATH so launchd can find node (nvm, fnm, volta, etc.)
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${currentPath}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${calendarEntries}
  </array>
  <key>StandardOutPath</key>
  <string>${expandPath(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${expandPath(logPath)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`;
}

function installLaunchd(binPath: string, logPath: string, cronExpr: string): void {
  // Unload existing if present
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // ignore
  }

  const plist = buildPlist(binPath, logPath, cronExpr);
  const dir = path.dirname(PLIST_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PLIST_PATH, plist);
  execSync(`launchctl load "${PLIST_PATH}"`);
}

function unloadLaunchd(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "ignore" });
  } catch {
    // ignore
  }
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
  }
}

function launchdIsLoaded(): boolean {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, {
      encoding: "utf-8",
    });
    return output.includes(PLIST_LABEL);
  } catch {
    return false;
  }
}

// ── Linux cron ─────────────────────────────────────────────────────────────────

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function installCron(binPath: string, logPath: string, cronExpr: string): void {
  const absLog = expandPath(logPath);
  const entry = `${cronExpr} ${binPath} sync >> ${absLog} 2>&1 ${CRON_MARKER}`;
  let crontab = getCurrentCrontab();

  // Remove existing clog entry
  crontab = crontab
    .split("\n")
    .filter((line) => !line.includes(CRON_MARKER))
    .join("\n")
    .trimEnd();

  crontab = crontab ? `${crontab}\n${entry}\n` : `${entry}\n`;
  execSync("crontab -", { input: crontab });
}

function removeCron(): void {
  let crontab = getCurrentCrontab();
  crontab = crontab
    .split("\n")
    .filter((line) => !line.includes(CRON_MARKER))
    .join("\n")
    .trimEnd();
  execSync("crontab -", { input: crontab ? `${crontab}\n` : "" });
}

function cronEntryExists(): boolean {
  return getCurrentCrontab().includes(CRON_MARKER);
}

// ── Shared install / uninstall ─────────────────────────────────────────────────

function installScheduler(binPath: string, logPath: string, cronExpr: string): void {
  if (isMacOS()) {
    installLaunchd(binPath, logPath, cronExpr);
  } else if (isLinux()) {
    installCron(binPath, logPath, cronExpr);
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function removeScheduler(): void {
  if (isMacOS()) {
    unloadLaunchd();
  } else if (isLinux()) {
    removeCron();
  }
}

function schedulerIsActive(): boolean {
  if (isMacOS()) return launchdIsLoaded();
  if (isLinux()) return cronEntryExists();
  return false;
}

// ── Lock file helpers ──────────────────────────────────────────────────────────

export function acquireLock(): boolean {
  // Clean up stale lock
  if (fs.existsSync(LOCK_FILE)) {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      fs.unlinkSync(LOCK_FILE);
    } else {
      return false; // another sync is running
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

// ── Subcommand handlers ────────────────────────────────────────────────────────

/** `clog schedule` — interactive setup */
export async function runSchedule(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red("Not initialized. Run: npx @jaobrown/clog init"));
    process.exit(1);
  }

  const config = readConfig();
  if (!config) {
    console.log(chalk.red("Could not read config. Run: npx @jaobrown/clog init"));
    process.exit(1);
  }

  // If schedule already exists, ask to update
  if (config.schedule?.enabled) {
    console.log(
      chalk.yellow(
        `\nSchedule already active (${config.schedule.frequency}, cron: ${config.schedule.cronExpr})`
      )
    );
    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "Update schedule", value: "update" },
          { name: "Keep current schedule", value: "keep" },
          { name: "Remove schedule", value: "remove" },
        ],
      },
    ]);

    if (action === "keep") return;
    if (action === "remove") {
      await runScheduleStop();
      return;
    }
    // fall through to update
  }

  console.log(chalk.bold("\n📅 Schedule automatic syncing\n"));

  const { frequency } = await inquirer.prompt<{ frequency: string }>([
    {
      type: "list",
      name: "frequency",
      message: "How often should clog sync?",
      default: "3x",
      choices: [
        { name: "1× per day", value: "1x" },
        { name: "2× per day", value: "2x" },
        { name: "3× per day (recommended)", value: "3x" },
        { name: "4× per day", value: "4x" },
        { name: "6× per day", value: "6x" },
        { name: "12× per day", value: "12x" },
        { name: "Custom cron expression", value: "custom" },
      ],
    },
  ]);

  let cronExpr: string;
  let freqLabel: string;

  if (frequency === "custom") {
    const { customCron } = await inquirer.prompt<{ customCron: string }>([
      {
        type: "input",
        name: "customCron",
        message: "Enter cron expression (e.g. 0 */4 * * *):",
        validate: (input: string) => {
          const parts = input.trim().split(/\s+/);
          return parts.length === 5 || "Must be a valid 5-field cron expression";
        },
      },
    ]);
    cronExpr = customCron.trim();
    freqLabel = "custom";
  } else {
    cronExpr = frequencyToCron(frequency);
    freqLabel = frequency;
  }

  const spinner = ora("Installing schedule...").start();

  try {
    const binPath = resolveBinPath();
    const logPath = DEFAULT_LOG_PATH;

    installScheduler(binPath, logPath, cronExpr);

    // Save schedule config
    const scheduleConfig: ScheduleConfig = {
      enabled: true,
      frequency: freqLabel,
      cronExpr,
      lastSync: config.schedule?.lastSync ?? null,
      logPath,
    };
    writeConfig({ ...config, schedule: scheduleConfig });

    spinner.succeed("Schedule installed");

    // Show summary
    const platform = isMacOS() ? "launchd" : "cron";
    console.log(chalk.dim(`\n  Scheduler: ${platform}`));
    console.log(chalk.dim(`  Frequency: ${freqLabel} (${cronExpr})`));
    console.log(chalk.dim(`  Log file:  ${logPath}`));

    if (isMacOS()) {
      console.log(chalk.dim(`  Plist:     ${PLIST_PATH}`));
    }

    const nextSync = getNextSyncTime(cronExpr);
    if (nextSync) {
      console.log(chalk.dim(`  Next sync: ${formatTime(nextSync)}`));
    }

    console.log(
      chalk.green("\n✓ Automatic syncing is now active. Syncs will run silently in the background.\n")
    );
  } catch (error) {
    spinner.fail("Failed to install schedule");
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));
    process.exit(1);
  }
}

/** `clog schedule status` */
export async function runScheduleStatus(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red("Not initialized. Run: npx @jaobrown/clog init"));
    process.exit(1);
  }

  const config = readConfig();
  const schedule = config?.schedule;

  console.log(chalk.bold("\n📅 Schedule Status\n"));

  if (!schedule) {
    console.log(chalk.yellow("  No schedule configured."));
    console.log(chalk.dim("  Run: clog schedule\n"));
    return;
  }

  const active = schedulerIsActive();
  const statusIcon = active ? chalk.green("●") : chalk.red("●");
  const statusText = active ? chalk.green("Active") : chalk.red("Inactive");

  console.log(`  Status:    ${statusIcon} ${statusText}`);
  console.log(`  Enabled:   ${schedule.enabled ? "Yes" : "No"}`);
  console.log(`  Frequency: ${schedule.frequency}`);
  console.log(`  Cron:      ${schedule.cronExpr}`);
  console.log(`  Log file:  ${schedule.logPath}`);

  if (schedule.lastSync) {
    const lastDate = new Date(schedule.lastSync);
    const ago = Date.now() - lastDate.getTime();
    const hoursAgo = Math.round(ago / (1000 * 60 * 60));
    console.log(
      `  Last sync: ${lastDate.toLocaleString()} (${hoursAgo}h ago)`
    );
  } else {
    console.log(`  Last sync: Never`);
  }

  const nextSync = getNextSyncTime(schedule.cronExpr);
  if (nextSync) {
    console.log(`  Next sync: ${formatTime(nextSync)}`);
  }

  console.log("");
}

/** `clog schedule stop` */
export async function runScheduleStop(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red("Not initialized. Run: npx @jaobrown/clog init"));
    process.exit(1);
  }

  const config = readConfig();
  if (!config?.schedule) {
    console.log(chalk.yellow("No schedule to stop."));
    return;
  }

  const spinner = ora("Stopping schedule...").start();

  try {
    removeScheduler();
    writeConfig({
      ...config,
      schedule: { ...config.schedule, enabled: false },
    });
    spinner.succeed("Schedule stopped");
    console.log(chalk.dim("  Run `clog schedule start` to re-enable.\n"));
  } catch (error) {
    spinner.fail("Failed to stop schedule");
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));
    process.exit(1);
  }
}

/** `clog schedule start` */
export async function runScheduleStart(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red("Not initialized. Run: npx @jaobrown/clog init"));
    process.exit(1);
  }

  const config = readConfig();
  if (!config?.schedule) {
    console.log(chalk.yellow("No schedule configured. Run: clog schedule"));
    return;
  }

  const spinner = ora("Starting schedule...").start();

  try {
    const binPath = resolveBinPath();
    installScheduler(binPath, config.schedule.logPath, config.schedule.cronExpr);
    writeConfig({
      ...config,
      schedule: { ...config.schedule, enabled: true },
    });
    spinner.succeed("Schedule started");

    const nextSync = getNextSyncTime(config.schedule.cronExpr);
    if (nextSync) {
      console.log(chalk.dim(`  Next sync: ${formatTime(nextSync)}\n`));
    }
  } catch (error) {
    spinner.fail("Failed to start schedule");
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));
    process.exit(1);
  }
}

/** `clog schedule update` */
export async function runScheduleUpdate(): Promise<void> {
  // Just re-run the interactive setup
  await runSchedule();
}

/** `clog schedule logs` */
export async function runScheduleLogs(): Promise<void> {
  if (!configExists()) {
    console.log(chalk.red("Not initialized. Run: npx @jaobrown/clog init"));
    process.exit(1);
  }

  const config = readConfig();
  const logPath = expandPath(config?.schedule?.logPath ?? DEFAULT_LOG_PATH);

  if (!fs.existsSync(logPath)) {
    console.log(chalk.yellow("\nNo sync logs yet."));
    console.log(chalk.dim(`  Log file: ${logPath}\n`));
    return;
  }

  console.log(chalk.bold("\n📋 Recent sync logs\n"));
  console.log(chalk.dim(`  ${logPath}\n`));

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    // Show last 50 lines
    const recent = lines.slice(-50);
    for (const line of recent) {
      console.log(`  ${line}`);
    }
    console.log("");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Failed to read logs: ${message}`));
  }
}

/**
 * Shared schedule setup for use in `clog init`.
 * Prompts for frequency, installs scheduler, saves config.
 * Returns true on success, false on failure (does not exit).
 */
export async function promptAndInstallSchedule(config: Config): Promise<boolean> {
  console.log(chalk.bold("\n📅 Schedule automatic syncing\n"));

  const { frequency } = await inquirer.prompt<{ frequency: string }>([
    {
      type: "list",
      name: "frequency",
      message: "How often should clog sync?",
      default: "3x",
      choices: [
        { name: "1× per day", value: "1x" },
        { name: "2× per day", value: "2x" },
        { name: "3× per day (recommended)", value: "3x" },
        { name: "4× per day", value: "4x" },
        { name: "6× per day", value: "6x" },
        { name: "12× per day", value: "12x" },
        { name: "Custom cron expression", value: "custom" },
      ],
    },
  ]);

  let cronExpr: string;
  let freqLabel: string;

  if (frequency === "custom") {
    const { customCron } = await inquirer.prompt<{ customCron: string }>([
      {
        type: "input",
        name: "customCron",
        message: "Enter cron expression (e.g. 0 */4 * * *):",
        validate: (input: string) => {
          const parts = input.trim().split(/\s+/);
          return parts.length === 5 || "Must be a valid 5-field cron expression";
        },
      },
    ]);
    cronExpr = customCron.trim();
    freqLabel = "custom";
  } else {
    cronExpr = frequencyToCron(frequency);
    freqLabel = frequency;
  }

  const spinner = ora("Installing schedule...").start();

  try {
    const binPath = resolveBinPath();
    const logPath = DEFAULT_LOG_PATH;

    installScheduler(binPath, logPath, cronExpr);

    const scheduleConfig: ScheduleConfig = {
      enabled: true,
      frequency: freqLabel,
      cronExpr,
      lastSync: config.schedule?.lastSync ?? null,
      logPath,
    };
    writeConfig({ ...config, schedule: scheduleConfig });

    spinner.succeed("Schedule installed");

    const platform = isMacOS() ? "launchd" : "cron";
    console.log(chalk.dim(`\n  Scheduler: ${platform}`));
    console.log(chalk.dim(`  Frequency: ${freqLabel} (${cronExpr})`));
    console.log(chalk.dim(`  Log file:  ${logPath}`));

    if (isMacOS()) {
      console.log(chalk.dim(`  Plist:     ${PLIST_PATH}`));
    }

    const nextSync = getNextSyncTime(cronExpr);
    if (nextSync) {
      console.log(chalk.dim(`  Next sync: ${formatTime(nextSync)}`));
    }

    console.log(
      chalk.green("\n✓ Automatic syncing is now active.\n")
    );
    return true;
  } catch (error) {
    spinner.fail("Failed to install schedule");
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));
    return false;
  }
}
