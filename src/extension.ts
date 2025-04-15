import * as vscode from "vscode";
import { LogExplorerProvider, LogTreeItem } from "./logExplorer";
import { registerVariableExplorer } from "./variableExplorer";
import { VariableDecorator } from "./variableDecorator";
import { registerCallStackExplorer } from "./callStackExplorer";
import { ExtensibleLogParser, LogParser } from "./processor";
import { SettingsView } from "./settingsView";
import { LogEntry } from "./logExplorer";

// Global registry for log parsers
export const logParserRegistry = new ExtensibleLogParser();

export function activate(context: vscode.ExtensionContext) {
  console.log("TraceBack is now active");
  
  const updateStatusBars = () => {};

  // Create other providers
  const logExplorerProvider = new LogExplorerProvider(context);
  const variableExplorerProvider = registerVariableExplorer(context);
  const callStackExplorerProvider = registerCallStackExplorer(context);
  const variableDecorator = new VariableDecorator(context);

  // Register the tree view
  const logExplorerTreeView = vscode.window.createTreeView("logExplorer", {
    treeDataProvider: logExplorerProvider,
    showCollapseAll: false,
  });

  // Connect providers
  variableExplorerProvider.setVariableDecorator(variableDecorator);
  logExplorerProvider.setVariableExplorer(variableExplorerProvider);
  logExplorerProvider.setCallStackExplorer(callStackExplorerProvider);

  // Create the tree view
  const treeView = vscode.window.createTreeView("logExplorer", {
    treeDataProvider: logExplorerProvider,
    showCollapseAll: false,
  });

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
      await context.globalState.update("jaegerTraceId", undefined); // Also clear Jaeger trace ID
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

  // Command to load a Jaeger trace from a URL
  const loadJaegerTraceCommand = vscode.commands.registerCommand(
    "traceback.loadJaegerTrace",
    async () => {
      // First, ask for Jaeger endpoint if not set
      let jaegerEndpoint = context.globalState.get<string>("jaegerEndpoint");

      if (!jaegerEndpoint) {
        jaegerEndpoint = await vscode.window.showInputBox({
          prompt: "Enter Jaeger API endpoint (leave empty for default)",
          placeHolder: "http://localhost:8080/jaeger/ui/api/traces",
          value: "http://localhost:8080/jaeger/ui/api/traces"
        });

        if (!jaegerEndpoint) {
          // User canceled or provided empty input, use default
          jaegerEndpoint = "http://localhost:8080/jaeger/ui/api/traces";
        }

        await context.globalState.update("jaegerEndpoint", jaegerEndpoint);
      }

      // Now ask for the trace ID
      const traceId = await vscode.window.showInputBox({
        prompt: "Enter Jaeger trace ID",
        placeHolder: "f5c6e9a0a31dd1ed034ba48c41fe4119",
        validateInput: (value) => {
          // Simple validation for non-empty input
          return value.trim() ? null : "Trace ID cannot be empty";
        }
      });

      if (!traceId) {
        // User canceled
        return;
      }

      // Construct the full URL
      const fullUrl = `${jaegerEndpoint}/${traceId}`;

      // Store the trace ID
      await context.globalState.update("jaegerTraceId", traceId);
      await context.globalState.update("logFilePath", fullUrl);

      // Update status bars and refresh logs
      updateStatusBars();
      logExplorerProvider.refresh();

      // Show information message
      vscode.window.showInformationMessage(`Loading Jaeger trace: ${traceId}`);
    }
  );

  // Command to change Jaeger endpoint
  const setJaegerEndpointCommand = vscode.commands.registerCommand(
    "traceback.setJaegerEndpoint",
    async () => {
      const currentEndpoint = context.globalState.get<string>("jaegerEndpoint") || "http://localhost:8080/jaeger/ui/api/traces";

      const newEndpoint = await vscode.window.showInputBox({
        prompt: "Enter Jaeger API endpoint",
        placeHolder: "http://localhost:8080/jaeger/ui/api/traces",
        value: currentEndpoint
      });

      if (newEndpoint) {
        await context.globalState.update("jaegerEndpoint", newEndpoint);
        vscode.window.showInformationMessage(`Jaeger endpoint set to: ${newEndpoint}`);

        // If there's a trace ID loaded, refresh with the new endpoint
        const currentTraceId = context.globalState.get<string>("jaegerTraceId");
        if (currentTraceId) {
          const fullUrl = `${newEndpoint}/${currentTraceId}`;
          await context.globalState.update("logFilePath", fullUrl);
          logExplorerProvider.refresh();
        }

        updateStatusBars();
      }
    }
  );

  // Command to store Axiom API token securely
  const storeAxiomTokenCommand = vscode.commands.registerCommand(
    "traceback.storeAxiomToken",
    async (token: string) => {
      await context.secrets.store("axiom-token", token);
    }
  );

  // Command to get stored Axiom API token
  const getAxiomTokenCommand = vscode.commands.registerCommand(
    "traceback.getAxiomToken",
    async () => {
      return context.secrets.get("axiom-token");
    }
  );

  // Command to get Axiom dataset name
  const getAxiomDatasetCommand = vscode.commands.registerCommand(
    "traceback.getAxiomDataset",
    () => {
      return context.globalState.get<string>("axiomDataset") || "otel-demo-traces";
    }
  );

  // Command to load an Axiom trace
  const loadAxiomTraceCommand = vscode.commands.registerCommand(
    "traceback.loadAxiomTrace",
    async () => {
      // Ask for the trace ID
      const traceId = await vscode.window.showInputBox({
        prompt: "Enter Axiom trace ID",
        placeHolder: "5bb959fd715610b1f395edcc344aba6b",
        validateInput: (value) => {
          // Simple validation for non-empty input
          return value.trim() ? null : "Trace ID cannot be empty";
        }
      });

      if (!traceId) {
        // User canceled
        return;
      }

      // Store the trace ID
      await context.globalState.update("axiomTraceId", traceId);
      await context.globalState.update("logFilePath", `axiom:${traceId}`);

      // Update status bars and refresh logs
      updateStatusBars();
      logExplorerProvider.refresh();

      // Show information message
      vscode.window.showInformationMessage(`Loading Axiom trace: ${traceId}`);
    }
  );

  // Command to set Axiom dataset name
  const setAxiomDatasetCommand = vscode.commands.registerCommand(
    "traceback.setAxiomDataset",
    async () => {
      const currentDataset = context.globalState.get<string>("axiomDataset") || "otel-demo-traces";

      const newDataset = await vscode.window.showInputBox({
        prompt: "Enter Axiom dataset name for traces",
        placeHolder: "otel-demo-traces",
        value: currentDataset
      });

      if (newDataset) {
        await context.globalState.update("axiomDataset", newDataset);
        vscode.window.showInformationMessage(`Axiom dataset set to: ${newDataset}`);

        // If there's a trace ID loaded, refresh with the new dataset
        const currentTraceId = context.globalState.get<string>("axiomTraceId");
        if (currentTraceId) {
          await context.globalState.update("logFilePath", `axiom:${currentTraceId}`);
          logExplorerProvider.refresh();
        }

        updateStatusBars();
      }
    }
  );
  
  // Command to register a custom log parser extension
  const registerLogParserCommand = vscode.commands.registerCommand(
    "traceback.registerLogParser",
    (parser: LogParser) => {
      if (!parser || typeof parser.canParse !== 'function' || typeof parser.parse !== 'function') {
        console.error('Invalid log parser provided. Parser must implement LogParser interface.');
        return false;
      }
      
      try {
        logParserRegistry.registerParser(parser);
        console.log('Custom log parser registered successfully');
        return true;
      } catch (error) {
        console.error('Failed to register log parser:', error);
        return false;
      }
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

  context.subscriptions.push(
    logExplorerTreeView,
    openSettingsCommand,
    refreshCommand,
    filterCommand,
    setRepoPathCommand,
    clearExplorersCommand,
    loadJaegerTraceCommand,
    setJaegerEndpointCommand,
    loadAxiomTraceCommand,
    setAxiomDatasetCommand
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
