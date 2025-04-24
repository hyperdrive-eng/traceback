import * as vscode from 'vscode';
import fetch from 'node-fetch';

export class OllamaService {
    private static instance: OllamaService;
    private baseUrl: string;
    private model: string = 'nomic-embed-text';
    private isModelPulled: boolean = false;

    private constructor() {
        this.baseUrl = vscode.workspace.getConfiguration('traceback').get<string>('ollamaEndpoint') || 'http://localhost:11434';
        
        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('traceback.ollamaEndpoint')) {
                this.baseUrl = vscode.workspace.getConfiguration('traceback').get<string>('ollamaEndpoint') || 'http://localhost:11434';
                // Reset model pulled status as we're connecting to a new endpoint
                this.isModelPulled = false;
            }
        });
    }

    public static getInstance(): OllamaService {
        if (!OllamaService.instance) {
            OllamaService.instance = new OllamaService();
        }
        return OllamaService.instance;
    }

    public async initialize(): Promise<void> {
        try {
            // Check if Ollama is running
            await this.checkOllamaStatus();
            
            // Pull the model if not already pulled
            if (!this.isModelPulled) {
                await this.pullModel();
            }
        } catch (error) {
            console.error('Failed to initialize Ollama:', error);
            throw new Error(`Failed to initialize Ollama at ${this.baseUrl}. Please ensure Ollama is running and accessible.`);
        }
    }

    private async checkOllamaStatus(): Promise<void> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            if (!response.ok) {
                throw new Error(`Failed to connect to Ollama: ${response.statusText}`);
            }
            const data = await response.json();
            const models = data.models || [];
            const hasRequiredModel = models.some((model: any) => model.name === this.model);
            console.log('Connected to Ollama successfully. Available models:', models.length);
            if (!hasRequiredModel) {
                console.log(`Required model ${this.model} not found, will attempt to pull it.`);
            }
        } catch (error) {
            console.error('Error checking Ollama status:', error);
            throw new Error(`Could not connect to Ollama at ${this.baseUrl}. Please ensure Ollama is running and then run "ollama pull ${this.model}" in your terminal.`);
        }
    }

    private async pullModel(): Promise<void> {
        try {
            console.log(`Pulling Ollama model: ${this.model}`);
            const response = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: this.model,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to pull model: ${response.statusText}`);
            }

            this.isModelPulled = true;
            console.log(`Successfully pulled model: ${this.model}`);
        } catch (error) {
            console.error('Error pulling Ollama model:', error);
            throw new Error(`Could not pull the required model (${this.model}). Please run "ollama pull ${this.model}" in your terminal.`);
        }
    }

    public async generateEmbedding(text: string): Promise<number[]> {
        try {
            const response = await fetch(`${this.baseUrl}/api/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    prompt: text,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to generate embedding: ${response.statusText}`);
            }

            const data = await response.json();
            return data.embedding;
        } catch (error) {
            console.error('Error generating embedding:', error);
            throw new Error(`Failed to generate embedding. Please ensure the ${this.model} model is available by running "ollama pull ${this.model}" in your terminal.`);
        }
    }

    public async isOllamaAvailable(): Promise<boolean> {
        try {
            await this.checkOllamaStatus();
            return true;
        } catch {
            return false;
        }
    }

    public getBaseUrl(): string {
        return this.baseUrl;
    }
} 