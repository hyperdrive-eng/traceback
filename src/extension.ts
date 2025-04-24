import * as vscode from "vscode";
import { LogExplorerProvider, LogTreeItem } from "./logExplorer";
import { registerVariableExplorer } from "./variableExplorer";
import { VariableDecorator } from "./variableDecorator";
import { registerCallStackExplorer } from "./callStackExplorer";
import { ExtensibleLogParser, LogParser } from "./processor";
import { SettingsView } from "./settingsView";
import { LogEntry } from "./logExplorer";
import { VectorStore } from './vectorSearch';
import { CodeLocationsProvider, CodeLocationTreeItem } from './codeLocationsExplorer';
import * as path from 'path';
import { logLineDecorationType } from './decorations';

// Global registry for log parsers
export const logParserRegistry = new ExtensibleLogParser();

export async function activate(context: vscode.ExtensionContext) {
	console.log('Activating Traceback extension...');

	try {
		// Initialize vector store and start indexing as early as possible
		const vectorStore = VectorStore.getInstance();
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const repoPath = workspaceFolders[0].uri.fsPath;
			console.log('Starting workspace indexing for vector search...');
			// Start indexing but don't await it - let it run in background
			vectorStore.indexWorkspace(repoPath).catch(error => {
				console.error('Error during workspace indexing:', error);
				vscode.window.showErrorMessage('Failed to index workspace for code search. Some features may not work correctly.');
			});
		} else {
			console.log('No workspace folder found, skipping vector search indexing');
		}

		// Create other providers
		const logExplorerProvider = new LogExplorerProvider(context);
		const variableExplorerProvider = registerVariableExplorer(context);
		const callStackExplorerProvider = registerCallStackExplorer(context);
		const variableDecorator = new VariableDecorator(context);
		const codeLocationsProvider = new CodeLocationsProvider();

		// Register the tree view
		const treeView = vscode.window.createTreeView("logExplorer", {
			treeDataProvider: logExplorerProvider,
			showCollapseAll: false,
		});

		// Register other views
		vscode.window.registerTreeDataProvider('logVariableExplorer', variableExplorerProvider);
		vscode.window.registerTreeDataProvider('callStackExplorer', callStackExplorerProvider);
		vscode.window.registerTreeDataProvider('codeLocationsExplorer', codeLocationsProvider);

		// Connect providers
		logExplorerProvider.setVariableExplorer(variableExplorerProvider);
		logExplorerProvider.setCallStackExplorer(callStackExplorerProvider);
		logExplorerProvider.setCodeLocationsExplorer(codeLocationsProvider);
		codeLocationsProvider.setCallStackExplorer(callStackExplorerProvider);

		// Register commands
		const refreshCommand = vscode.commands.registerCommand("traceback.refreshLogs", () => {
			logExplorerProvider.refresh();
		});

		const showLogsCommand = vscode.commands.registerCommand("traceback.showLogs", () => {
			vscode.commands.executeCommand("workbench.view.extension.traceback");
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
					logExplorerProvider.refresh();
				}
			}
		);

		// Command to reset log file path
		const resetLogPathCommand = vscode.commands.registerCommand(
			"traceback.resetLogPath",
			async () => {
				await context.globalState.update("logFilePath", undefined);
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

					logExplorerProvider.refresh();
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

		// Command to set Ollama endpoint
		const setOllamaEndpointCommand = vscode.commands.registerCommand(
			"traceback.setOllamaEndpoint",
			async () => {
				const currentEndpoint = vscode.workspace.getConfiguration('traceback').get<string>('ollamaEndpoint') || 'http://localhost:11434';

				const newEndpoint = await vscode.window.showInputBox({
					prompt: "Enter Ollama API endpoint",
					placeHolder: "http://localhost:11434",
					value: currentEndpoint,
					validateInput: (value) => {
						try {
							new URL(value);
							return null;
						} catch {
							return "Please enter a valid URL";
						}
					}
				});

				if (newEndpoint) {
					await vscode.workspace.getConfiguration('traceback').update('ollamaEndpoint', newEndpoint, true);
					vscode.window.showInformationMessage(`Ollama endpoint set to: ${newEndpoint}`);
				}
			}
		);

		// Command to open code location
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
			vscode.commands.registerCommand('traceback.openCodeLocation', async (item: CodeLocationTreeItem) => {
				try {
					const repoPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
					if (!repoPath) {
						throw new Error('No workspace folder is open');
					}

					// Open the file
					const fullPath = path.join(repoPath, item.location.file);
					const document = await vscode.workspace.openTextDocument(fullPath);
					const editor = await vscode.window.showTextDocument(document);

					// Highlight the line
					const range = new vscode.Range(item.location.line, 0, item.location.line, 0);
					editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
					editor.setDecorations(logLineDecorationType, [new vscode.Range(item.location.line, 0, item.location.line, 999)]);

					// Trigger call stack analysis
					if (callStackExplorerProvider) {
						const potentialCallers = await callStackExplorerProvider.findPotentialCallers(
							fullPath,
							item.location.line
						);

						if (potentialCallers && potentialCallers.length > 0) {
							await callStackExplorerProvider.analyzeCallers(
								item.location.preview,
								item.location.preview,
								[],
								potentialCallers
							);
						}
					}
				} catch (error) {
					console.error('Error opening code location:', error);
					vscode.window.showErrorMessage(`Error opening code location: ${error}`);
				}
			})
		);

		// Initial refresh
		logExplorerProvider.refresh();

		console.log('Traceback extension activated successfully');
	} catch (error) {
		console.error('Error activating Traceback extension:', error);
		throw error;
	}
}

/**
 * The deactivate() function should stay in your extension, even if it's empty. This is because it's part of VS Code's extension API contract - VS Code expects to find both activate() and deactivate() functions exported from your main extension file.
 * All disposables (commands, tree view, status bar items) are properly managed through the context.subscriptions array in the activate() function, so VS Code will automatically clean those up. Therefore, having an empty deactivate() function is actually acceptable in this case.
 */
export function deactivate() {}
