// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "vscode-integration" is active.');

	const disposable = vscode.commands.registerCommand('s.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from s!');
	});

	const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		new LlamaInlineCompletionProvider()
	);

	context.subscriptions.push(disposable, providerDisposable);
}

export function deactivate() {}

class LlamaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	public async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_inlineCompletionContext: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionList | undefined> {
		const config = vscode.workspace.getConfiguration('vscodeIntegration');
		const enabled = config.get<boolean>('enabled', true);
		if (!enabled) {
			return undefined;
		}

		const maxPromptChars = config.get<number>('maxPromptChars', 4000);
		const maxTokens = config.get<number>('maxTokens', 128);
		const temperature = config.get<number>('temperature', 0.2);
		const baseUrl = config.get<string>('llamaServerBaseUrl', 'http://127.0.0.1:9999');
		const path = config.get<string>('llamaServerPath', '/completion');
		const model = config.get<string>('model', '');

		const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		if (!prefix.trim()) {
			return undefined;
		}

		const prompt = prefix.slice(-Math.max(512, maxPromptChars));
		const body: Record<string, unknown> = {
			prompt,
			n_predict: maxTokens,
			max_tokens: maxTokens,
			temperature,
			stream: false
		};
		if (model.trim()) {
			body.model = model.trim();
		}

		try {
			const completionText = await requestCompletion(baseUrl, path, body, token);
			if (!completionText) {
				return undefined;
			}

			const item = new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position));
			return new vscode.InlineCompletionList([item]);
		} catch (error) {
			if (error instanceof Error && !token.isCancellationRequested) {
				console.error(`[vscode-integration] llama completion failed: ${error.message}`);
			}
			return undefined;
		}
	}
}

async function requestCompletion(
	baseUrl: string,
	path: string,
	body: Record<string, unknown>,
	token: vscode.CancellationToken
): Promise<string | undefined> {
	const endpoint = normalizeUrl(baseUrl, path);
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		signal: toAbortSignal(token)
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${endpoint}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	return extractCompletionText(data);
}

function extractCompletionText(data: Record<string, unknown>): string | undefined {
	const content = asNonEmptyString(data.content);
	if (content) {
		return content;
	}

	const completion = asNonEmptyString(data.completion);
	if (completion) {
		return completion;
	}

	const text = asNonEmptyString(data.text);
	if (text) {
		return text;
	}

	const choices = data.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		const first = choices[0] as Record<string, unknown>;
		const choiceText = asNonEmptyString(first.text);
		if (choiceText) {
			return choiceText;
		}
		const message = first.message as Record<string, unknown> | undefined;
		const messageContent = message ? asNonEmptyString(message.content) : undefined;
		if (messageContent) {
			return messageContent;
		}
	}

	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeUrl(baseUrl: string, path: string): string {
	const normalizedBase = baseUrl.replace(/\/+$/, '');
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return `${normalizedBase}${normalizedPath}`;
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}
