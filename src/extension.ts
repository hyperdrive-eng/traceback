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


  // Command to store Axiom API token securely
  const storeAxiomTokenCommand = vscode.commands.registerCommand(
    "traceback.storeAxiomToken",
    async (token: string) => {
      await context.secrets.store("axiom-token", token);
    }
  );
  
  // Command to set Ollama endpoint
  const setOllamaEndpointCommand = vscode.commands.registerCommand(
    "traceback.setOllamaEndpoint",
    async () => {
      const currentEndpoint = vscode.workspace.getConfiguration('traceback').get<string>('ollamaEndpoint') || 'http://localhost:11434';

      const endpoint = await vscode.window.showInputBox({
        prompt: "Enter Ollama API endpoint",
        placeHolder: "http://localhost:11434",
        value: currentEndpoint
      });

      if (endpoint) {
        await vscode.workspace.getConfiguration('traceback').update('ollamaEndpoint', endpoint, true);
        
        // Reset the LLM service instance to force recreation with the new endpoint
        const { LLMServiceFactory } = require('./llmService');
        LLMServiceFactory.resetServiceInstance();
        
        vscode.window.showInformationMessage(`Ollama endpoint set to: ${endpoint}`);
      }
    }
  );

  // Command to set Ollama model
  const setOllamaModelCommand = vscode.commands.registerCommand(
    "traceback.setOllamaModel",
    async () => {
      const currentModel = vscode.workspace.getConfiguration('traceback').get<string>('ollamaModel') || 'llama3';

      const model = await vscode.window.showInputBox({
        prompt: "Enter Ollama model name (must be available in your Ollama instance)",
        placeHolder: "llama3",
        value: currentModel
      });

      if (model) {
        await vscode.workspace.getConfiguration('traceback').update('ollamaModel', model, true);
        
        // Reset the LLM service instance to force recreation with the new model
        const { LLMServiceFactory } = require('./llmService');
        LLMServiceFactory.resetServiceInstance();
        
        vscode.window.showInformationMessage(`Ollama model set to: ${model}`);
      }
    }
  );
  
  // Command to set LLM provider
  const setLlmProviderCommand = vscode.commands.registerCommand(
    "traceback.setLlmProvider",
    async () => {
      const currentProvider = vscode.workspace.getConfiguration('traceback').get<string>('llmProvider') || 'claude';

      const options = [
        { label: 'Claude API', description: 'Use Claude API (requires API key)', target: 'claude' },
        { label: 'Ollama (Local)', description: 'Use local Ollama instance', target: 'ollama' }
      ];
      
      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select LLM provider'
      });

      if (selected) {
        await vscode.workspace.getConfiguration('traceback').update('llmProvider', selected.target, true);
        
        // Reset the LLM service instance to force recreation with the new provider
        const { LLMServiceFactory } = require('./llmService');
        LLMServiceFactory.resetServiceInstance();
        
        vscode.window.showInformationMessage(`LLM provider set to: ${selected.label}`);
        
        // If switching to Ollama, check if endpoint is set
        if (selected.target === 'ollama') {
          const endpoint = vscode.workspace.getConfiguration('traceback').get<string>('ollamaEndpoint');
          if (!endpoint) {
            vscode.commands.executeCommand('traceback.setOllamaEndpoint');
          }
        }
      }
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
    treeView,
    openSettingsCommand,
    refreshCommand,
    showLogsCommand,
    filterCommand,
    setLogPathCommand,
    setRepoPathCommand,
    resetLogPathCommand,
    clearExplorersCommand,
    loadAxiomTraceCommand,
    setAxiomDatasetCommand,
    storeAxiomTokenCommand,
    getAxiomTokenCommand,
    getAxiomDatasetCommand,
    registerLogParserCommand,
    openCallStackLocationCommand,
    setOllamaEndpointCommand,
    setOllamaModelCommand,
    setLlmProviderCommand
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
