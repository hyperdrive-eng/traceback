import * as vscode from "vscode";
import { LogExplorerProvider, LogTreeItem } from "./logExplorer";
import { registerVariableExplorer } from "./variableExplorer";
import { VariableDecorator } from "./variableDecorator";
import { registerCallStackExplorer } from "./callStackExplorer";
import { PinnedLogsProvider } from "./pinnedLogsProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log("Log Visualizer is now active");

  // Add status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = "log-visualizer.setLogPath";
  statusBarItem.tooltip = "Click to change log file path";
  
  // Add status bar item for Jaeger trace loading
  const jaegerStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  jaegerStatusBarItem.command = "log-visualizer.loadJaegerTrace";
  jaegerStatusBarItem.text = "$(globe) Load Jaeger Trace";
  jaegerStatusBarItem.tooltip = "Click to load a Jaeger trace from URL";
  jaegerStatusBarItem.show();
  
  // Add status bar item for Axiom trace loading
  const axiomStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  axiomStatusBarItem.command = "log-visualizer.loadAxiomTrace";
  axiomStatusBarItem.text = "$(server) Load Axiom Trace";
  axiomStatusBarItem.tooltip = "Click to load an Axiom trace by ID";
  axiomStatusBarItem.show();

  // Add a new status bar item for repo path
  const repoStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  repoStatusBarItem.command = "log-visualizer.setRepoPath";
  repoStatusBarItem.tooltip = "Click to change repository root path";

  // Update all status bars
  const updateStatusBars = () => {
    const currentLogPath = context.globalState.get<string>("logFilePath");
    const currentRepoPath = context.globalState.get<string>("repoPath");
    const currentJaegerTraceId = context.globalState.get<string>("jaegerTraceId");
    const currentAxiomTraceId = context.globalState.get<string>("axiomTraceId");
    const currentJaegerEndpoint = context.globalState.get<string>("jaegerEndpoint") || "http://localhost:8080/jaeger/ui/api/traces";

    statusBarItem.text = `$(file) Log: ${currentLogPath || "Not Set"}`;
    repoStatusBarItem.text = `$(repo) Repo: ${currentRepoPath || "Not Set"}`;
    
    // Update Jaeger status bar
    if (currentJaegerTraceId) {
      jaegerStatusBarItem.text = `$(globe) Jaeger: ${currentJaegerTraceId}`;
    } else {
      jaegerStatusBarItem.text = `$(globe) Load Jaeger Trace`;
    }
    
    // Update Axiom status bar
    if (currentAxiomTraceId) {
      axiomStatusBarItem.text = `$(server) Axiom: ${currentAxiomTraceId}`;
    } else {
      axiomStatusBarItem.text = `$(server) Load Axiom Trace`;
    }

    statusBarItem.show();
    repoStatusBarItem.show();
    jaegerStatusBarItem.show();
    axiomStatusBarItem.show();
  };

  updateStatusBars();

  // Create the LogExplorerProvider instance
  const logExplorerProvider = new LogExplorerProvider(context);

  // Register the tree view
  const treeView = vscode.window.createTreeView("logExplorer", {
    treeDataProvider: logExplorerProvider,
    showCollapseAll: false,
  });
  
  // Create the variable decorator
  const variableDecorator = new VariableDecorator(context);
  
  // Register the Variables view
  const variableExplorerProvider = registerVariableExplorer(context);
  
  // Register the Call Stack view
  const callStackExplorerProvider = registerCallStackExplorer(context);
  
  // Connect the Variables view with the decorator
  variableExplorerProvider.setVariableDecorator(variableDecorator);
  
  // Associate the Variables and Call Stack views with the Logs view
  logExplorerProvider.setVariableExplorer(variableExplorerProvider);
  logExplorerProvider.setCallStackExplorer(callStackExplorerProvider);

  // Register commands
  const refreshCommand = vscode.commands.registerCommand("log-visualizer.refreshLogs", () => {
    logExplorerProvider.refresh();
  });

  const showLogsCommand = vscode.commands.registerCommand("log-visualizer.showLogs", () => {
    vscode.commands.executeCommand("workbench.view.extension.log-explorer");
    updateStatusBars();
    logExplorerProvider.refresh();
  });

  const filterCommand = vscode.commands.registerCommand("log-visualizer.filterLogs", () => {
    logExplorerProvider.selectLogLevels();
  });

  // Command to set log file path
  const setLogPathCommand = vscode.commands.registerCommand(
    "log-visualizer.setLogPath",
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
    "log-visualizer.setRepoPath",
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
    "log-visualizer.resetLogPath",
    async () => {
      await context.globalState.update("logFilePath", undefined);
      await context.globalState.update("jaegerTraceId", undefined); // Also clear Jaeger trace ID
      updateStatusBars(); // Update all status bars
      logExplorerProvider.refresh();
    }
  );

  // Command to clear the views
  const clearExplorersCommand = vscode.commands.registerCommand(
    "log-visualizer.clearExplorers",
    () => {
      variableExplorerProvider.setLog(undefined);
      callStackExplorerProvider.setLogEntry(undefined);
    }
  );
  
  // Command to load a Jaeger trace from a URL
  const loadJaegerTraceCommand = vscode.commands.registerCommand(
    "log-visualizer.loadJaegerTrace",
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
    "log-visualizer.setJaegerEndpoint",
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

  // Register pin/unpin commands
  const pinnedLogsProvider = new PinnedLogsProvider(context);
  vscode.window.registerTreeDataProvider('pinnedLogs', pinnedLogsProvider);
  logExplorerProvider.setPinnedLogsProvider(pinnedLogsProvider);

  // Command to store Axiom API token securely
  const storeAxiomTokenCommand = vscode.commands.registerCommand(
    "log-visualizer.storeAxiomToken",
    async (token: string) => {
      await context.secrets.store("axiom-token", token);
    }
  );
  
  // Command to get stored Axiom API token
  const getAxiomTokenCommand = vscode.commands.registerCommand(
    "log-visualizer.getAxiomToken",
    async () => {
      return context.secrets.get("axiom-token");
    }
  );
  
  // Command to get Axiom dataset name
  const getAxiomDatasetCommand = vscode.commands.registerCommand(
    "log-visualizer.getAxiomDataset",
    () => {
      return context.globalState.get<string>("axiomDataset") || "otel-demo-traces";
    }
  );
  
  // Command to load an Axiom trace
  const loadAxiomTraceCommand = vscode.commands.registerCommand(
    "log-visualizer.loadAxiomTrace",
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
    "log-visualizer.setAxiomDataset",
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

  context.subscriptions.push(
    treeView,
    refreshCommand,
    showLogsCommand,
    filterCommand,
    setLogPathCommand,
    setRepoPathCommand,
    resetLogPathCommand,
    clearExplorersCommand,
    loadJaegerTraceCommand,
    setJaegerEndpointCommand,
    loadAxiomTraceCommand,
    setAxiomDatasetCommand,
    storeAxiomTokenCommand,
    getAxiomTokenCommand,
    getAxiomDatasetCommand,
    statusBarItem,
    jaegerStatusBarItem,
    axiomStatusBarItem,
    repoStatusBarItem,
    vscode.commands.registerCommand('log-visualizer.pinLog', (item: LogTreeItem) => {
      const log = item.getLogEntry();
      pinnedLogsProvider.pinLog(log);
      logExplorerProvider.refresh();
      pinnedLogsProvider.refresh();
    }),
    vscode.commands.registerCommand('log-visualizer.unpinLog', (item: LogTreeItem) => {
      const log = item.getLogEntry();
      pinnedLogsProvider.unpinLog(log);
      logExplorerProvider.refresh();
      pinnedLogsProvider.refresh();
    }),
    vscode.commands.registerCommand('log-visualizer.clearPins', () => {
      pinnedLogsProvider.clearPins();
      logExplorerProvider.refresh();
      pinnedLogsProvider.refresh();
    })
  );
}

/**
 * The deactivate() function should stay in your extension, even if it's empty. This is because it's part of VS Code's extension API contract - VS Code expects to find both activate() and deactivate() functions exported from your main extension file.
 * All disposables (commands, tree view, status bar items) are properly managed through the context.subscriptions array in the activate() function, so VS Code will automatically clean those up. Therefore, having an empty deactivate() function is actually acceptable in this case.
 */
export function deactivate() {}
