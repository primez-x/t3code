import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (
  launchArgs?: string,
  delegationMode: "native-preferred" | "t3-managed" = "native-preferred",
): ReadonlyArray<string> => {
  const args = tokenizeCliArgs(launchArgs);
  if (delegationMode === "native-preferred") return args;
  const managedArgs: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    const inline = arg.startsWith("--enable=");
    const value = inline
      ? arg.slice("--enable=".length)
      : arg === "--enable"
        ? args[index + 1]
        : undefined;
    // Codex applies feature toggles after config overrides, regardless of argv order.
    if (value === "multi_agent" || value === "multi_agent_v2") {
      if (!inline) index++;
      continue;
    }
    managedArgs.push(arg);
  }
  return managedArgs;
};

export const codexAppServerArgs = (
  launchArgs?: string,
  delegationMode: "native-preferred" | "t3-managed" = "native-preferred",
) => [
  "app-server",
  ...codexLaunchArgv(launchArgs, delegationMode),
  ...(delegationMode === "t3-managed"
    ? ["-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"]
    : []),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
