import * as vscode from "vscode";
import { LogExplorerProvider } from "./logExplorer";
import { registerVariableExplorer } from "./variableExplorer";
import { VariableDecorator } from "./variableDecorator";
import { registerCallStackExplorer } from "./callStackExplorer";
import { SpanVisualizerPanel } from "./spanVisualizerPanel";
import { SettingsView } from "./settingsView";

export function activate(context: vscode.ExtensionContext) {
  console.log("TraceBack is now active");

  const updateStatusBars = () => {};

  // Create other providers
  const logExplorerProvider = new LogExplorerProvider(context);
  const variableExplorerProvider = registerVariableExplorer(context);
  const callStackExplorerProvider = registerCallStackExplorer(context);
  const variableDecorator = new VariableDecorator(context);

  // Register the tree view
  const treeView = vscode.window.createTreeView("logExplorer", {
    treeDataProvider: logExplorerProvider,
    showCollapseAll: false,
  });

  // Connect providers
  variableExplorerProvider.setVariableDecorator(variableDecorator);
  logExplorerProvider.setVariableExplorer(variableExplorerProvider);
  logExplorerProvider.setCallStackExplorer(callStackExplorerProvider);

  // Register commands
  const refreshCommand = vscode.commands.registerCommand("traceback.refreshLogs", () => {
    logExplorerProvider.refresh();
  });

  const showLogsCommand = vscode.commands.registerCommand("traceback.showLogs", () => {
    vscode.commands.executeCommand("workbench.view.extension.traceback");
    updateStatusBars();
    logExplorerProvider.refresh();
  });

  const filterCommand = vscode.commands.registerCommand("traceback.filterLogs", () => {
    logExplorerProvider.selectLogLevels();
  });

  // Command to set log file path
  const setLogPathCommand = vscode.commands.registerCommand(
    "traceback.setLogPath",
    async () => {
      // Use file picker instead of input box
      const options: vscode.OpenDialogOptions = {
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Select Log File",
        filters: {
          "Log Files": ["log", "json"],
          "All Files": ["*"],
        },
      };

      const fileUri = await vscode.window.showOpenDialog(options);
      if (fileUri && fileUri[0]) {
        const logPath = fileUri[0].fsPath;
        await context.globalState.update("logFilePath", logPath);
        updateStatusBars();
        logExplorerProvider.refresh();
      }
    }
  );

  // Command to set repository path
  const setRepoPathCommand = vscode.commands.registerCommand(
    "traceback.setRepoPath",
    async () => {
      const options: vscode.OpenDialogOptions = {
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select Repository Root",
        title: "Select Repository Root Directory",
      };

      const fileUri = await vscode.window.showOpenDialog(options);
      if (fileUri && fileUri[0]) {
        const repoPath = fileUri[0].fsPath;
        await context.globalState.update("repoPath", repoPath);

        // Open the selected folder in VS Code
        await vscode.commands.executeCommand("vscode.openFolder", fileUri[0], {
          forceNewWindow: false, // Set to true if you want to open in a new window
        });

        // Show confirmation message
        vscode.window.showInformationMessage(`Repository path set to: ${repoPath}`);
        updateStatusBars(); // Update status bars
        logExplorerProvider.refresh();
      }
    }
  );

  // Command to reset log file path
  const resetLogPathCommand = vscode.commands.registerCommand(
    "traceback.resetLogPath",
    async () => {
      await context.globalState.update("logFilePath", undefined);
      updateStatusBars(); // Update all status bars
      logExplorerProvider.refresh();
    }
  );

  // Command to clear the views
  const clearExplorersCommand = vscode.commands.registerCommand(
    "traceback.clearExplorers",
    () => {
      variableExplorerProvider.setLog(undefined);
      callStackExplorerProvider.setLogEntry(undefined);
    }
  );

  // Register settings command
  const openSettingsCommand = vscode.commands.registerCommand(
    "traceback.openSettings",
    () => {
      SettingsView.createOrShow(context);
    }
  );

  const openCallStackLocationCommand = vscode.commands.registerCommand(
    'traceback.openCallStackLocation',
    (caller, treeItem) => {
      callStackExplorerProvider.openCallStackLocation(caller, treeItem);
    }
  );

  // Add new command to show span visualizer
  const showSpanVisualizerCommand = vscode.commands.registerCommand(
    "traceback.showSpanVisualizer",
    () => {
      // Get the current logs from the LogExplorerProvider
      const logs = logExplorerProvider.getLogs();
      SpanVisualizerPanel.createOrShow(context, logs);
    }
  );

  context.subscriptions.push(
    treeView,
    openSettingsCommand,
    refreshCommand,
    showLogsCommand,
    filterCommand,
    setLogPathCommand,
    setRepoPathCommand,
    resetLogPathCommand,
    clearExplorersCommand,
    openCallStackLocationCommand,
    showSpanVisualizerCommand
  );

  // Initial refresh
  updateStatusBars();
  logExplorerProvider.refresh();
}

/**
 * The deactivate() function should stay in your extension, even if it's empty. This is because it's part of VS Code's extension API contract - VS Code expects to find both activate() and deactivate() functions exported from your main extension file.
 * All disposables (commands, tree view, status bar items) are properly managed through the context.subscriptions array in the activate() function, so VS Code will automatically clean those up. Therefore, having an empty deactivate() function is actually acceptable in this case.
 */
export function deactivate() {}
